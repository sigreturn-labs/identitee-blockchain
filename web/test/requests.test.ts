import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeParent, decodeProfile, type Profile } from "../src/chain/identity.ts";
import { LIMITS } from "../src/chain/edit.ts";
import {
  decodeAuthority,
  decodePendingRequests,
  REQUEST_AUTHORITY,
  requestedIds,
  standingOf,
  targetId,
  UNVERIFIABLE,
  verifyItems,
} from "../src/chain/requests.ts";
import { claimBlocker, describeSpan, describeWait, type NamingTimes, quarantineMessage } from "../src/chain/naming.ts";
import { memoryMarkers } from "../src/chain/markers.ts";
import { decodeMigration, readMigrationWith } from "../src/chain/migration.ts";
import { subAddressProblem, subLabelProblem } from "../src/chain/subs.ts";
import { isValidName, nameProblem } from "../src/chain/name.ts";
import { RESERVED_PATHS } from "../src/routes.ts";

const here = import.meta.dirname;
const fixture = (name: string): any => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
const EVE = "idnnuZEwh4Dv3QfxF6oS2zMD881G1KvXWXaWgYeBUAusWkd64";
const rust = (file: string): string => readFileSync(join(here, "..", "..", "pallets", "identitee", "src", file), "utf8");

/** The fixture profile with a few things changed in its JSON. */
function profile(change: (raw: any) => void = () => undefined): Profile {
  const raw = structuredClone(fixture("profile-user.json"));
  raw.name = null;
  raw.parent = null;
  change(raw);
  return decodeProfile(USER, raw);
}

describe("limits of sub-accounts and requests are those of the runtime", () => {
  const limits = rust("limits.rs");
  const value = (name: string): number => Number(new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(limits)![1]);
  it.each([
    ["subLabel", "MAX_SUB_LABEL_LEN"],
    ["subs", "MAX_SUBS"],
    ["pendingRequests", "MAX_PENDING_REQUESTS"],
  ] as const)("%s", (name, constant) => {
    expect(LIMITS[name]).toBe(value(constant));
  });
});

describe("nameProblem", () => {
  it("accepts what the runtime accepts: 3 to 32 bytes of a-z, 0-9, hyphen and underscore", () => {
    for (const ok of ["abc", "alice", "a-b_c9", "x".repeat(32), "0".repeat(3)]) expect(nameProblem(ok), ok).toBeNull();
  });

  it("says what is wrong, in a sentence", () => {
    expect(nameProblem("ab")).toBe("Names have at least 3 characters.");
    expect(nameProblem("")).toBe("Names have at least 3 characters.");
    expect(nameProblem("x".repeat(33))).toBe("Names have at most 32 characters.");
    for (const bad of ["Alice", "a b c", "ada.lovelace", "ada@home", "é-é-é", "a/b/c"]) {
      expect(nameProblem(bad), bad).toBe("Names use only a to z, 0 to 9, hyphens and underscores.");
    }
  });

  it("refuses the names of the app's own pages, before the chain is asked", () => {
    const paths = RESERVED_PATHS.filter((p) => isValidName(p));
    expect(paths.length).toBeGreaterThanOrEqual(2); // requests and authority fit the alphabet and the length
    for (const path of paths) expect(nameProblem(path), path).toBe("That name belongs to a page of this site and cannot be taken.");
  });

  it("agrees with isValidName on everything else", () => {
    for (const name of ["abc", "ab", "ABC", "a_b", "x".repeat(40), "tab\t", "emoji-😀", "requests"]) {
      const free = nameProblem(name) === null;
      expect(free, name).toBe(isValidName(name) && !RESERVED_PATHS.includes(name));
    }
  });
});

