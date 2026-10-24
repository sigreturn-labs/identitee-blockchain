import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentFrom, CAPABILITY, decodeAgentRow } from "../src/chain/agent.ts";
import { linkCommitment, privateCommitment } from "../src/chain/formulas.ts";
import { decodeProfile } from "../src/chain/identity.ts";
import { checkPacket, commitmentIn, decodeFactState, decodeInbox, inboxItem } from "../src/chain/inbox.ts";
import { makePacket } from "../src/chain/packet.ts";

// What an authority agent works on, without a node: who counts as an agent, the inbox decoded from
// the rows of `pendingRequests`, what each request allows, the commitment a verdict is made against,
// and the check of a pasted verification packet.

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const OTHER = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as any;
const profile = () => decodeProfile(USER, structuredClone(fixture));

describe("who is an agent for the authority page", () => {
  const active = { id: 0, name: "identitee", active: true };

  it("reads the agents row, and nothing for an account that is not one", () => {
    expect(decodeAgentRow([0, 15])).toEqual({ authority: 0, caps: 15 });
    expect(decodeAgentRow(null)).toBeNull();
    expect(() => decodeAgentRow({ caps: 1 })).toThrow(/Unexpected answer/);
  });

  it("says what each capability allows", () => {
    expect(agentFrom({ authority: 0, caps: 15 }, active)).toEqual({ authority: active, attest: true, facts: true, names: true });
    expect(agentFrom({ authority: 0, caps: CAPABILITY.names }, active)).toEqual({ authority: active, attest: false, facts: false, names: true });
    expect(agentFrom({ authority: 0, caps: CAPABILITY.attest | CAPABILITY.facts }, active)).toMatchObject({ attest: true, facts: true, names: false });
  });

  it("is nobody for an inactive authority, a migration service, or no row", () => {
    expect(agentFrom({ authority: 0, caps: 15 }, { ...active, active: false })).toBeNull();
    expect(agentFrom({ authority: 0, caps: CAPABILITY.migrate }, active)).toBeNull();
    expect(agentFrom({ authority: 0, caps: 15 }, null)).toBeNull();
    expect(agentFrom(null, active)).toBeNull();
  });

  it("knows the capability bits of the runtime", () => {
    const types = readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "src", "types.rs"), "utf8");
    const bit = (name: string) => Number(new RegExp(`pub const ${name}: Self = Self\\((\\d+)\\);`).exec(types)![1]);
    expect(CAPABILITY).toEqual({ attest: bit("ATTEST_FIELDS"), facts: bit("PERSON_FACTS"), names: bit("MANAGE_NAMES"), migrate: bit("MIGRATE") });
  });
});

describe("the inbox", () => {
  const row = (who: string, authority: number, target: unknown, since: number) => ({ who, key: [authority, target], since });

  it("keeps the requests made to the authority, oldest first", () => {
    const rows = [
      row(USER, 0, { field: { typed: "Email" } }, 30),
      row(OTHER, 1, { field: { typed: "Email" } }, 5),
      row(OTHER, 0, { fact: "DocumentChecked" }, 10),
      row(USER, 0, { field: { link: 1 } }, 20),
    ];
    expect(decodeInbox(rows, 0)).toEqual([
      { who: OTHER, target: { fact: "DocumentChecked" }, since: 10 },
      { who: USER, target: { field: { link: 1 } }, since: 20 },
      { who: USER, target: { field: { typed: "Email" } }, since: 30 },
    ]);
    expect(() => decodeInbox([row(USER, 0, { nonsense: 1 }, 1)], 0)).toThrow(/Unexpected answer/);
  });

  it("says what each request allows, from what the identity holds", () => {
    const p = profile();
    const item = (target: any) => inboxItem({ who: USER, target, since: 1 }, p);
    expect(item({ field: { typed: "Email" } })).toMatchObject({ kind: "public", label: "Email", value: "user@example.org", id: `${USER}|typed:Email` });
    expect(item({ field: { typed: "Pgp" } })).toMatchObject({ kind: "public", value: "ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB" });
    expect(item({ field: { custom: "mastodon" } })).toMatchObject({ kind: "public", label: "mastodon", value: "@user@m.example" });
    expect(item({ field: { typed: "Telegram" } })).toMatchObject({ kind: "private", label: "Telegram", value: null });
    expect(item({ field: { link: 1 } })).toMatchObject({ kind: "link", label: "Code", value: "https://git.example/user" });
    expect(item({ field: { link: 9 } })).toMatchObject({ kind: "gone", label: "Link 9" });
    expect(item({ field: { typed: "Discord" } })).toMatchObject({ kind: "gone", label: "Discord" });
    expect(item({ fact: "DocumentChecked" })).toMatchObject({ kind: "document", label: "Identity document" });
    expect(item({ fact: "Fraud" })).toMatchObject({ kind: "fraud", label: "Fraud" });
    // a request outlives an identity that was cleared: nothing to verify
    expect(inboxItem({ who: USER, target: { field: { typed: "Email" } }, since: 1 }, null)).toMatchObject({ kind: "gone" });
  });

  it("verifies against the commitment the chain holds: public value, private commitment, link", () => {
    const p = profile();
    expect(commitmentIn(p, { typed: "Email" })).toEqual({ commitment: "0xdc14c71338942896bacc3cfe9c20c4f68b1150264e73dd06af1822602513ea23", private: false });
    expect(commitmentIn(p, { typed: "Telegram" })).toEqual({ commitment: `0x${"22".repeat(32)}`, private: true });
    expect(commitmentIn(p, { link: 1 })).toEqual({ commitment: linkCommitment("Code", "https://git.example/user"), private: false });
    expect(commitmentIn(p, { typed: "Discord" })).toBeNull();
    expect(commitmentIn(null, { typed: "Email" })).toBeNull();
  });
});

