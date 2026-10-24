// @vitest-environment happy-dom
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendResult } from "../src/chain/tx.ts";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";
import { fakeChain } from "./support/fake-chain.ts";

// Private fields in the editor, against a fake chain that keeps what the calls do (the real calls
// module builds them, the fake `api.tx` records them) and a wallet that signs with a dev key.
const hooks = vi.hoisted(() => ({ chain: null as unknown as ReturnType<typeof import("./support/fake-chain.ts").fakeChain> }));
const CHAIN_ID = `0x${"12".repeat(32)}`;
vi.mock("../src/chain/api.ts", () => ({ connect: async () => ({ tx: { identitee: hooks.chain.tx }, genesisHash: { toHex: () => CHAIN_ID } }) }));
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/identity.ts")>()),
  readProfile: async () => hooks.chain.profile(),
  identitySecret: async () => hooks.chain.secret(),
}));
vi.mock("../src/chain/tx.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/tx.ts")>()),
  send: async (call: { method: string; args: unknown[] }): Promise<SendResult> => {
    hooks.chain.include(call);
    return { ok: true, events: [], blockHash: "0x01" };
  },
}));

import { privateCommitment } from "../src/chain/formulas.ts";
import { readPacket } from "../src/chain/packet.ts";
import { fieldSalt, openSecret, sealSecret } from "../src/crypto/secret.ts";
import { forgetSecret, keepSecret, unlockedSecret } from "../src/crypto/session.ts";
import { disconnectWallet } from "../src/chain/wallet.ts";
import { MyIdentity } from "../src/pages/me-editor.tsx";

const PASS = "a long enough passphrase";
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
let pair: ReturnType<Keyring["addFromUri"]>;
let ADDR = "";
let sealed: Uint8Array;
const signRaw = vi.fn();
const wallet = { signerFor: async (address: string) => ({ address, signer: { signRaw } }) } as unknown as WalletModule;

beforeAll(async () => {
  await cryptoWaitReady();
  pair = new Keyring({ type: "sr25519", ss58Format: 2426 }).addFromUri("//Ferdie");
  ADDR = pair.address;
  sealed = await sealSecret(SECRET, PASS);
}, 30_000);

let root: HTMLElement | undefined;
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function until(condition: () => boolean, what: string, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(20);
  }
}
const button = (label: string, within: ParentNode = root!): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((b) => text(b) === label || b.getAttribute("aria-label") === label);
const click = async (label: string, within?: ParentNode) => {
  const b = button(label, within);
  if (!b) throw new Error(`no button ${label}`);
  await act(() => b.click());
  await settle();
};
const input = (label: string): HTMLInputElement => {
  const l = [...root!.querySelectorAll("label")].find((x) => text(x) === label);
  if (!l) throw new Error(`no label ${label}`);
  return root!.querySelector<HTMLInputElement>(`#${CSS.escape(l.getAttribute("for")!)}`)!;
};
const type = async (label: string, value: string) => {
  const el = input(label);
  el.value = value;
  await act(() => void el.dispatchEvent(new Event("input", { bubbles: true })));
};
const details = () => root!.querySelector('section[aria-label="Details"]')!;
const row = (label: string) => [...root!.querySelectorAll(".field")].find((r) => text(r.querySelector(".label")) === label)!;
const secretBlock = () => root!.querySelector('[aria-label="Identity secret"]');
const saveBar = () => root!.querySelector(".savebar");
const NEEDS_SECRET = "Unlock or create your identity secret to save a private field.";
/** Save is held back, and the bar says why, while a private value waits for the secret. */
const waitsForSecret = () => {
  expect(text(saveBar()!.querySelector(".problem"))).toBe(NEEDS_SECRET);
  expect(button("Save", saveBar()!)!.disabled).toBe(true);
};
const secretReady = () => {
  expect(saveBar()!.querySelector(".problem")).toBeNull();
  expect(button("Save", saveBar()!)!.disabled).toBe(false);
};

async function open() {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyIdentity address={ADDR} wallet={wallet} />, root!));
  await until(() => root!.querySelector(".editor") !== null, "the editor");
  await settle(10);
}
const close = () => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
};

beforeEach(() => {
  forgetSecret(ADDR);
  signRaw.mockReset();
  signRaw.mockImplementation(async ({ data }: { data: `0x${string}` }) => ({ id: 1, signature: u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data)))) }));
});
afterEach(close);