describe("pending requests", () => {
  const raw = fixture("requests.json");

  it("are read from the entries of the table: authority, field or fact, and the block", () => {
    const pending = decodePendingRequests(raw.pending);
    expect(pending).toEqual([
      { authority: 0, target: { field: { typed: "Email" } }, since: 10 },
      { authority: 0, target: { field: { custom: "mastodon" } }, since: 11 },
      { authority: 0, target: { field: { link: 0 } }, since: 12 },
      { authority: 0, target: { fact: "DocumentChecked" }, since: 13 },
    ]);
  });

  it("have a stable id per target", () => {
    expect(decodePendingRequests(raw.pending).map((r) => targetId(r.target))).toEqual([
      "typed:Email",
      "custom:mastodon",
      "link:0",
      "fact:DocumentChecked",
    ]);
  });

  it("refuse an answer that is not what the chain gives", () => {
    expect(() => decodePendingRequests("nope" as never)).toThrow(/Unexpected answer/);
    expect(() => decodePendingRequests([[[0, { field: { weird: 1 } }], 3]] as never)).toThrow(/Unexpected answer/);
    expect(() => decodePendingRequests([[[0, { fact: "Nothing" }], 3]] as never)).toThrow(/Unexpected answer/);
    expect(() => decodePendingRequests([[[0, { field: { typed: "Email" } }], "x"]] as never)).toThrow(/Unexpected answer/);
  });

  it("go to authority 0", () => {
    expect(REQUEST_AUTHORITY).toBe(0);
  });

  it("have the authority's name and whether it is active", () => {
    expect(decodeAuthority(0, raw.authority)).toEqual({ id: 0, name: "identitee", active: true });
    expect(decodeAuthority(0, null)).toBeNull();
    expect(() => decodeAuthority(0, { name: 3 })).toThrow(/Unexpected answer/);
  });
});

describe("UNVERIFIABLE", () => {
  it("lists the typed fields an authority cannot attest, as the runtime does", () => {
    const types = rust("types.rs");
    const body = /pub fn is_verifiable\(&self\) -> bool \{\s*!matches!\(self, ([^)]*)\)/.exec(types)![1]!;
    const names = [...body.matchAll(/FieldKind::(\w+)/g)].map((m) => m[1]);
    expect([...UNVERIFIABLE].sort()).toEqual([...names].sort());
  });
});

describe("standingOf", () => {
  const none = new Set<string>();
  const asked = new Set(["typed:Email"]);
  const flags = (verified: boolean, rejected: boolean) => ({ verified, rejected });

  it("ranks Verified, then Pending, then Rejected, and says nothing otherwise", () => {
    expect(standingOf("typed:Email", flags(true, false), asked)).toBe("Verified");
    expect(standingOf("typed:Email", flags(false, false), asked)).toBe("Pending");
    expect(standingOf("typed:Email", flags(false, true), asked)).toBe("Pending");
    expect(standingOf("typed:Email", flags(false, true), none)).toBe("Rejected");
    expect(standingOf("typed:Email", flags(false, false), none)).toBeNull();
    expect(standingOf("typed:Email", null, none)).toBeNull();
    expect(standingOf("typed:Email", null, asked)).toBe("Pending");
  });

  it("is about the id asked: a request for another target changes nothing", () => {
    expect(standingOf("typed:Pgp", flags(false, false), asked)).toBeNull();
    expect(standingOf("typed:Pgp", flags(false, true), asked)).toBe("Rejected");
  });

  it("reads the ids of the pending requests the way verifyItems keys them", () => {
    const requests = decodePendingRequests(fixture("requests.json").pending);
    expect([...requestedIds(requests)]).toEqual(["typed:Email", "custom:mastodon", "link:0", "fact:DocumentChecked"]);
  });
});

