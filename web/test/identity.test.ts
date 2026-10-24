import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeMembers,
  decodeNameStatus,
  decodeOptionBytes,
  decodeProfile,
  decodeTrustLevel,
  FIELD_LABELS,
} from "../src/chain/identity.ts";
import { publicCommitment } from "../src/chain/formulas.ts";

// Fixtures are the raw JSON of the runtime API answers of a `--dev` node (spec_version 5), made
// by creating the identities below with real transactions: see web/test/fixtures/README.txt.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
const EVE = "idnnuZEwh4Dv3QfxF6oS2zMD881G1KvXWXaWgYeBUAusWkd64";

describe("decodeProfile", () => {
  const profile = decodeProfile(USER, fixture("profile-user.json"));

  it("reads the header: name, trust level, bio, dates", () => {
    expect(profile.address).toBe(USER);
    expect(profile.name).toBe("fixtureuser");
    expect(profile.trust).toBe("PartiallyVerified");
    expect(profile.bio).toBe("Fixture bio, on chain.");
    expect(profile.createdAt).toBe(2);
    expect(profile.updatedAt).toBe(6);
  });

  it("reads the on-chain avatar as WebP bytes", () => {
    const avatar = profile.avatar!;
    expect(avatar.length).toBe(458);
    expect(new TextDecoder().decode(avatar.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(avatar.slice(8, 12))).toBe("WEBP");
  });

  it("lists typed fields in the chain's order, then custom ones", () => {
    expect(profile.fields.map((f) => f.label)).toEqual(["Display name", "Email", "Telegram", "PGP", "mastodon"]);
    expect(profile.fields.map((f) => f.id)).toEqual([
      "typed:DisplayName",
      "typed:Email",
      "typed:Telegram",
      "typed:Pgp",
      "custom:mastodon",
    ]);
  });

  it("gives the text of a public field and its commitment", () => {
    const email = profile.fields.find((f) => f.id === "typed:Email")!;
    expect(email).toMatchObject({ privacy: "public", value: "user@example.org" });
    expect(email.commitment).toBe(publicCommitment("user@example.org"));
    const custom = profile.fields.find((f) => f.id === "custom:mastodon")!;
    expect(custom).toMatchObject({ privacy: "public", value: "@user@m.example", ref: { custom: "mastodon" } });
  });

  it("shows a PGP fingerprint as capital hex, never as text", () => {
    const pgp = profile.fields.find((f) => f.id === "typed:Pgp")!;
    expect(pgp.value).toBe("AB".repeat(20));
    expect(pgp.bytes).toEqual(new Uint8Array(20).fill(0xab));
  });

  it("keeps a private field's value out: only its commitment is known", () => {
    const telegram = profile.fields.find((f) => f.id === "typed:Telegram")!;
    expect(telegram).toMatchObject({ privacy: "private", value: null, bytes: null });
    expect(telegram.commitment).toBe(`0x${"22".repeat(32)}`);
  });

  it("marks verified only what a valid attestation covers", () => {
    const verified = profile.fields.filter((f) => f.verified).map((f) => f.id);
    expect(verified).toEqual(["typed:Email"]);
    expect(profile.fields.some((f) => f.rejected)).toBe(false);
  });

  it("reads links with their ids", () => {
    expect(profile.links).toEqual([
      { id: 0, title: "Website", url: "https://user.example", verified: false, rejected: false },
      { id: 1, title: "Code", url: "https://git.example/user", verified: false, rejected: false },
    ]);
  });

  it("reads attestations and facts with their validity", () => {
    expect(profile.attestations).toHaveLength(1);
    expect(profile.attestations[0]).toMatchObject({
      ref: { typed: "Email" },
      authority: 0,
      verdict: "Verified",
      method: "EmailCode",
      issuedAt: 8,
      expiresAt: null,
      revoked: null,
      valid: true,
    });
    expect(profile.facts).toEqual([
      {
        kind: "DocumentChecked",
        authority: 0,
        issuedAt: 9,
        expiresAt: null,
        reason: "Unspecified",
        note: "passport seen",
        revoked: null,
        active: true,
      },
    ]);
  });

  it("reads the parent it belongs to", () => {
    expect(profile.parent).toEqual({ address: PARENT, label: "main laptop" });
    expect(profile.subs).toEqual([]);
    expect(profile.imported).toBeNull();
  });

  it("reads the accepted sub-accounts of a parent, not its proposals", () => {
    const parent = decodeProfile(PARENT, fixture("profile-parent.json"));
    expect(parent.subs).toEqual([{ address: USER, label: "main laptop" }]);
    expect(parent.parent).toBeNull();
    expect(parent.bio).toBe("I am a parent");
    expect(parent.fields).toEqual([]);
    expect(parent.avatar).toBeNull();
    expect(parent.trust).toBe("Declared");
  });

  it("reads a fully verified identity", () => {
    const eve = decodeProfile(EVE, fixture("profile-eve.json"));
    expect(eve.trust).toBe("FullyVerified");
    expect(eve.fields.map((f) => [f.id, f.verified])).toEqual([["typed:Email", true]]);
    expect(eve.attestations[0]!.method).toBe("Manual");
  });
});

describe("decodeProfile, provenance and attestation corner cases", () => {
  const base = fixture("profile-eve.json") as Record<string, any>;
  const withChanges = (changes: Record<string, unknown>) => decodeProfile(EVE, { ...base, ...changes });

  it("reads a migrated identity and the registrar behind a migrated attestation", () => {
    const profile = withChanges({
      imported: { source: "Polkadot", block: 123, blockHash: `0x${"ab".repeat(32)}`, judgements: [[5, "KnownGood"], [1, "Reasonable"]] },
      attestations: [
        [
          { typed: "Email" },
          0,
          {
            commitment: base.attestations[0][2].commitment,
            verdict: "Verified",
            method: { migratedFromPeopleChain: { source: "Polkadot", registrar: 5, block: 123 } },
            issuedAt: 20,
            expiresAt: 999,
            revoked: null,
          },
          true,
        ],
      ],
    });
    expect(profile.imported).toEqual({
      source: "Polkadot",
      block: 123,
      blockHash: `0x${"ab".repeat(32)}`,
      judgements: [
        { registrar: 5, judgement: "KnownGood" },
        { registrar: 1, judgement: "Reasonable" },
      ],
    });
    expect(profile.attestations[0]).toMatchObject({ method: "MigratedFromPeopleChain", expiresAt: 999 });
    expect(profile.attestations[0]!.migrated).toEqual({ source: "Polkadot", registrar: 5, block: 123 });
  });

  it("does not call a field verified when the chain says the attestation is not valid now", () => {
    const attestation = structuredClone(base.attestations[0]);
    attestation[3] = false;
    expect(withChanges({ attestations: [attestation] }).fields[0]!.verified).toBe(false);
  });

  it("does not call a field verified for a rejection, and reports it", () => {
    const attestation = structuredClone(base.attestations[0]);
    attestation[2].verdict = "Rejected";
    const profile = withChanges({ attestations: [attestation] });
    expect(profile.fields[0]).toMatchObject({ verified: false, rejected: true });
  });

  it("lets one valid rejection take a field out of verified, whoever else verified it", () => {
    const verified = structuredClone(base.attestations[0]);
    const rejected = structuredClone(base.attestations[0]);
    rejected[1] = 1;
    rejected[2].verdict = "Rejected";
    const profile = withChanges({ attestations: [verified, rejected] });
    expect(profile.fields[0]).toMatchObject({ verified: false, rejected: true });
  });

  it("does not call a field verified for a revoked attestation", () => {
    const attestation = structuredClone(base.attestations[0]);
    attestation[2].revoked = [30, "ValueMismatch"];
    attestation[3] = false;
    const profile = withChanges({ attestations: [attestation] });
    expect(profile.fields[0]).toMatchObject({ verified: false, rejected: false });
    expect(profile.attestations[0]!.revoked).toEqual({ block: 30, reason: "ValueMismatch" });
  });

  it("marks a verified link", () => {
    const user = fixture("profile-user.json") as Record<string, any>;
    const profile = decodeProfile(USER, {
      ...user,
      attestations: [[{ link: 1 }, 0, { ...user.attestations[0][2] }, true]],
    });
    expect(profile.links.map((l) => [l.id, l.verified])).toEqual([[0, false], [1, true]]);
    expect(profile.fields.every((f) => !f.verified)).toBe(true);
  });

  it("refuses an answer it does not understand rather than showing a wrong profile", () => {
    expect(() => decodeProfile(EVE, { ...base, trustLevel: "Gold" })).toThrow(/trust level/i);
    expect(() => decodeProfile(EVE, { ...base, identity: null })).toThrow();
  });
});

describe("decodeTrustLevel", () => {
  it("accepts the five levels and null for no identity", () => {
    for (const level of ["Fraudulent", "Declared", "PartiallyVerified", "FullyVerified", "Certified"]) {
      expect(decodeTrustLevel(level)).toBe(level);
    }
    expect(decodeTrustLevel(null)).toBeNull();
    expect(() => decodeTrustLevel("Gold")).toThrow();
  });
});

describe("decodeNameStatus", () => {
  const names = fixture("names.json") as Record<string, unknown>;

  it("reads the five states", () => {
    expect(decodeNameStatus(names.taken)).toEqual({ state: "taken", owner: USER });
    expect(decodeNameStatus(names.reserved)).toEqual({ state: "reserved" });
    expect(decodeNameStatus(names.quarantined)).toEqual({ state: "quarantined", until: 432019 });
    expect(decodeNameStatus(names.available)).toEqual({ state: "available" });
    expect(decodeNameStatus(names.invalid)).toEqual({ state: "invalid" });
  });

  it("refuses an unknown state", () => {
    expect(() => decodeNameStatus({ gone: null })).toThrow();
  });
});

describe("decodeMembers", () => {
  const subs = fixture("subs-parent.json") as Record<string, any>;

  it("reads [address, label] pairs", () => {
    expect(decodeMembers(subs.subs)).toEqual([{ address: USER, label: "main laptop" }]);
    expect(decodeMembers(subs.pending)).toEqual([{ address: EVE, label: "phone" }]);
    expect(decodeMembers([])).toEqual([]);
  });
});

describe("decodeOptionBytes", () => {
  it("reads None as null", () => {
    expect(decodeOptionBytes(Uint8Array.of(0))).toBeNull();
  });

  it("reads Some(bytes) with its compact length, in each of the compact modes", () => {
    expect(decodeOptionBytes(Uint8Array.of(1, 0))).toEqual(new Uint8Array(0));
    expect(decodeOptionBytes(Uint8Array.of(1, 8, 1, 2))).toEqual(Uint8Array.of(1, 2));
    // 89 bytes: the two-byte compact mode, the size of an encrypted identity secret
    const body = Uint8Array.from({ length: 89 }, (_, i) => i);
    const raw = Uint8Array.of(1, 0x65, 0x01, ...body);
    expect(decodeOptionBytes(raw)).toEqual(body);
  });

  it("refuses a length that does not match the bytes", () => {
    expect(() => decodeOptionBytes(Uint8Array.of(1, 8, 1))).toThrow();
    expect(() => decodeOptionBytes(Uint8Array.of(2))).toThrow();
    expect(() => decodeOptionBytes(new Uint8Array(0))).toThrow();
  });
});

describe("labels", () => {
  it("names every kind of typed field", () => {
    expect(Object.keys(FIELD_LABELS)).toEqual([
      "DisplayName",
      "LegalName",
      "Web",
      "Email",
      "Matrix",
      "X",
      "Discord",
      "GitHub",
      "Telegram",
      "Pgp",
    ]);
  });
});
