import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The calls are built against a stand-in for polkadot.js that records what it is given.
const tx: Record<string, ReturnType<typeof vi.fn>> = {};
const names = [
  "setIdentitySecret",
  "revealField",
  "setIdentity",
  "updateProfile",
  "setBio",
  "addLink",
  "updateLink",
  "removeLink",
  "reorderLinks",
  "setAvatar",
  "clearAvatar",
  "requestJudgement",
  "cancelRequest",
  "claimUsername",
  "releaseUsername",
  "addSub",
  "acceptSub",
  "declineSub",
  "removeSub",
  "quitSub",
  "renameSub",
  "requestMigration",
  "cancelMigration",
  "provideJudgement",
  "rejectRequest",
  "revokeAttestation",
  "grantFact",
  "revokeFact",
  "reserveUsername",
  "unreserveUsername",
  "setUsernameFor",
  "unbindUsername",
];
vi.mock("../src/chain/api.ts", () => ({ connect: async () => ({ tx: { identitee: tx } }) }));

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
  avatarChange,
  updateProfileCall,
  updateSize,
  grantFactCall,
  provideJudgementCall,
  REASONS,
  rejectRequestCall,
  reserveUsernameCall,
  revokeAttestationCall,
  revokeFactCall,
  setUsernameForCall,
  unbindUsernameCall,
  unreserveUsernameCall,
} from "../src/chain/calls.ts";
import { Refusal } from "../src/chain/refusal.ts";
import { privateCommitment } from "../src/chain/formulas.ts";
import { fieldSalt } from "../src/crypto/secret.ts";

const text = (s: string) => new TextEncoder().encode(s);
const fixtures = join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures");
const LOSSY = new Uint8Array(readFileSync(join(fixtures, "avatar-64-lossy.webp")));

beforeEach(() => {
  for (const name of names) tx[name] = vi.fn((...args: unknown[]) => ({ name, args }));
});