describe("an account without an identity secret", () => {
  it("is asked to create one before its first private field, and both go in one update_profile", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    await open();
    expect(secretBlock()).toBeNull();
    await type("Email", " me@example.org ");
    await click("Make Email private");
    expect(text(row("Email").querySelector(".hint"))).toBe("Private: only a fingerprint of the value goes on chain.");
    waitsForSecret();
    expect(text(secretBlock())).toContain("Private fields need an identity secret.");
    // a plain button: the one primary action of the form is Save
    expect(button("Create secret")!.classList.contains("primary")).toBe(false);

    await type("Passphrase", "too short");
    await type("Repeat passphrase", "too short");
    await click("Create secret");
    expect(text(secretBlock()!.querySelector(".problem"))).toBe("Use at least 12 characters.");
    await type("Passphrase", PASS);
    await type("Repeat passphrase", `${PASS}!`);
    await click("Create secret");
    expect(text(secretBlock()!.querySelector(".problem"))).toBe("The two passphrases differ.");

    await type("Repeat passphrase", PASS);
    await click("Create secret");
    await until(() => text(secretBlock()).includes("New identity secret, stored with your next Save"), "the new secret");
    // made here, stored nowhere yet: nothing was signed or sent
    expect(hooks.chain.sent).toEqual([]);
    expect(signRaw).not.toHaveBeenCalled();
    expect(hooks.chain.secret()).toBeNull();
    // the passphrase inputs are gone with what was typed in them
    expect(root!.querySelectorAll('input[type="password"]').length).toBe(0);
    secretReady();
    // the field and the secret: two changes
    expect(text(saveBar()!.querySelector(".status"))).toBe("2 changes");

    await click("Save", saveBar()!);
    await until(() => hooks.chain.sent.length === 1, "update_profile");
    expect(hooks.chain.sent.map((c) => c.method)).toEqual(["updateProfile"]);
    const blob = hooks.chain.secret()!;
    expect(blob.length).toBe(89);
    const secret = await openSecret(blob, PASS);
    expect(hooks.chain.sent[0]!.args[0]).toEqual({
      bio: null,
      avatar: null,
      fields: [[{ Typed: "Email" }, { Private: privateCommitment(fieldSalt(secret, { typed: "Email" }), "me@example.org") }]],
      links: null,
      secret: u8aToHex(blob),
    });
    await until(() => text(row("Email").querySelector(".private")) === "Private", "the field shown as private");
    // the secret stays open for the visit
    expect(unlockedSecret(ADDR, blob)).toEqual(secret);
  }, 60_000);

  it("drops a new secret with Undo or Cancel, and sends nothing", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    await open();
    await type("Email", "me@example.org");
    await click("Make Email private");
    await type("Passphrase", PASS);
    await type("Repeat passphrase", PASS);
    await click("Create secret");
    await until(() => text(secretBlock()).includes("stored with your next Save"), "the new secret");
    await click("Undo the new identity secret", secretBlock()!);
    expect(text(secretBlock())).toContain("Private fields need an identity secret.");
    waitsForSecret();

    await type("Passphrase", PASS);
    await type("Repeat passphrase", PASS);
    await click("Create secret");
    await until(() => text(secretBlock()).includes("stored with your next Save"), "the new secret again");
    await click("Cancel", saveBar()!);
    expect(saveBar()).toBeNull();
    expect(input("Email").value).toBe("");
    expect(secretBlock()).toBeNull();
    expect(hooks.chain.sent).toEqual([]);
    expect(hooks.chain.secret()).toBeNull();
  }, 60_000);

  it("does not offer Save while a private value waits for the identity secret, and says why", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    await open();
    await type("Email", "me@example.org");
    await click("Make Email private");
    waitsForSecret();
    // the hint is said once, in the Save bar, not again under the fields
    expect(text(details())).not.toContain(NEEDS_SECRET);
    expect(signRaw).not.toHaveBeenCalled();
    expect(hooks.chain.sent).toEqual([]);
  }, 60_000);
});