describe("facts", () => {
  it("are active until revoked, or until the end of their last block", () => {
    const fact = { issuedAt: 4, expiresAt: null, reason: "Unspecified", note: "0x", revoked: null };
    expect(decodeFactState(fact, 100)).toEqual({ state: "active", issuedAt: 4 });
    expect(decodeFactState({ ...fact, revoked: [9, "Other"] }, 100)).toEqual({ state: "revoked", issuedAt: 4 });
    expect(decodeFactState({ ...fact, expiresAt: 100 }, 100)).toMatchObject({ state: "active" });
    expect(decodeFactState({ ...fact, expiresAt: 100 }, 101)).toMatchObject({ state: "expired" });
    expect(decodeFactState(null, 100)).toBeNull();
  });
});

describe("a pasted verification packet", () => {
  const GENESIS = `0x${"ab".repeat(32)}` as const;
  const SALT = new Uint8Array(32).fill(0x11);
  const VALUE = "@alice";
  let user: ReturnType<Keyring["addFromUri"]>;
  let other: ReturnType<Keyring["addFromUri"]>;

  beforeAll(async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
    user = keyring.addFromUri("//PacketUser");
    other = keyring.addFromUri("//PacketOther");
  });

  const sign = (pair: typeof user) => async (data: `0x${string}`) => u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data))));
  /** The identity of `user` with a private Telegram under `commitment`. */
  const holding = (commitment: string) => {
    const raw = structuredClone(fixture);
    raw.identity.typed.Telegram = { private: commitment };
    return decodeProfile(user.address, raw);
  };
  const packet = async (overrides: Partial<Parameters<typeof makePacket>[0]> = {}, pair = user) =>
    JSON.stringify(
      await makePacket({ chain: GENESIS, address: pair.address, ref: { typed: "Telegram" }, value: stringToU8a(VALUE), salt: SALT, ...overrides }, sign(pair)),
    );
  const onChain = () => privateCommitment(SALT, VALUE);

  it("passes when the requester signed it for the requested field of this chain, and the chain holds its commitment", async () => {
    expect(await checkPacket(await packet(), user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({ value: VALUE, commitment: onChain() });
  });

  it("shows a PGP fingerprint in groups of four", async () => {
    const fp = new Uint8Array(20).fill(0xab);
    const raw = structuredClone(fixture);
    raw.identity.typed.Pgp = { private: privateCommitment(SALT, fp) };
    const p = decodeProfile(user.address, raw);
    const text = await packet({ ref: { typed: "Pgp" }, value: fp });
    expect(await checkPacket(text, user.address, { typed: "Pgp" }, GENESIS, p)).toMatchObject({ value: "ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB" });
  });

  it("refuses a packet signed by someone else than the requester", async () => {
    expect(await checkPacket(await packet({}, other), user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({
      problem: "This packet is signed by another account than the one that asked.",
    });
  });

  it("refuses a packet for another field", async () => {
    const text = await packet({ ref: { custom: "phone" } });
    expect(await checkPacket(text, user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({ problem: "This packet is for phone, not Telegram." });
  });

  it("refuses a packet made for another chain", async () => {
    const text = await packet({ chain: `0x${"cd".repeat(32)}` });
    expect(await checkPacket(text, user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({ problem: "This packet was made for another chain." });
  });

  it("refuses a packet whose commitment is not the one on chain now", async () => {
    expect(await checkPacket(await packet(), user.address, { typed: "Telegram" }, GENESIS, holding(`0x${"22".repeat(32)}`))).toEqual({
      problem: "The packet does not match the field on chain. The person may have changed it since.",
    });
  });

  it("refuses when the field left the identity, or was made public", async () => {
    const raw = structuredClone(fixture);
    delete raw.identity.typed.Telegram;
    expect(await checkPacket(await packet(), user.address, { typed: "Telegram" }, GENESIS, decodeProfile(user.address, raw))).toEqual({
      problem: "That field is no longer on the identity.",
    });
    raw.identity.typed.Telegram = { public: u8aToHex(stringToU8a(VALUE)) };
    expect(await checkPacket(await packet(), user.address, { typed: "Telegram" }, GENESIS, decodeProfile(user.address, raw))).toEqual({
      problem: "That field is public now: verify it without a packet.",
    });
  });

  it("passes on what readPacket refuses: a damaged packet, or one that is not one", async () => {
    const text = (await packet()).replace(VALUE, "@someone_else");
    expect(await checkPacket(text, user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({ problem: "The signature does not match the account." });
    expect(await checkPacket("hello", user.address, { typed: "Telegram" }, GENESIS, holding(onChain()))).toEqual({ problem: "This is not a verification packet." });
  });
});

describe("the inbox keeps the value each row showed", () => {
  it("as the commitment a verdict is made against", () => {
    const p = profile();
    const item = (target: any) => inboxItem({ who: USER, target, since: 1 }, p);
    expect(item({ field: { typed: "Email" } }).commitment).toBe(commitmentIn(p, { typed: "Email" })!.commitment);
    expect(item({ field: { link: 0 } }).commitment).toBe(linkCommitment("Website", "https://user.example"));
    expect(item({ field: { typed: "Discord" } }).commitment).toBeNull();
    expect(item({ fact: "DocumentChecked" }).commitment).toBeNull();
  });
});
