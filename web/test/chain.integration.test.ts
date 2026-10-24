// Against a local dev node, only when RPC_TEST is set:
//
//   ../target/release/identitee-node --dev --tmp          (spec_version 6, in another terminal)
//   RPC_TEST=1 npx vitest run test/chain.integration.test.ts
//   RPC_TEST=ws://host:9944 ...                           (another endpoint)
//
// Alice is the sudo key and the agent of authority 0 (all capabilities). Every user below is a
// fresh key with a zero balance: identity calls must work without a fee.
//
// This file WRITES to the chain (dozens of transactions, 50 in the quota test). It therefore
// refuses to run unless the node says it is a development or local chain, so a mistyped
// RPC_TEST can never reach wss://rpc.identit.ee, and it points VITE_RPC at the same node so no
// code path can fall back to the public endpoint.

import { Keyring } from "@polkadot/keyring";
import { randomAsU8a, cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import { hexToU8a, stringToHex, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { Signer } from "@polkadot/types/types";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toIdentitee } from "../src/chain/address.ts";
import { connect, disconnect, linkState, onLinkState } from "../src/chain/api.ts";
import { linkCommitment, privateCommitment, publicCommitment } from "../src/chain/formulas.ts";
import {
  identitySecret,
  nameStatus,
  parentOf,
  pendingSubsOf,
  proposalsTo,
  readProfile,
  resolveName,
  subsOf,
  trustLevel,
} from "../src/chain/identity.ts";
import {
  acceptSubCall,
  addLinkCall,
  addSubCall,
  cancelMigrationCall,
  cancelRequestCall,
  claimUsernameCall,
  clearAvatarCall,
  declineSubCall,
  quitSubCall,
  releaseUsernameCall,
  removeSubCall,
  renameSubCall,
  requestJudgementCall,
  requestMigrationCall,
  removeLinkCall,
  reorderLinksCall,
  revealFieldCall,
  setAvatarCall,
  setBioCall,
  setIdentityCall,
  setIdentitySecretCall,
  updateLinkCall,
  grantFactCall,
  provideJudgementCall,
  rejectRequestCall,
  reserveUsernameCall,
  revokeAttestationCall,
  revokeFactCall,
  setUsernameForCall,
  unbindUsernameCall,
  unreserveUsernameCall,
} from "../src/chain/calls.ts";
import { readAgent } from "../src/chain/agent.ts";
import { checkPacket, commitmentNow, genesisHash, readAccount, readInbox, readReserved } from "../src/chain/inbox.ts";
import { readOverview } from "../src/chain/overview.ts";
import { makePacket, readPacket } from "../src/chain/packet.ts";
import { memoryMarkers } from "../src/chain/markers.ts";
import { readMigration } from "../src/chain/migration.ts";
import { claimBlocker, readNamingTimes } from "../src/chain/naming.ts";
import { pendingRequestsOf, readAuthority, targetId, verifyItems } from "../src/chain/requests.ts";
import { encodeFieldKey, fieldSalt, newSecret, openSecret, sealSecret } from "../src/crypto/secret.ts";
import { send } from "../src/chain/tx.ts";

const RPC = process.env.RPC_TEST;
const NODE_URL = RPC?.startsWith("ws") ? RPC : "ws://127.0.0.1:9944";

/** Chain types (`system_chainType`) that are safe to write to; the online testnet is `Live`. */
const WRITABLE_CHAIN_TYPES: readonly string[] = ["Development", "Local"];

const hex = stringToHex;

describe.skipIf(!RPC)("the chain layer against a dev node", () => {
  let api: ApiPromise;
  let keyring: Keyring;
  let alice: KeyringPair;

  /** The pallet's calls (polkadot.js has no static types for them). */
  const idt = (): any => api.tx.identitee;
  const fresh = (): KeyringPair => keyring.addFromMnemonic(mnemonicGenerate());
  const random = (): string => u8aToHex(randomAsU8a(5)).slice(2);

  /** Send and require success. */
  async function ok(call: SubmittableExtrinsic<"promise">, as: KeyringPair) {
    const result = await send(call, as);
    expect(result.error, "error").toBeUndefined();
    expect(result.ok).toBe(true);
    return result;
  }

  beforeAll(async () => {
    await cryptoWaitReady();
    keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
    alice = keyring.addFromUri("//Alice");
    vi.stubEnv("VITE_RPC", NODE_URL);
    api = await connect(NODE_URL);
    const chainType = (await api.rpc.system.chainType()).type;
    if (!WRITABLE_CHAIN_TYPES.includes(chainType)) {
      const chain = (await api.rpc.system.chain()).toString();
      await disconnect();
      throw new Error(
        `Refusing to run: ${NODE_URL} is the chain "${chain}" (type ${chainType}). These tests write; use a node started with --dev.`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await disconnect();
    vi.unstubAllEnvs();
  });

  it("connects once, to an identitee runtime of spec 5 or later", async () => {
    expect(await connect(NODE_URL)).toBe(api);
    expect(linkState()).toBe("connected");
    expect(api.runtimeVersion.specName.toString()).toBe("identitee");
    expect(api.runtimeVersion.specVersion.toNumber()).toBeGreaterThanOrEqual(5);
  });

  it("tells the state of the link", async () => {
    const seen: string[] = [];
    const stop = onLinkState((s) => seen.push(s));
    await disconnect();
    expect(seen).toEqual(["disconnected"]);
    stop();
    api = await connect(NODE_URL);
    expect(linkState()).toBe("connected");
  }, 30_000);

  it("reads nothing for an account that has nothing", async () => {
    const stranger = toIdentitee(randomAsU8a(32));
    expect(await readProfile(stranger)).toBeNull();
    expect(await trustLevel(stranger)).toBeNull();
    expect(await identitySecret(stranger)).toBeNull();
    expect(await subsOf(stranger)).toEqual([]);
    expect(await pendingSubsOf(stranger)).toEqual([]);
    expect(await proposalsTo(stranger)).toEqual([]);
    expect(await resolveName(`nobody-${random()}`)).toBeNull();
    expect(await nameStatus("ab")).toEqual({ state: "invalid" });
    expect(await nameStatus(`free-${random()}`)).toEqual({ state: "available" });
  });

  it("reads back what a zero-balance account wrote, and the TypeScript formulas agree with the runtime", async () => {
    const user = fresh();
    const email = `user-${random()}@example.org`;
    const salt = randomAsU8a(32);
    const telegram = `@user_${random()}`;
    const title = "Site";
    const url = `https://${random()}.example`;

    await ok(
      idt().setIdentity([
        [{ Typed: "DisplayName" }, { Public: hex("Integration User") }],
        [{ Typed: "Email" }, { Public: hex(email) }],
        [{ Typed: "Telegram" }, { Private: privateCommitment(salt, telegram) }],
        [{ Custom: hex("mastodon") }, { Public: hex("@user@m.example") }],
      ]),
      user,
    );
    await ok(idt().setBio(hex("Bio from the integration test.")), user);
    await ok(idt().addLink(hex(title), hex(url)), user);
    expect((await api.query.system!.account!(user.address) as any).data.free.toBigInt()).toBe(0n);

    const profile = (await readProfile(user.address))!;
    expect(profile.address).toBe(user.address);
    expect(profile.trust).toBe("Declared");
    expect(profile.bio).toBe("Bio from the integration test.");
    expect(profile.fields.map((f) => [f.id, f.privacy, f.verified])).toEqual([
      ["typed:DisplayName", "public", false],
      ["typed:Email", "public", false],
      ["typed:Telegram", "private", false],
      ["custom:mastodon", "public", false],
    ]);
    expect(profile.links).toEqual([{ id: 0, title, url, verified: false, rejected: false }]);
    expect(profile.fields.find((f) => f.id === "typed:Email")!.commitment).toBe(publicCommitment(email));
    expect(profile.fields.find((f) => f.id === "typed:Telegram")!.commitment).toBe(privateCommitment(salt, telegram));
    expect(await trustLevel(user.address)).toBe("Declared");

    // The authority attests the values by their commitments, computed here and checked there:
    // a wrong formula would be refused with StaleCommitment.
    await ok(
      idt().provideJudgement(user.address, { Typed: "Email" }, publicCommitment(email), "Verified", "Manual", null),
      alice,
    );
    await ok(
      idt().provideJudgement(user.address, { Link: 0 }, linkCommitment(title, url), "Verified", "Manual", null),
      alice,
    );
    // And the private value is revealed under the salt: refused with RevealMismatch otherwise.
    await ok(idt().revealField({ Typed: "Telegram" }, hex(telegram), u8aToHex(salt)), user);

    const after = (await readProfile(user.address))!;
    expect(after.trust).toBe("PartiallyVerified");
    expect(after.fields.filter((f) => f.verified).map((f) => f.id)).toEqual(["typed:Email"]);
    expect(after.links[0]!.verified).toBe(true);
    const telegramAfter = after.fields.find((f) => f.id === "typed:Telegram")!;
    expect(telegramAfter).toMatchObject({ privacy: "public", value: telegram });
    expect(telegramAfter.commitment).toBe(publicCommitment(telegram));
    expect(after.attestations).toHaveLength(2);

    // A verified field is enough to take a name.
    const name = `it-${random()}`;
    expect(await nameStatus(name)).toEqual({ state: "available" });
    await ok(idt().claimUsername(hex(name)), user);
    expect(await nameStatus(name)).toEqual({ state: "taken", owner: user.address });
    expect(await resolveName(name)).toBe(user.address);
    expect((await readProfile(user.address))!.name).toBe(name);

    await ok(idt().releaseUsername(), user);
    const released = await nameStatus(name);
    expect(released.state).toBe("quarantined");
  }, 120_000);

  it("keeps an encrypted identity secret byte for byte", async () => {
    const user = fresh();
    const blob = Uint8Array.from([1, ...randomAsU8a(88)]);
    expect(await identitySecret(user.address)).toBeNull();
    await ok(idt().setIdentitySecret(u8aToHex(blob)), user);
    expect(await identitySecret(user.address)).toEqual(blob);
    await ok(idt().clearIdentitySecret(), user);
    expect(await identitySecret(user.address)).toBeNull();
  }, 60_000);

  it("stores private fields from the identity secret, and the runtime takes their derived salts", async () => {
    const user = fresh();
    const PASS = "integration passphrase 1234";
    const email = "private.integration@example.org";
    const phone = "+33 6 11 22 33 44";
    const pgp = new Uint8Array(32).fill(0xcd);

    // SCALE of FieldKey in the salt is the runtime's own encoding (read from its metadata)
    const keyType = idt().revealField.meta.args[0].type.toString();
    for (const ref of [{ typed: "Email" as const }, { typed: "Pgp" as const }, { custom: "phone" }]) {
      const value = "typed" in ref ? { Typed: ref.typed } : { Custom: hex(ref.custom) };
      expect(u8aToHex(encodeFieldKey(ref))).toBe(u8aToHex(api.createType(keyType, value).toU8a()));
    }

    // what goes out on the WebSocket from here to the reveal: never a value, a salt, the secret
    // or the passphrase; the commitments do
    const frames: string[] = [];
    const original = WebSocket.prototype.send;
    const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data) {
      frames.push(String(data));
      return original.call(this, data);
    });
    const secret = newSecret();
    const blob = await sealSecret(secret, PASS);
    await ok(await setIdentitySecretCall(blob), user);
    const stored = (await identitySecret(user.address))!;
    expect(stored).toEqual(blob);
    expect(await openSecret(stored, PASS)).toEqual(secret);

    const salts = { email: fieldSalt(secret, { typed: "Email" }), phone: fieldSalt(secret, { custom: "phone" }), pgp: fieldSalt(secret, { typed: "Pgp" }) };
    await ok(
      await setIdentityCall(
        [
          { ref: { typed: "Email" }, value: stringToU8a(email), private: true },
          { ref: { custom: "phone" }, value: stringToU8a(phone), private: true },
          { ref: { typed: "Pgp" }, value: pgp, private: true },
          { ref: { typed: "DisplayName" }, value: stringToU8a("Private Tester") },
        ],
        secret,
      ),
      user,
    );
    const profile = (await readProfile(user.address))!;
    const commitment = (id: string) => profile.fields.find((f) => f.id === id)!;
    expect(commitment("typed:Email")).toMatchObject({ privacy: "private", value: null, commitment: privateCommitment(salts.email, email) });
    expect(commitment("custom:phone")).toMatchObject({ privacy: "private", commitment: privateCommitment(salts.phone, phone) });
    expect(commitment("typed:Pgp")).toMatchObject({ privacy: "private", commitment: privateCommitment(salts.pgp, pgp) });

    // the packet an authority would get, checked against what the chain holds
    const packet = await makePacket(
      { chain: api.genesisHash.toHex(), address: user.address, ref: { typed: "Email" }, value: stringToU8a(email), salt: salts.email },
      async (data) => u8aToHex(user.sign(u8aWrapBytes(hexToU8a(data)))),
    );
    const read = await readPacket(JSON.stringify(packet));
    expect(read).toHaveProperty("packet");
    expect((read as { packet: { commitment: string } }).packet.commitment).toBe(commitment("typed:Email").commitment);
    sendSpy.mockRestore();

    expect(frames.length).toBeGreaterThan(3);
    const wire = frames.join("\n");
    expect(wire).toContain(privateCommitment(salts.email, email).slice(2));
    for (const needle of [email, phone, PASS, ...[stringToU8a(email), stringToU8a(phone), stringToU8a(PASS), secret, salts.email, salts.phone, salts.pgp].map((b) => u8aToHex(b).slice(2))]) {
      expect(wire.includes(needle), needle).toBe(false);
    }

    // reveal: the runtime recomputes the commitment from the value and the derived salt
    await ok(await revealFieldCall({ typed: "Email" }, stringToU8a(email), salts.email), user);
    await ok(await revealFieldCall({ typed: "Pgp" }, pgp, salts.pgp), user);
    const after = (await readProfile(user.address))!;
    expect(after.fields.find((f) => f.id === "typed:Email")).toMatchObject({ privacy: "public", value: email });
    expect(after.fields.find((f) => f.id === "typed:Pgp")).toMatchObject({ privacy: "public", value: "CD".repeat(32) });
    // a wrong salt is refused by the runtime too
    const refused = await send(await revealFieldCall({ custom: "phone" }, stringToU8a(phone), salts.email), user);
    expect(refused.errorName).toBe("RevealMismatch");
  }, 180_000);

  it("lists proposals to a sub, then its parent, before and after acceptance", async () => {
    const parent = fresh();
    const sub = fresh();
    await ok(idt().setBio(hex("parent")), parent);
    await ok(idt().setBio(hex("sub")), sub);
    await ok(idt().addSub(sub.address, hex("laptop")), parent);

    expect(await pendingSubsOf(parent.address)).toEqual([{ address: sub.address, label: "laptop" }]);
    expect(await subsOf(parent.address)).toEqual([]);
    expect(await proposalsTo(sub.address)).toEqual([{ address: parent.address, label: "laptop" }]);

    await ok(idt().acceptSub(parent.address), sub);
    expect(await subsOf(parent.address)).toEqual([{ address: sub.address, label: "laptop" }]);
    expect(await pendingSubsOf(parent.address)).toEqual([]);
    expect(await proposalsTo(sub.address)).toEqual([]);
    expect((await readProfile(sub.address))!.parent).toEqual({ address: parent.address, label: "laptop" });
    expect((await readProfile(parent.address))!.subs).toEqual([{ address: sub.address, label: "laptop" }]);
  }, 90_000);

  it("accepts every call the editor builds, from an account with nothing in it", async () => {
    const user = fresh();
    const bytes = (text: string) => new TextEncoder().encode(text);
    const pgp = new Uint8Array(20).fill(0xab);
    const avatar = new Uint8Array(readFileSync(new URL("../../pallets/identitee/tests/fixtures/avatar-64-lossy.webp", import.meta.url)));

    // the first save creates the identity: fields, set and removed, in one call
    await ok(
      await setIdentityCall([
        { ref: { typed: "DisplayName" }, value: bytes("Ada Lovelace") },
        { ref: { typed: "Email" }, value: bytes("ada@example.org") },
        { ref: { typed: "Pgp" }, value: pgp },
        { ref: { custom: "pronouns" }, value: bytes("she/her") },
        { ref: { typed: "Web" }, value: bytes("https://ada.example") },
      ]),
      user,
    );
    await ok(await setIdentityCall([{ ref: { typed: "Web" }, value: null }, { ref: { typed: "Email" }, value: bytes("new@example.org") }]), user);
    await ok(await setBioCall("  Mathematician.  "), user);
    await ok(await addLinkCall(" Notes ", "ada.example/notes"), user);
    await ok(await addLinkCall("Code", "https://git.example/ada"), user);
    let profile = (await readProfile(user.address))!;
    const [notes, code] = profile.links;
    expect(profile.links.map((l) => [l.title, l.url])).toEqual([
      ["Notes", "https://ada.example/notes"],
      ["Code", "https://git.example/ada"],
    ]);
    await ok(await updateLinkCall(notes!.id, "Notebook", "http://ada.example/nb"), user);
    await ok(await reorderLinksCall([code!.id, notes!.id]), user);
    await ok(await setAvatarCall(avatar), user);

    profile = (await readProfile(user.address))!;
    expect(profile.fields.map((f) => [f.id, f.value])).toEqual([
      ["typed:DisplayName", "Ada Lovelace"],
      ["typed:Email", "new@example.org"],
      ["typed:Pgp", "AB".repeat(20)],
      ["custom:pronouns", "she/her"],
    ]);
    expect(profile.bio).toBe("Mathematician.");
    expect(profile.links.map((l) => [l.title, l.url])).toEqual([
      ["Code", "https://git.example/ada"],
      ["Notebook", "http://ada.example/nb"],
    ]);
    expect(profile.avatar).toEqual(avatar);

    await ok(await removeLinkCall(code!.id), user);
    await ok(await clearAvatarCall(), user);
    profile = (await readProfile(user.address))!;
    expect(profile.links.map((l) => l.title)).toEqual(["Notebook"]);
    expect(profile.avatar).toBeNull();
  }, 120_000);

  it("accepts every call of the requests page, reads the answers back, from accounts with nothing in them", async () => {
    const user = fresh();
    const other = fresh();
    const email = `user-${random()}@example.org`;
    await ok(await setIdentityCall([{ ref: { typed: "Email" }, value: new TextEncoder().encode(email) }, { ref: { custom: "mastodon" }, value: new TextEncoder().encode("@u@m.example") }]), user);
    await ok(await addLinkCall("Site", "https://site.example"), user);

    // verification requests: every kind of target, read back through the table's own keys
    expect(await readAuthority()).toMatchObject({ id: 0, name: "identitee", active: true });
    for (const target of [{ field: { typed: "Email" } }, { field: { custom: "mastodon" } }, { field: { link: 0 } }, { fact: "DocumentChecked" }] as const) {
      await ok(await requestJudgementCall(0, target), user);
    }
    expect((await pendingRequestsOf(user.address)).map((r) => [r.authority, targetId(r.target)])).toEqual([
      [0, "typed:Email"],
      [0, "custom:mastodon"],
      [0, "link:0"],
      [0, "fact:DocumentChecked"],
    ]);
    const again = await send(await requestJudgementCall(0, { field: { typed: "Email" } }), user);
    expect(again).toMatchObject({ ok: false, errorName: "RequestExists", error: "You already asked for this check." });
    let profile = (await readProfile(user.address))!;
    expect(verifyItems(profile, await pendingRequestsOf(user.address)).map((i) => [i.id, i.standing])).toEqual([
      ["typed:Email", "Pending"],
      ["custom:mastodon", "Pending"],
      ["link:0", "Pending"],
      ["fact:DocumentChecked", "Pending"],
    ]);
    await ok(await cancelRequestCall(0, { fact: "DocumentChecked" }), user);
    await ok(await cancelRequestCall(0, { field: { link: 0 } }), user);
    const missing = await send(await cancelRequestCall(0, { field: { link: 0 } }), user);
    expect(missing).toMatchObject({ errorName: "UnknownRequest", error: "That request does not exist anymore." });
    expect((await pendingRequestsOf(user.address)).map((r) => targetId(r.target))).toEqual(["typed:Email", "custom:mastodon"]);

    // the authority's answer takes the request away and the chain reads the field as verified
    await ok(idt().provideJudgement(user.address, { Typed: "Email" }, publicCommitment(email), "Verified", "Manual", null), alice);
    expect((await pendingRequestsOf(user.address)).map((r) => targetId(r.target))).toEqual(["custom:mastodon"]);
    profile = (await readProfile(user.address))!;
    expect(verifyItems(profile, await pendingRequestsOf(user.address)).find((i) => i.id === "typed:Email")!.standing).toBe("Verified");

    // a name: the numbers the page needs are those of this runtime, and the cooldown follows a release
    let times = await readNamingTimes(user.address);
    expect(times).toMatchObject({ cooldownBlocks: 14400, quarantineBlocks: 432000, lastRelease: null, clock: { blockSeconds: 6 } });
    expect(times.clock.block).toBeGreaterThan(0);
    expect(claimBlocker(profile, times)).toBeNull();
    const name = `rq-${random()}`;
    await ok(await claimUsernameCall(name), user);
    expect(await nameStatus(name)).toEqual({ state: "taken", owner: user.address });
    await ok(await releaseUsernameCall(), user);
    times = await readNamingTimes(user.address);
    expect(times.lastRelease).not.toBeNull();
    const quarantined = await nameStatus(name);
    expect(quarantined).toEqual({ state: "quarantined", until: times.lastRelease! + times.quarantineBlocks });
    expect(claimBlocker((await readProfile(user.address))!, times)).toMatchObject({ kind: "cooldown" });
    const cooling = await send(await claimUsernameCall(`rq-${random()}`), user);
    expect(cooling).toMatchObject({ ok: false, errorName: "ClaimCooldown", error: "You released a name recently. Try again tomorrow." });

    // sub-accounts, from a parent to an account with no identity and back
    await ok(await addSubCall(other.address, " laptop "), user);
    expect(await proposalsTo(other.address)).toEqual([{ address: user.address, label: "laptop" }]);
    const twice = await send(await addSubCall(other.address, "again"), user);
    expect(twice).toMatchObject({ errorName: "AlreadyProposed" });
    await ok(await declineSubCall(user.address), other);
    expect(await proposalsTo(other.address)).toEqual([]);
    await ok(await addSubCall(other.address, "laptop"), user);
    await ok(await acceptSubCall(user.address), other);
    expect(await parentOf(other.address)).toEqual({ address: user.address, label: "laptop" });
    expect(await readProfile(other.address)).toBeNull(); // an account needs no identity to be a sub-account
    await ok(await renameSubCall(other.address, "tablet"), user);
    expect(await subsOf(user.address)).toEqual([{ address: other.address, label: "tablet" }]);
    await ok(await quitSubCall(), other);
    expect(await parentOf(other.address)).toBeNull();
    await ok(await addSubCall(other.address, "phone"), user);
    expect(await pendingSubsOf(user.address)).toEqual([{ address: other.address, label: "phone" }]);
    await ok(await renameSubCall(other.address, "watch"), user); // renaming a proposal
    await ok(await removeSubCall(other.address), user); // withdrawing it
    expect(await pendingSubsOf(user.address)).toEqual([]);
    expect(await proposalsTo(other.address)).toEqual([]);
    const notYours = await send(await removeSubCall(other.address), user);
    expect(notYours).toMatchObject({ errorName: "NotYourSub", error: "That account is not your sub-account." });

    // migration: pending, withdrawn, refused (which the chain forgets), then imported
    const mover = fresh();
    const bob = keyring.addFromUri("//Bob");
    const markers = memoryMarkers();
    expect(await readMigration(mover.address, markers)).toEqual({ state: "none" });
    await ok(await requestMigrationCall("Polkadot"), mover);
    expect(await readMigration(mover.address, markers)).toMatchObject({ state: "pending", source: "Polkadot" });
    const second = await send(await requestMigrationCall("Kusama"), mover);
    expect(second).toMatchObject({ errorName: "MigrationRequestExists", error: "A migration request is already waiting." });
    await ok(await cancelMigrationCall(), mover);
    markers.clear(mover.address); // what the page does after a withdrawal
    expect(await readMigration(mover.address, markers)).toEqual({ state: "none" });
    const nothing = await send(await cancelMigrationCall(), mover);
    expect(nothing).toMatchObject({ errorName: "NoMigrationRequest" });

    await ok(await requestMigrationCall("Kusama"), mover);
    expect(await readMigration(mover.address, markers)).toMatchObject({ state: "pending", source: "Kusama" });
    await ok(idt().rejectMigration(mover.address, "Unspecified"), bob);
    expect(await readMigration(mover.address, markers)).toEqual({ state: "ended", source: "Kusama" });

    await ok(await requestMigrationCall("Polkadot"), mover);
    const header = await api.rpc.chain.getHeader();
    const blockHash = (await api.rpc.chain.getBlockHash(header.number.toNumber())).toHex();
    await ok(
      idt().fulfilMigration(mover.address, "Polkadot", header.number.toNumber(), blockHash, {
        typed: [["Email", hex("mover@example.org")]],
        custom: [],
        judgements: [[5, "Reasonable"]],
      }),
      bob,
    );
    expect(await readMigration(mover.address, markers)).toEqual({ state: "imported", source: "Polkadot", block: header.number.toNumber() });
    expect(markers.get(mover.address)).toBeNull();
    // an account migrates once
    const once = await send(await requestMigrationCall("Polkadot"), mover);
    expect(once).toMatchObject({ ok: false });
    expect(["IdentityExists", "AlreadyMigrated"]).toContain(once.errorName);
  }, 240_000);

  it("reads the whole requests page at one block", async () => {
    const user = fresh();
    await ok(await setIdentityCall([{ ref: { typed: "Email" }, value: stringToU8a(`one-${random()}@example.org`) }]), user);
    await ok(await requestJudgementCall(0, { field: { typed: "Email" } }), user);
    const overview = await readOverview(user.address);
    expect(overview.profile?.fields.map((f) => f.id)).toEqual(["typed:Email"]);
    expect(overview.pending.map((r) => targetId(r.target))).toEqual(["typed:Email"]);
    expect(overview.migration).toEqual({ state: "none" });
    expect(overview.times.clock.block).toBeGreaterThan(0);
  }, 120_000);

  it("accepts every call of the authority page from Alice, and reads the answers back", async () => {
    // who is an agent: Alice (all capabilities), not Bob (migration only), not a fresh account
    expect(await readAgent(alice.address)).toEqual({ authority: { id: 0, name: "identitee", active: true }, attest: true, facts: true, names: true });
    expect(await readAgent(keyring.addFromUri("//Bob").address)).toBeNull();
    expect(await readAgent(fresh().address)).toBeNull();

    const user = fresh();
    const email = `agent-${random()}@example.org`;
    const phone = `+33 6 ${random()}`;
    const salt = randomAsU8a(32);
    await ok(
      await setIdentityCall([
        { ref: { typed: "Email" }, value: stringToU8a(email) },
        { ref: { typed: "DisplayName" }, value: stringToU8a("Agent Subject") },
      ]),
      user,
    );
    // a private field written by commitment, as the editor would
    await ok(idt().setField({ Custom: hex("phone") }, { Private: privateCommitment(salt, phone) }), user);
    await ok(await addLinkCall("Site", "https://agent.example"), user);
    for (const target of [{ field: { typed: "Email" } }, { field: { custom: "phone" } }, { field: { link: 0 } }, { fact: "DocumentChecked" }] as const) {
      await ok(await requestJudgementCall(0, target), user);
    }

    // the inbox: the user's four requests, each with what the identity holds
    const mine = (await readInbox(0)).filter((i) => i.who === user.address);
    expect(mine.map((i) => [i.kind, i.label, i.value])).toEqual([
      ["public", "Email", email],
      ["private", "phone", null],
      ["link", "Site", "https://agent.example"],
      ["document", "Identity document", null],
    ]);

    // verify the public field against the commitment read now
    const now = (await commitmentNow(user.address, { typed: "Email" }))!;
    expect(now).toEqual({ commitment: publicCommitment(email), private: false });
    await ok(await provideJudgementCall(user.address, { typed: "Email" }, now.commitment), alice);
    // a stale commitment is refused by the runtime
    const stale = await send(await provideJudgementCall(user.address, { link: 0 }, publicCommitment("old")), alice);
    expect(stale.errorName).toBe("StaleCommitment");

    // the private field: the user's signed packet checks out against the chain, then Alice verifies
    const packet = JSON.stringify(
      await makePacket(
        { chain: api.genesisHash.toHex(), address: user.address, ref: { custom: "phone" }, value: stringToU8a(phone), salt },
        async (data) => u8aToHex(user.sign(u8aWrapBytes(hexToU8a(data)))),
      ),
    );
    expect(await genesisHash()).toBe(api.genesisHash.toHex());
    const checked = await checkPacket(packet, user.address, { custom: "phone" }, await genesisHash(), await readProfile(user.address));
    expect(checked).toEqual({ value: phone, commitment: privateCommitment(salt, phone) });
    await ok(await provideJudgementCall(user.address, { custom: "phone" }, privateCommitment(salt, phone)), alice);

    // reject the link request, record the document
    await ok(await rejectRequestCall(user.address, { field: { link: 0 } }, "ValueMismatch", "not reachable"), alice);
    await ok(await grantFactCall(user.address, "DocumentChecked", "Unspecified", "passport"), alice);
    expect((await readInbox(0)).filter((i) => i.who === user.address)).toEqual([]);
    // a dismissal records nothing; rejecting the value does, and the profile says Rejected
    expect((await readProfile(user.address))!.links[0]).toMatchObject({ verified: false, rejected: false });
    const link = (await commitmentNow(user.address, { link: 0 }))!;
    await ok(await provideJudgementCall(user.address, { link: 0 }, link.commitment, "Rejected"), alice);
    expect((await readProfile(user.address))!.links[0]).toMatchObject({ verified: false, rejected: true });
    const profile = (await readProfile(user.address))!;
    expect(profile.fields.filter((f) => f.verified).map((f) => f.id).sort()).toEqual(["custom:phone", "typed:Email"]);

    // the account as the authority sees it; revoke the document and a verification
    let account = await readAccount(user.address, 0);
    expect(account.facts).toMatchObject({ DocumentChecked: { state: "active" }, Fraud: null });
    await ok(await revokeFactCall(user.address, "DocumentChecked", "UserRequest"), alice);
    await ok(await grantFactCall(user.address, "Fraud", "Impersonation", ""), alice);
    await ok(await revokeFactCall(user.address, "Fraud", "Other"), alice);
    account = await readAccount(user.address, 0);
    expect(account.facts).toMatchObject({ DocumentChecked: { state: "revoked" }, Fraud: { state: "revoked" } });
    await ok(await revokeAttestationCall(user.address, { typed: "Email" }, "UserRequest"), alice);
    expect((await readProfile(user.address))!.fields.find((f) => f.id === "typed:Email")!.verified).toBe(false);

    // names: reserve (a page name too), lift, give a reserved name, take it away
    const name = `agent${random()}`;
    await ok(await reserveUsernameCall(name), alice);
    const page = await send(await reserveUsernameCall("requests"), alice);
    expect(page.ok || page.errorName === "AlreadyReserved").toBe(true);
    expect(await readReserved()).toEqual(expect.arrayContaining([name]));
    await ok(await setUsernameForCall(user.address, name), alice);
    expect(await resolveName(name)).toBe(user.address);
    expect(await readReserved()).not.toContain(name);
    const twice = await send(await setUsernameForCall(user.address, `x${name}`), alice);
    expect(twice.errorName).toBe("AlreadyHasName");
    await ok(await unbindUsernameCall(user.address, "Abuse"), alice);
    expect(await resolveName(name)).toBeNull();
    const lifted = `lift${random()}`;
    await ok(await reserveUsernameCall(lifted), alice);
    await ok(await unreserveUsernameCall(lifted), alice);
    expect(await readReserved()).not.toContain(lifted);

    // a user cannot make an agent call: the pool refuses it as unpaid, which is not the daily limit
    const refused = await send(await reserveUsernameCall(`nope${random()}`), user);
    expect(refused).toMatchObject({ ok: false, errorName: "NotAllowed" });
  }, 300_000);

  it("explains a pallet error in English", async () => {
    const user = fresh();
    await ok(idt().setBio(hex("no verified field")), user);
    const result = await send(idt().claimUsername(hex(`no-${random()}`)), user);
    expect(result).toMatchObject({
      ok: false,
      errorName: "NoVerifiedField",
      error: "Get one field verified before claiming a name.",
    });
    expect(result.events.some((e) => e.method === "ExtrinsicFailed")).toBe(true);
  }, 30_000);

  it("signs through an extension-style signer, which is how wallets sign", async () => {
    const user = fresh();
    let id = 0;
    const signer: Signer = {
      signPayload: async (payload) => {
        const { signature } = api.registry
          .createType("ExtrinsicPayload", payload, { version: payload.version })
          .sign(user);
        return { id: ++id, signature };
      },
    };
    const result = await send(idt().setBio(hex("signed by an extension")), { address: user.address, signer });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(id).toBe(1);
    expect((await readProfile(user.address))!.bio).toBe("signed by an extension");
  }, 30_000);

  it("reports a refusal in the wallet as a cancellation", async () => {
    const user = fresh();
    const signer: Signer = {
      signPayload: async () => {
        throw new Error("Cancelled");
      },
    };
    const result = await send(idt().setBio(hex("never signed")), { address: user.address, signer });
    expect(result).toMatchObject({ ok: false, errorName: "Cancelled", error: "Signing was cancelled." });
  }, 30_000);

  it("refuses the 51st call of the day with the daily limit message", async () => {
    const user = fresh();
    // 50 calls at once, each with its own nonce: they fill the daily quota of the account
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, nonce) => send(idt().setBio(hex(`call ${nonce}`)), user, { nonce })),
    );
    expect(results.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);

    const last = await send(idt().setBio(hex("one too many")), user);
    expect(last).toEqual({
      ok: false,
      events: [],
      errorName: "DailyLimit",
      error: "Daily limit reached. Try again tomorrow.",
    });
  }, 180_000);
});