describe("verifyItems", () => {
  const pending = decodePendingRequests(fixture("requests.json").pending);

  it("lists what an authority can check: typed fields but the names, custom fields, links, the document", () => {
    const items = verifyItems(profile(), []);
    expect(items.map((i) => [i.id, i.label, i.kind])).toEqual([
      ["typed:Email", "Email", "field"],
      ["typed:Telegram", "Telegram", "field"],
      ["typed:Pgp", "PGP", "field"],
      ["custom:mastodon", "mastodon", "field"],
      ["link:0", "Website", "link"],
      ["link:1", "Code", "link"],
      ["fact:DocumentChecked", "Identity document", "fact"],
    ]);
  });

  it("shows a public value, and says Private for a private one without knowing it", () => {
    const items = verifyItems(profile(), []);
    const by = (id: string) => items.find((i) => i.id === id)!;
    expect(by("typed:Email")).toMatchObject({ private: false, detail: "user@example.org" });
    expect(by("typed:Telegram")).toMatchObject({ private: true, detail: null });
    expect(by("link:0")).toMatchObject({ private: false, detail: "https://user.example" });
    expect(by("fact:DocumentChecked")).toMatchObject({ private: false, detail: null });
  });

  it("takes the standing from the chain: Verified, a pending request, Rejected, or nothing asked", () => {
    const rejected = profile((raw) => {
      raw.attestations.push([{ typed: "Pgp" }, 0, { ...raw.attestations[0][2], commitment: "0x" + "ab".repeat(32), verdict: "Rejected" }, true]);
      // the Pgp attestation must be for the field's commitment to be valid: the runtime says so in the flag
    });
    const items = verifyItems(rejected, pending);
    const standing = Object.fromEntries(items.map((i) => [i.id, i.standing]));
    expect(standing["typed:Email"]).toBe("Verified"); // attested in the fixture; its pending request does not hide that
    expect(standing["custom:mastodon"]).toBe("Pending");
    expect(standing["link:0"]).toBe("Pending");
    expect(standing["typed:Pgp"]).toBe("Rejected");
    expect(standing["typed:Telegram"]).toBeNull();
    expect(standing["link:1"]).toBeNull();
    // the document: asked for, and the fixture also has an active DocumentChecked fact, which wins
    expect(standing["fact:DocumentChecked"]).toBe("Verified");
  });

  it("shows a pending request as Pending when the fact is not recorded yet", () => {
    const noFact = profile((raw) => {
      raw.facts = [];
    });
    const items = verifyItems(noFact, pending);
    expect(items.find((i) => i.id === "fact:DocumentChecked")).toMatchObject({ standing: "Pending", request: { authority: 0 } });
  });

  it("keeps the request of each item, so that it can be cancelled", () => {
    const items = verifyItems(profile(), pending);
    expect(items.find((i) => i.id === "custom:mastodon")!.request).toEqual({ authority: 0, target: { field: { custom: "mastodon" } }, since: 11 });
    expect(items.find((i) => i.id === "typed:Telegram")!.request).toBeNull();
  });

  it("does not offer a rejected field's request again as new: a rejection is a verdict, asking again is allowed", () => {
    const rejected = profile((raw) => {
      raw.attestations = [[{ typed: "Email" }, 0, { ...raw.attestations[0][2], verdict: "Rejected" }, true]];
    });
    expect(verifyItems(rejected, []).find((i) => i.id === "typed:Email")!.standing).toBe("Rejected");
  });

  it("lists a request whose field is gone, so that it can still be cancelled", () => {
    const items = verifyItems(profile(), [
      { authority: 0, target: { field: { custom: "old-handle" } }, since: 3 },
      { authority: 0, target: { field: { typed: "Matrix" } }, since: 4 },
      { authority: 0, target: { field: { link: 9 } }, since: 5 },
    ]);
    const gone = items.filter((i) => i.kind === "gone");
    expect(gone.map((i) => [i.label, i.standing])).toEqual([
      ["old-handle", "Pending"],
      ["Matrix", "Pending"],
      ["Link 9", "Pending"],
    ]);
    expect(gone.every((i) => i.request !== null)).toBe(true);
  });

  it("has nothing but the document without an identity", () => {
    const items = verifyItems(null, []);
    expect(items).toEqual([]);
  });
});