describe("the editor's calls", () => {
  it("put every field change in one set_identity", async () => {
    const call = await setIdentityCall([
      { ref: { typed: "DisplayName" }, value: text("Ada") },
      { ref: { custom: "mastodon" }, value: text("@ada") },
      { ref: { typed: "Email" }, value: null },
    ]);
    expect(tx.setIdentity).toHaveBeenCalledTimes(1);
    expect(call).toEqual({
      name: "setIdentity",
      args: [
        [
          [{ Typed: "DisplayName" }, { Public: "0x416461" }],
          [{ Custom: "0x6d6173746f646f6e" }, { Public: "0x40616461" }],
          [{ Typed: "Email" }, null],
        ],
      ],
    });
  });

  it("refuse an empty or oversized set_identity rather than send it", async () => {
    await expect(setIdentityCall([])).rejects.toThrow("There is nothing to save.");
    const many = Array.from({ length: 33 }, (_, i) => ({ ref: { custom: `k${i}` }, value: text("v") }));
    await expect(setIdentityCall(many)).rejects.toThrow("Too many changes at once.");
    expect(tx.setIdentity).not.toHaveBeenCalled();
  });

  it("send the bio trimmed, as hexadecimal of its UTF-8", async () => {
    await setBioCall("  café \n");
    expect(tx.setBio).toHaveBeenCalledWith("0x636166c3a9");
    await setBioCall("");
    expect(tx.setBio).toHaveBeenLastCalledWith("0x");
  });

  it("send a link with a trimmed title and an address that starts with https://", async () => {
    await addLinkCall(" Blog ", " example.org/me ");
    expect(tx.addLink).toHaveBeenCalledWith("0x426c6f67", "0x68747470733a2f2f6578616d706c652e6f72672f6d65");
    await updateLinkCall(7, "Blog", "http://example.org");
    expect(tx.updateLink).toHaveBeenCalledWith(7, "0x426c6f67", "0x687474703a2f2f6578616d706c652e6f7267");
  });

  it("remove and reorder links by their ids", async () => {
    await removeLinkCall(4);
    expect(tx.removeLink).toHaveBeenCalledWith(4);
    await reorderLinksCall([3, 1, 2]);
    expect(tx.reorderLinks).toHaveBeenCalledWith([3, 1, 2]);
  });

  it("send the avatar bytes, and clear it", async () => {
    await setAvatarCall(LOSSY);
    expect(tx.setAvatar).toHaveBeenCalledWith(`0x${Buffer.from(LOSSY).toString("hex")}`);
    await clearAvatarCall();
    expect(tx.clearAvatar).toHaveBeenCalledWith();
  });

  it("refuse an avatar the runtime would refuse, with a sentence, before anything is built", async () => {
    const png = new Uint8Array(readFileSync(join(fixtures, "avatar-64.png")));
    const big = new Uint8Array(9000);
    big.set(LOSSY);
    const wide = new Uint8Array(readFileSync(join(fixtures, "avatar-65x64.webp")));
    for (const [bytes, reason] of [
      [png, "not-webp"],
      [big, "too-large"],
      [wide, "bad-size"],
      [new Uint8Array(), "truncated"],
    ] as const) {
      await expect(setAvatarCall(bytes)).rejects.toMatchObject({ name: "AvatarError", reason });
    }
    expect(tx.setAvatar).not.toHaveBeenCalled();
  });

  it("never ask for a fee: no payment info is read", async () => {
    const call = (await setBioCall("x")) as unknown as Record<string, unknown>;
    expect(call.paymentInfo).toBeUndefined();
    const source = (await import("node:fs")).readFileSync(new URL("../src/chain/calls.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/paymentInfo|queryInfo|partialFee|getBalance|freeBalance/);
  });
});

describe("update_profile", () => {
  const hex = (s: string) => `0x${Buffer.from(s, "utf8").toString("hex")}`;
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  it("put the bio, the avatar, the fields, the links and a new secret in one call, in the chain's shapes", async () => {
    const blob = Uint8Array.from({ length: 89 }, (_, i) => i);
    const call = await updateProfileCall(
      {
        bio: "  café \n",
        avatar: LOSSY,
        fields: [
          { ref: { typed: "DisplayName" }, value: text("Ada") },
          { ref: { custom: "mastodon" }, value: null },
          { ref: { typed: "Email" }, value: text("me@example.org"), private: true },
        ],
        links: [{ keep: 3 }, { update: 1, title: " Code ", url: " git.example/ada " }, { add: true, title: "Blog", url: "http://blog.example" }],
        secretBlob: blob,
      },
      secret,
    );
    expect(tx.updateProfile).toHaveBeenCalledTimes(1);
    expect(call).toEqual({
      name: "updateProfile",
      args: [
        {
          bio: "0x636166c3a9",
          avatar: avatarChange(LOSSY),
          fields: [
            [{ Typed: "DisplayName" }, { Public: "0x416461" }],
            [{ Custom: "0x6d6173746f646f6e" }, null],
            [{ Typed: "Email" }, { Private: privateCommitment(fieldSalt(secret, { typed: "Email" }), "me@example.org") }],
          ],
          links: [
            { Keep: 3 },
            { Update: { id: 1, title: hex("Code"), url: hex("https://git.example/ada") } },
            { Add: { title: hex("Blog"), url: hex("http://blog.example") } },
          ],
          secret: `0x${Buffer.from(blob).toString("hex")}`,
        },
      ],
    });
    // nothing of the private value goes out
    expect(JSON.stringify(call)).not.toContain(Buffer.from("me@example.org").toString("hex"));
  });

  it("keep with null what is not changed, remove the avatar with None, and empty the links with an empty list", async () => {
    await updateProfileCall({ fields: [], avatar: null });
    expect(tx.updateProfile).toHaveBeenLastCalledWith({ bio: null, avatar: avatarChange(null), fields: [], links: null, secret: null });
    await updateProfileCall({ fields: [], bio: "" });
    expect(tx.updateProfile).toHaveBeenLastCalledWith({ bio: "0x", avatar: null, fields: [], links: null, secret: null });
    await updateProfileCall({ fields: [], links: [] });
    expect(tx.updateProfile).toHaveBeenLastCalledWith({ bio: null, avatar: null, fields: [], links: [], secret: null });
  });

  it("refuse what the runtime would refuse, with a sentence, before anything is built", async () => {
    await expect(updateProfileCall({ fields: [] })).rejects.toThrow("There is nothing to save.");
    const many = Array.from({ length: 33 }, (_, i) => ({ ref: { custom: `k${i}` }, value: text("v") }));
    await expect(updateProfileCall({ fields: many })).rejects.toThrow("Too many changes at once.");
    const privately = [{ ref: { typed: "Email" as const }, value: text("me@example.org"), private: true as const }];
    await expect(updateProfileCall({ fields: privately })).rejects.toThrow("Unlock your identity secret first.");
    await expect(updateProfileCall({ fields: privately }, null)).rejects.toThrow("Unlock your identity secret first.");
    const links = Array.from({ length: 17 }, (_, i) => ({ keep: i }));
    await expect(updateProfileCall({ fields: [], links })).rejects.toThrow("You have reached the limit of links.");
    await expect(updateProfileCall({ fields: [], avatar: new Uint8Array(9000) })).rejects.toMatchObject({ name: "AvatarError", reason: "too-large" });
    await expect(updateProfileCall({ fields: [], secretBlob: new Uint8Array(257) })).rejects.toThrow("The encrypted secret has the wrong size.");
    expect(tx.updateProfile).not.toHaveBeenCalled();
  });

  it("count one change per part, and one per field, for the Save button", () => {
    expect(updateSize({ fields: [] })).toBe(0);
    expect(updateSize({ fields: [], bio: "" })).toBe(1);
    expect(updateSize({ fields: [], avatar: null })).toBe(1);
    expect(updateSize({ fields: [], avatar: LOSSY })).toBe(1);
    // the links count as one, however many of them change, and so does an empty list
    expect(updateSize({ fields: [], links: [] })).toBe(1);
    expect(updateSize({ fields: [], links: [{ keep: 1 }, { add: true, title: "a", url: "b" }] })).toBe(1);
    expect(updateSize({ fields: [], secretBlob: new Uint8Array(89) })).toBe(1);
    const fields = [
      { ref: { typed: "Email" as const }, value: null },
      { ref: { custom: "x" }, value: text("y") },
    ];
    expect(updateSize({ bio: "b", avatar: null, fields, links: [], secretBlob: new Uint8Array(1) })).toBe(6);
  });
});

describe("private fields and the identity secret", () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const value = text("me@example.org");

  it("send a private field as the commitment under its derived salt, and nothing of the value", async () => {
    const call = await setIdentityCall([{ ref: { typed: "Email" }, value, private: true }, { ref: { typed: "DisplayName" }, value: text("Ada") }], secret);
    const commitment = privateCommitment(fieldSalt(secret, { typed: "Email" }), value);
    expect(call).toEqual({
      name: "setIdentity",
      args: [
        [
          [{ Typed: "Email" }, { Private: commitment }],
          [{ Typed: "DisplayName" }, { Public: "0x416461" }],
        ],
      ],
    });
    const sent = JSON.stringify(call);
    expect(sent).not.toContain("6d65406578616d706c652e6f7267"); // the value's hex
    expect(sent).not.toContain("me@example.org");
  });

  it("refuse a private field without the secret rather than send it", async () => {
    await expect(setIdentityCall([{ ref: { typed: "Email" }, value, private: true }])).rejects.toThrow("Unlock your identity secret first.");
    expect(tx.setIdentity).not.toHaveBeenCalled();
  });

  it("store the encrypted secret as it is, 1 to 256 bytes", async () => {
    const blob = Uint8Array.from({ length: 89 }, (_, i) => i);
    await setIdentitySecretCall(blob);
    expect(tx.setIdentitySecret).toHaveBeenCalledWith(`0x${Buffer.from(blob).toString("hex")}`);
    await expect(setIdentitySecretCall(new Uint8Array())).rejects.toThrow();
    await expect(setIdentitySecretCall(new Uint8Array(257))).rejects.toThrow();
    expect(tx.setIdentitySecret).toHaveBeenCalledTimes(1);
  });

  it("reveal a field with its key, its value and its salt", async () => {
    const salt = fieldSalt(secret, { custom: "phone" });
    await revealFieldCall({ custom: "phone" }, value, salt);
    expect(tx.revealField).toHaveBeenCalledWith({ Custom: "0x70686f6e65" }, "0x6d65406578616d706c652e6f7267", `0x${Buffer.from(salt).toString("hex")}`);
    await expect(revealFieldCall({ custom: "phone" }, value, new Uint8Array(31))).rejects.toThrow();
  });
});

describe("the calls of the requests page", () => {
  const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";

  it("ask authority 0 to check a field, a custom field, a link or a fact, in the chain's shapes", async () => {
    await requestJudgementCall(0, { field: { typed: "Email" } });
    expect(tx.requestJudgement).toHaveBeenLastCalledWith(0, { Field: { Typed: "Email" } });
    await requestJudgementCall(0, { field: { custom: "mastodon" } });
    expect(tx.requestJudgement).toHaveBeenLastCalledWith(0, { Field: { Custom: "0x6d6173746f646f6e" } });
    await requestJudgementCall(0, { field: { link: 3 } });
    expect(tx.requestJudgement).toHaveBeenLastCalledWith(0, { Field: { Link: 3 } });
    await requestJudgementCall(0, { fact: "DocumentChecked" });
    expect(tx.requestJudgement).toHaveBeenLastCalledWith(0, { Fact: "DocumentChecked" });
  });

  it("withdraw a request with the same target and the authority it was made to", async () => {
    await cancelRequestCall(2, { field: { typed: "Matrix" } });
    expect(tx.cancelRequest).toHaveBeenCalledWith(2, { Field: { Typed: "Matrix" } });
    await cancelRequestCall(0, { fact: "DocumentChecked" });
    expect(tx.cancelRequest).toHaveBeenLastCalledWith(0, { Fact: "DocumentChecked" });
  });

  it("claim a name as the hexadecimal of its bytes, and release it", async () => {
    await claimUsernameCall("ada-l");
    expect(tx.claimUsername).toHaveBeenCalledWith("0x6164612d6c");
    await releaseUsernameCall();
    expect(tx.releaseUsername).toHaveBeenCalledWith();
  });

  it("refuse a name that cannot exist, or that is a page of the app, before anything is built", async () => {
    await expect(claimUsernameCall("ab")).rejects.toThrow("Names have at least 3 characters.");
    await expect(claimUsernameCall("Ada")).rejects.toThrow("Names use only");
    await expect(claimUsernameCall("requests")).rejects.toThrow("cannot be taken");
    await expect(claimUsernameCall("authority")).rejects.toThrow("cannot be taken");
    expect(tx.claimUsername).not.toHaveBeenCalled();
  });

  it("propose a sub-account by its public key, with a trimmed label, whatever the prefix of the address", async () => {
    const { encodeAddress } = await import("@polkadot/util-crypto");
    const { publicKeyHex, publicKeyOf } = await import("../src/chain/address.ts");
    const key = publicKeyHex(PARENT);
    await addSubCall(PARENT, " work laptop ");
    expect(tx.addSub).toHaveBeenLastCalledWith(key, "0x776f726b206c6170746f70");
    await addSubCall(encodeAddress(publicKeyOf(PARENT), 42), "");
    expect(tx.addSub).toHaveBeenLastCalledWith(key, "0x");
  });

  it("refuse a proposal the runtime would refuse: a bad address, a label over 64 bytes", async () => {
    await expect(addSubCall("nonsense", "x")).rejects.toThrow("That is not a valid account address.");
    await expect(addSubCall(PARENT, "x".repeat(65))).rejects.toThrow("A label has at most 64 bytes");
    expect(tx.addSub).not.toHaveBeenCalled();
  });

  it("answer, remove, leave and rename by account key", async () => {
    const { publicKeyHex } = await import("../src/chain/address.ts");
    const key = publicKeyHex(PARENT);
    await acceptSubCall(PARENT);
    expect(tx.acceptSub).toHaveBeenCalledWith(key);
    await declineSubCall(PARENT);
    expect(tx.declineSub).toHaveBeenCalledWith(key);
    await removeSubCall(PARENT);
    expect(tx.removeSub).toHaveBeenCalledWith(key);
    await quitSubCall();
    expect(tx.quitSub).toHaveBeenCalledWith();
    await renameSubCall(PARENT, " phone ");
    expect(tx.renameSub).toHaveBeenCalledWith(key, "0x70686f6e65");
    await expect(renameSubCall(PARENT, "x".repeat(65))).rejects.toThrow("A label has at most 64 bytes");
    expect(tx.renameSub).toHaveBeenCalledTimes(1);
  });

  it("ask for a migration from Polkadot or Kusama, and withdraw it", async () => {
    await requestMigrationCall("Polkadot");
    expect(tx.requestMigration).toHaveBeenLastCalledWith("Polkadot");
    await requestMigrationCall("Kusama");
    expect(tx.requestMigration).toHaveBeenLastCalledWith("Kusama");
    await expect(requestMigrationCall("Westend" as never)).rejects.toThrow("Choose Polkadot or Kusama.");
    expect(tx.requestMigration).toHaveBeenCalledTimes(2);
    await cancelMigrationCall();
    expect(tx.cancelMigration).toHaveBeenCalledWith();
  });

  it("never ask for a fee", () => {
    const source = readFileSync(new URL("../src/chain/calls.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/paymentInfo|queryInfo|partialFee|getBalance|freeBalance/);
  });
});

describe("the calls of an authority agent", () => {
  const WHO = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
  const C = `0x${"ab".repeat(32)}` as const;
  const key = async () => (await import("../src/chain/address.ts")).publicKeyHex(WHO);

  it("verify a field, a custom field or a link against the commitment given, by hand, for good", async () => {
    await provideJudgementCall(WHO, { typed: "Email" }, C);
    expect(tx.provideJudgement).toHaveBeenLastCalledWith(await key(), { Typed: "Email" }, C, "Verified", "Manual", null);
    await provideJudgementCall(WHO, { custom: "phone" }, C);
    expect(tx.provideJudgement).toHaveBeenLastCalledWith(await key(), { Custom: "0x70686f6e65" }, C, "Verified", "Manual", null);
    await provideJudgementCall(WHO, { link: 2 }, C);
    expect(tx.provideJudgement).toHaveBeenLastCalledWith(await key(), { Link: 2 }, C, "Verified", "Manual", null);
    await expect(provideJudgementCall(WHO, { link: 2 }, "0x12" as never)).rejects.toThrow(Refusal);
    expect(tx.provideJudgement).toHaveBeenCalledTimes(3);
    await provideJudgementCall(WHO, { typed: "Email" }, C, "Rejected");
    expect(tx.provideJudgement).toHaveBeenLastCalledWith(await key(), { Typed: "Email" }, C, "Rejected", "Manual", null);
    await expect(provideJudgementCall(WHO, { typed: "Email" }, C, "Maybe" as never)).rejects.toThrow("Choose a verdict.");
  });

  it("reject a request with a reason and a trimmed note of at most 128 bytes", async () => {
    await rejectRequestCall(WHO, { field: { typed: "Email" } }, "Disposable", " temporary inbox ");
    expect(tx.rejectRequest).toHaveBeenLastCalledWith(await key(), { Field: { Typed: "Email" } }, "Disposable", "0x74656d706f7261727920696e626f78");
    await rejectRequestCall(WHO, { fact: "DocumentChecked" }, "DocumentInvalid", "");
    expect(tx.rejectRequest).toHaveBeenLastCalledWith(await key(), { Fact: "DocumentChecked" }, "DocumentInvalid", "0x");
    await expect(rejectRequestCall(WHO, { fact: "Fraud" }, "Other", "é".repeat(65))).rejects.toThrow("A note has at most 128 bytes.");
    await expect(rejectRequestCall(WHO, { fact: "Fraud" }, "Whatever" as never, "")).rejects.toThrow("Choose a reason.");
    await expect(rejectRequestCall("nonsense", { fact: "Fraud" }, "Other", "")).rejects.toThrow("That is not a valid account address.");
    expect(tx.rejectRequest).toHaveBeenCalledTimes(2);
  });

  it("revoke a verification, grant and revoke facts with no end date", async () => {
    await revokeAttestationCall(WHO, { link: 4 }, "UserRequest");
    expect(tx.revokeAttestation).toHaveBeenLastCalledWith(await key(), { Link: 4 }, "UserRequest");
    await grantFactCall(WHO, "DocumentChecked", "Unspecified", "passport");
    expect(tx.grantFact).toHaveBeenLastCalledWith(await key(), "DocumentChecked", null, "Unspecified", "0x70617373706f7274");
    await grantFactCall(WHO, "Fraud", "Impersonation", "");
    expect(tx.grantFact).toHaveBeenLastCalledWith(await key(), "Fraud", null, "Impersonation", "0x");
    await revokeFactCall(WHO, "Fraud", "Other");
    expect(tx.revokeFact).toHaveBeenLastCalledWith(await key(), "Fraud", "Other");
  });

  it("reserve and free any name the runtime accepts, the pages of the app included", async () => {
    await reserveUsernameCall("requests");
    expect(tx.reserveUsername).toHaveBeenLastCalledWith("0x7265717565737473");
    await unreserveUsernameCall("authority");
    expect(tx.unreserveUsername).toHaveBeenLastCalledWith("0x617574686f72697479");
    await expect(reserveUsernameCall("Ab")).rejects.toThrow("Names use only");
    await expect(unreserveUsernameCall("x".repeat(33))).rejects.toThrow("Names have at most 32 characters.");
    expect(tx.reserveUsername).toHaveBeenCalledTimes(1);
  });

  it("give a name to an account, but not the name of a page, and take a name away with a reason", async () => {
    await setUsernameForCall(WHO, "ada");
    expect(tx.setUsernameFor).toHaveBeenLastCalledWith(await key(), "0x616461");
    await expect(setUsernameForCall(WHO, "requests")).rejects.toThrow("cannot be taken");
    expect(tx.setUsernameFor).toHaveBeenCalledTimes(1);
    await unbindUsernameCall(WHO, "Impersonation");
    expect(tx.unbindUsername).toHaveBeenLastCalledWith(await key(), "Impersonation");
  });

  it("know every reason the runtime knows, and no other", () => {
    const types = readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "src", "types.rs"), "utf8");
    const body = /pub enum ReasonCode \{([^}]*)\}/.exec(types)![1]!;
    const variants = [...body.matchAll(/^\s*([A-Z]\w*),/gm)].map((m) => m[1]);
    expect(Object.keys(REASONS)).toEqual(variants);
  });

  it("throw the app's sentences as Refusal, which a page shows as they are", async () => {
    await expect(claimUsernameCall("ab")).rejects.toBeInstanceOf(Refusal);
    await expect(addSubCall("nonsense", "")).rejects.toBeInstanceOf(Refusal);
  });
});

describe("avatarChange", () => {
  // polkadot.js reads an object or a nested Option given for Option<Option<Bytes>> as the outer
  // one: the bytes must decode, as the chain will, to "set" and to "remove"
  it("encodes set and remove so that they decode as Some(Some(bytes)) and Some(None)", async () => {
    const { TypeRegistry } = await import("@polkadot/types");
    const registry = new TypeRegistry();
    const image = new Uint8Array([1, 2, 3, 250]);
    const set = registry.createType("Option<Option<Bytes>>", avatarChange(image));
    expect(set.isSome && set.unwrap().isSome).toBe(true);
    expect([...set.unwrap().unwrap().toU8a(true)]).toEqual([...image]);
    const removed = registry.createType("Option<Option<Bytes>>", avatarChange(null));
    expect(removed.isSome && removed.unwrap().isNone).toBe(true);
  });
});