describe("an account with an identity secret", () => {
  beforeEach(() => {
    hooks.chain = fakeChain(ADDR);
    hooks.chain.setSecret(sealed);
  });

  it("is asked to unlock it, refused cleanly with a wrong passphrase, then saves with it", async () => {
    await open();
    await click("Make Email private");
    expect(text(secretBlock())).toContain("Enter its passphrase");
    waitsForSecret();
    await click("Unlock");
    expect(text(secretBlock()!.querySelector(".problem"))).toBe("Enter your passphrase.");
    await type("Passphrase", "not the passphrase at all");
    await click("Unlock");
    await until(() => text(secretBlock()!.querySelector(".problem")) === "Wrong passphrase.", "the refusal");
    expect(input("Passphrase").value).toBe("");

    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => text(secretBlock()).includes("Identity secret unlocked"), "the unlock");
    secretReady();
    await click("Save", saveBar()!);
    await until(() => hooks.chain.sent.length === 1, "update_profile");
    // the secret on chain stays as it is: only the field goes
    expect(hooks.chain.sent[0]!.args[0]).toEqual({
      bio: null,
      avatar: null,
      fields: [[{ Typed: "Email" }, { Private: privateCommitment(fieldSalt(SECRET, { typed: "Email" }), "user@example.org") }]],
      links: null,
      secret: null,
    });
  }, 60_000);

  it("keeps the secret unlocked for the visit, in memory, until Lock", async () => {
    await open();
    await click("Make Email private");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => button("Lock the identity secret") !== undefined, "the unlock");
    close();
    await open(); // another page of the same visit
    await click("Make Email private");
    expect(text(secretBlock())).toContain("Identity secret unlocked");
    secretReady();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    await click("Lock the identity secret");
    expect(text(secretBlock())).toContain("Enter its passphrase");
    waitsForSecret();
  }, 60_000);

  it("can be replaced by a new one when the passphrase is forgotten, stored with the fields it salts", async () => {
    await open();
    await click("Make Email private");
    await click("Forgot your passphrase?");
    expect(text(secretBlock())).toContain("A new secret replaces the old one.");
    await type("Passphrase", "a brand new passphrase");
    await type("Repeat passphrase", "a brand new passphrase");
    await click("Create a new secret");
    await until(() => text(secretBlock()).includes("stored with your next Save"), "the new secret");
    expect(hooks.chain.sent).toEqual([]);
    expect(hooks.chain.secret()).toEqual(sealed);

    await click("Save", saveBar()!);
    await until(() => hooks.chain.sent.length === 1, "update_profile");
    await until(() => text(secretBlock()).includes("Identity secret unlocked"), "the new secret kept unlocked");
    const blob = hooks.chain.secret()!;
    const fresh = await openSecret(blob, "a brand new passphrase");
    expect(fresh).not.toEqual(SECRET);
    const update = hooks.chain.sent[0]!.args[0] as { fields: unknown; secret: string };
    expect(update.secret).toBe(u8aToHex(blob));
    // the field is salted by the new secret, not the forgotten one
    expect(update.fields).toEqual([[{ Typed: "Email" }, { Private: privateCommitment(fieldSalt(fresh, { typed: "Email" }), "user@example.org") }]]);
  }, 60_000);

  it("goes back to the secret it had when a replacement is cancelled", async () => {
    await open();
    await click("Make Email private");
    await click("Forgot your passphrase?");
    await type("Passphrase", "a brand new passphrase");
    await type("Repeat passphrase", "a brand new passphrase");
    await click("Create a new secret");
    await until(() => text(secretBlock()).includes("stored with your next Save"), "the new secret");
    await click("Undo the new identity secret", secretBlock()!);
    expect(text(secretBlock())).toContain("Enter its passphrase");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => text(secretBlock()).includes("Identity secret unlocked"), "the old secret unlocked");
    expect(hooks.chain.sent).toEqual([]);
  }, 60_000);
});