describe("migration", () => {
  const raw = fixture("requests.json");

  it("is pending while the chain holds the request", () => {
    expect(decodeMigration(raw.migrationPending, null, null)).toEqual({ state: "pending", source: "Polkadot", since: 14 });
  });

  it("is imported once the chain holds its history, whatever else", () => {
    expect(decodeMigration(null, raw.history, null)).toEqual({ state: "imported", source: "Polkadot", block: 1 });
    expect(decodeMigration(null, raw.history, "Kusama")).toEqual({ state: "imported", source: "Polkadot", block: 1 });
  });

  it("has ended when a request this browser saw has disappeared with nothing imported", () => {
    expect(decodeMigration(null, null, "Kusama")).toEqual({ state: "ended", source: "Kusama" });
  });

  it("is nothing when nothing was asked", () => {
    expect(decodeMigration(null, null, null)).toEqual({ state: "none" });
  });

  it("refuses a source it does not know", () => {
    expect(() => decodeMigration(["Westend", 3], null, null)).toThrow(/Unexpected answer/);
    expect(() => decodeMigration(null, ["Westend", 3, "0x00", []], null)).toThrow(/Unexpected answer/);
  });

  describe("readMigrationWith", () => {
    it("remembers a request it sees pending, so that a refusal can be told later", async () => {
      const markers = memoryMarkers();
      const reads = { request: raw.migrationPending, history: null as unknown };
      expect(await readMigrationWith(USER, async () => reads, markers)).toMatchObject({ state: "pending" });
      expect(markers.get(USER)).toBe("Polkadot");
      reads.request = null;
      expect(await readMigrationWith(USER, async () => reads, markers)).toEqual({ state: "ended", source: "Polkadot" });
    });

    it("forgets the marker once the identity is imported, and for another account the request is not known", async () => {
      const markers = memoryMarkers();
      markers.set(USER, "Polkadot");
      expect(await readMigrationWith(USER, async () => ({ request: null, history: raw.history }), markers)).toMatchObject({ state: "imported" });
      expect(markers.get(USER)).toBeNull();
      markers.set(PARENT, "Kusama");
      expect(await readMigrationWith(EVE, async () => ({ request: null, history: null }), markers)).toEqual({ state: "none" });
    });
  });
});

describe("decodeParent", () => {
  it("reads the parent of an account that has no identity, as the runtime API gives it", () => {
    expect(decodeParent([PARENT, "0x6d61696e206c6170746f70"])).toEqual({ address: PARENT, label: "main laptop" });
    expect(decodeParent(null)).toBeNull();
    expect(() => decodeParent("x")).toThrow(/Unexpected answer/);
  });
});

describe("waiting times", () => {
  it("are said in the largest unit, rounded, with at least one", () => {
    expect(describeWait(3, 6)).toBe("less than a minute");
    expect(describeWait(10, 6)).toBe("about 1 minute");
    expect(describeWait(100, 6)).toBe("about 10 minutes");
    expect(describeWait(600, 6)).toBe("about 1 hour");
    expect(describeWait(1800, 6)).toBe("about 3 hours");
    expect(describeWait(14400, 6)).toBe("about 1 day");
    expect(describeWait(33000, 6)).toBe("about 2 days");
  });

  it("are exact for a whole number of days or hours", () => {
    expect(describeSpan(14400, 6)).toBe("1 day");
    expect(describeSpan(432000, 6)).toBe("30 days");
    expect(describeSpan(600, 6)).toBe("1 hour");
    expect(describeSpan(1200, 6)).toBe("2 hours");
    expect(describeSpan(1000, 6)).toBe("about 2 hours");
  });

  it("tell a quarantined name when it comes back", () => {
    const times = { clock: { block: 1000, blockSeconds: 6 } } as NamingTimes;
    expect(quarantineMessage(1000 + 14400, times.clock)).toBe("That name was released recently. It can be claimed again in about 1 day.");
    expect(quarantineMessage(1001, times.clock)).toBe("That name was released recently. It can be claimed again in less than a minute.");
  });
});

describe("claimBlocker", () => {
  const times = (lastRelease: number | null = null): NamingTimes => ({
    clock: { block: 1000, blockSeconds: 6 },
    cooldownBlocks: 14400,
    quarantineBlocks: 432000,
    lastRelease,
  });

  it("is nothing for an identity with a verified field", () => {
    expect(claimBlocker(profile(), times())).toBeNull();
  });

  it("asks for an identity first", () => {
    expect(claimBlocker(null, times())).toEqual({ kind: "identity", message: "Create your identity first." });
  });

  it("asks for one verified field, a link counting like a field", () => {
    const none = profile((raw) => {
      raw.attestations = [];
    });
    expect(claimBlocker(none, times())).toEqual({ kind: "verification", message: "Get one field verified first. You can ask for a verification above." });
    const link = profile((raw) => {
      raw.attestations = [[{ link: 1 }, 0, { ...fixture("profile-user.json").attestations[0][2], commitment: "0x" + "00".repeat(32) }, true]];
    });
    expect(claimBlocker(link, times())).toBeNull();
  });

  it("does not count a rejected field", () => {
    const rejected = profile((raw) => {
      raw.attestations = [[{ typed: "Email" }, 0, { ...raw.attestations[0][2], verdict: "Rejected" }, true]];
    });
    expect(claimBlocker(rejected, times())?.kind).toBe("verification");
  });

  it("tells a fraud finding before anything else", () => {
    const fraud = profile((raw) => {
      raw.trustLevel = "Fraudulent";
    });
    expect(claimBlocker(fraud, times())).toEqual({ kind: "fraud", message: "A fraud finding blocks this account from claiming a name." });
  });

  it("counts the day after a release: from the block of the release, for the quota window", () => {
    expect(claimBlocker(profile(), times(1000 - 14400 + 600))).toEqual({
      kind: "cooldown",
      message: "You released a name recently. You can claim one again in about 1 hour.",
    });
    expect(claimBlocker(profile(), times(1000 - 14400))).toBeNull(); // the window is over exactly now
    expect(claimBlocker(profile(), times(1000 - 20000))).toBeNull();
  });
});

describe("sub-account forms", () => {
  it("refuse a label of more than 64 bytes, counted in bytes", () => {
    expect(subLabelProblem("work laptop")).toBeNull();
    expect(subLabelProblem("")).toBeNull();
    expect(subLabelProblem("x".repeat(64))).toBeNull();
    expect(subLabelProblem("x".repeat(65))).toBe("A label has at most 64 bytes, this one has 65.");
    expect(subLabelProblem("é".repeat(33))).toBe("A label has at most 64 bytes, this one has 66.");
  });

  it("check the address before anything is signed", () => {
    expect(subAddressProblem("", USER, [])).toBeNull();
    expect(subAddressProblem("  ", USER, [])).toBeNull();
    expect(subAddressProblem("not an address", USER, [])).toBe("That is not a valid account address.");
    expect(subAddressProblem(USER, USER, [])).toBe("An account cannot be its own sub-account.");
    expect(subAddressProblem(PARENT, USER, [PARENT])).toBe("That account is already your sub-account, or has a proposal from you.");
    expect(subAddressProblem(EVE, USER, [PARENT])).toBeNull();
  });

  it("know an account by its key, whatever the prefix of the address", async () => {
    const { encodeAddress } = await import("@polkadot/util-crypto");
    const { publicKeyOf } = await import("../src/chain/address.ts");
    const generic = encodeAddress(publicKeyOf(PARENT), 42);
    expect(subAddressProblem(generic, USER, [PARENT])).toBe("That account is already your sub-account, or has a proposal from you.");
    expect(subAddressProblem(encodeAddress(publicKeyOf(USER), 0), USER, [])).toBe("An account cannot be its own sub-account.");
  });
});