describe("a private field on chain", () => {
  const VALUE = "@tg_user";
  beforeEach(() => {
    hooks.chain = fakeChain(ADDR);
    hooks.chain.setSecret(sealed);
    hooks.chain.setPrivate("Telegram", privateCommitment(fieldSalt(SECRET, { typed: "Telegram" }), VALUE));
  });
  const panel = () => root!.querySelector(".panel");
  const enter = (el: HTMLInputElement) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

  it("says in one line that the secret is locked, and Enter in the passphrase unlocks it", async () => {
    await open();
    expect(text(secretBlock()!.querySelector(".status"))).toBe("Identity secret locked");
    expect([...secretBlock()!.querySelectorAll("button")].map((b) => text(b))).toEqual(["Unlock"]);
    expect(root!.querySelector('input[type="password"]')).toBeNull();
    await click("Unlock", secretBlock()!);
    expect(text(secretBlock())).toContain("Enter its passphrase");
    await type("Passphrase", PASS);
    await enter(input("Passphrase"));
    await until(() => text(secretBlock()).includes("Identity secret unlocked"), "the unlock");
    expect(hooks.chain.sent).toEqual([]);
  }, 60_000);

  it("reveals with Enter in the value, as with the Reveal button", async () => {
    await open();
    await click("Reveal Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => panel() !== null, "the reveal panel");
    await type("Value of Telegram", VALUE);
    await enter(input("Value of Telegram"));
    await until(() => hooks.chain.sent.length === 1, "reveal_field");
    expect(hooks.chain.sent[0]!.method).toBe("revealField");
  }, 60_000);

  it("says Copied when the packet is copied, and how to copy it by hand when the browser refuses", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      await open();
      await click("Verification packet for Telegram");
      await type("Passphrase", PASS);
      await click("Unlock");
      await until(() => panel() !== null, "the packet panel");
      await type("Value of Telegram", VALUE);
      await click("Create packet", panel()!);
      await until(() => root!.querySelector("textarea.packet") !== null, "the packet");
      await click("Copy packet", panel()!);
      expect(writeText).toHaveBeenCalledWith(root!.querySelector<HTMLTextAreaElement>("textarea.packet")!.value);
      expect(text(panel()!.querySelector('[role="status"]'))).toBe("Copied");
      expect(panel()!.querySelector(".problem")).toBeNull();
      writeText.mockRejectedValueOnce(new Error("denied"));
      await click("Copy packet", panel()!);
      expect(text(panel()!.querySelector('[role="status"]'))).toBe("Copy failed");
      expect(text(panel()!.querySelector(".problem"))).toBe("Copy failed. Select the packet and copy it by hand.");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it("is revealed once the value typed gives its commitment", async () => {
    await open();
    expect(text(row("Telegram").querySelector(".private"))).toBe("Private");
    await click("Reveal Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => panel() !== null, "the reveal panel");
    await type("Value of Telegram", "@tg_usr");
    await click("Reveal", panel()!);
    expect(text(panel()!.querySelector(".problem"))).toBe("That is not the value of this field, or it was saved with another identity secret.");
    expect(hooks.chain.sent).toEqual([]);

    await type("Value of Telegram", ` ${VALUE} `);
    await click("Reveal", panel()!);
    await until(() => hooks.chain.sent.length === 1, "reveal_field");
    expect(hooks.chain.sent[0]).toEqual({
      method: "revealField",
      args: [{ Typed: "Telegram" }, u8aToHex(stringToU8a(VALUE)), u8aToHex(fieldSalt(SECRET, { typed: "Telegram" }))],
    });
    await until(() => input("Telegram")?.value === VALUE, "the field shown public");
    expect(panel()).toBeNull();
  }, 60_000);

  it("gives a verification packet signed by the wallet, and sends nothing", async () => {
    await open();
    await click("Verification packet for Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => panel() !== null, "the packet panel");
    await type("Value of Telegram", VALUE);
    await click("Create packet", panel()!);
    await until(() => root!.querySelector<HTMLTextAreaElement>("textarea.packet") !== null, "the packet");
    const json = root!.querySelector<HTMLTextAreaElement>("textarea.packet")!.value;
    const read = await readPacket(json);
    if (!("packet" in read)) throw new Error(read.problem);
    expect(read.packet).toMatchObject({ chain: CHAIN_ID, address: ADDR, field: { typed: "Telegram" }, value: VALUE });
    expect(read.packet.commitment).toBe(hooks.chain.profile().fields.find((f) => f.id === "typed:Telegram")!.commitment);
    expect(signRaw).toHaveBeenCalledTimes(1);
    expect(signRaw.mock.calls[0]![0]).toMatchObject({ address: ADDR, type: "bytes" });
    expect(hooks.chain.sent).toEqual([]);
    await click("Done");
    expect(root!.querySelector("textarea.packet")).toBeNull();
  }, 60_000);

  it("says so when the wallet refuses to sign", async () => {
    signRaw.mockRejectedValue(new Error("Cancelled"));
    await open();
    await click("Verification packet for Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => panel() !== null, "the packet panel");
    await type("Value of Telegram", VALUE);
    await click("Create packet", panel()!);
    await until(() => text(panel()!.querySelector(".problem")) !== "", "the refusal");
    expect(text(panel()!.querySelector(".problem"))).toBe("Cancelled in the wallet.");
  }, 60_000);

  it("never shows a wallet's own text, only a sentence of the app or a plain one", async () => {
    signRaw.mockRejectedValue(new Error("Unable to retrieve keypair from the vault."));
    await open();
    await click("Verification packet for Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => panel() !== null, "the packet panel");
    await type("Value of Telegram", VALUE);
    await click("Create packet", panel()!);
    await until(() => text(panel()!.querySelector(".problem")) !== "", "the refusal");
    expect(text(panel()!.querySelector(".problem"))).toBe("The wallet did not sign the packet.");
    // the wallet signs with another account: the app's own sentence says so
    const other = new Keyring({ type: "sr25519", ss58Format: 2426 }).addFromUri("//Dave");
    signRaw.mockImplementation(async ({ data }: { data: `0x${string}` }) => ({ id: 2, signature: u8aToHex(other.sign(u8aWrapBytes(hexToU8a(data)))) }));
    await click("Create packet", panel()!);
    await until(() => text(panel()!.querySelector(".problem")) === "The wallet signed with another account.", "the app's sentence");
  }, 60_000);
});

describe("findings of the review", () => {
  it("forgets an unlocked secret on Disconnect: the same account comes back locked", async () => {
    hooks.chain = fakeChain(ADDR);
    hooks.chain.setSecret(sealed);
    await open();
    await click("Make Email private");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => button("Lock the identity secret") !== undefined, "the unlock");
    expect(unlockedSecret(ADDR, sealed)).not.toBeNull();
    close();
    disconnectWallet();
    expect(unlockedSecret(ADDR, sealed)).toBeNull();
    await open(); // connected again with the same account
    await click("Make Email private");
    expect(text(secretBlock())).toContain("Enter its passphrase");
    waitsForSecret();
  }, 60_000);

  it("forgets it when another account is chosen", async () => {
    const other = new Keyring({ type: "sr25519", ss58Format: 2426 }).addFromUri("//Dave");
    const accounts = [
      { address: ADDR, name: "one", type: "sr25519" },
      { address: other.address, name: "two", type: "sr25519" },
    ];
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = {
      "polkadot-js": {
        version: "1.0.0",
        enable: async () => ({ accounts: { get: async () => accounts, subscribe: (cb: (a: unknown) => void) => (cb(accounts), () => undefined) }, signer: {} }),
      },
    };
    const { listAccounts, selectAccount } = await import("../src/chain/wallet.ts");
    await listAccounts();
    selectAccount(ADDR);
    keepSecret(ADDR, sealed, SECRET);
    selectAccount(ADDR); // the same account again: nothing changes
    expect(unlockedSecret(ADDR, sealed)).not.toBeNull();
    selectAccount(other.address);
    expect(unlockedSecret(ADDR, sealed)).toBeNull();
    disconnectWallet();
  });

  it("tells an account with private fields but no secret that a new secret leaves them unprovable", async () => {
    hooks.chain = fakeChain(ADDR); // the fixture has a private Telegram, and no secret is stored
    await open();
    await click("Make Email private");
    expect(text(secretBlock())).toContain("Private fields saved without it can no longer be revealed or verified");
    // and a public field made private says that its old value stays in the history
    expect(text(row("Email"))).toContain("Its public value stays in the chain's history");
  }, 60_000);

  it("does not overwrite a secret stored meanwhile from another device, and asks to unlock it", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    await open();
    await type("Email", "me@example.org");
    await click("Make Email private");
    hooks.chain.setSecret(sealed); // another device, after this page read the chain
    await type("Passphrase", "a new passphrase here");
    await type("Repeat passphrase", "a new passphrase here");
    await click("Create secret");
    await until(() => text(secretBlock()).includes("Enter its passphrase"), "the unlock phase");
    expect(hooks.chain.sent).toEqual([]);
    expect(hooks.chain.secret()).toEqual(sealed);
    // and Save cannot store a secret either: none is waiting
    waitsForSecret();
    expect(hooks.chain.sent).toEqual([]);
  }, 60_000);

  it("says why it asks to unlock: a secret was saved meanwhile from another device", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    await open();
    await type("Email", "me@example.org");
    await click("Make Email private");
    hooks.chain.setSecret(sealed);
    await type("Passphrase", "a new passphrase here");
    await type("Repeat passphrase", "a new passphrase here");
    await click("Create secret");
    await until(() => text(secretBlock()).includes("Enter its passphrase"), "the unlock phase");
    expect(text(secretBlock())).toContain("An identity secret was saved meanwhile, from another device.");
  }, 60_000);

  it("says on the packet that the field should not hold another private value", async () => {
    hooks.chain = fakeChain(ADDR);
    hooks.chain.setSecret(sealed);
    hooks.chain.setPrivate("Telegram", privateCommitment(fieldSalt(SECRET, { typed: "Telegram" }), "@tg"));
    await open();
    await click("Verification packet for Telegram");
    await type("Passphrase", PASS);
    await click("Unlock");
    await until(() => root!.querySelector(".panel") !== null, "the panel");
    await type("Value of Telegram", "@tg");
    await click("Create packet", root!.querySelector(".panel")!);
    await until(() => root!.querySelector("textarea.packet") !== null, "the packet");
    expect(text(root!.querySelector(".panel"))).toContain("do not keep another private value in this field");
  }, 60_000);
});
