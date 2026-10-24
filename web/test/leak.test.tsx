// @vitest-environment happy-dom
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SendResult } from "../src/chain/tx.ts";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";
import { fakeChain } from "./support/fake-chain.ts";

// No private value, salt, identity secret or passphrase may leave the page except as a commitment
// or inside the encrypted blob: not to the network, not to storage, not to the console, not to the
// URL. This test runs the whole private-field flow (create the secret, save private fields, reload,
// unlock, make a verification packet) with every way out watched, then looks for those bytes in
// everything that went out, as text, hexadecimal, base64 and lists of numbers.

const hooks = vi.hoisted(() => ({ chain: null as unknown as ReturnType<typeof import("./support/fake-chain.ts").fakeChain> }));
vi.mock("../src/chain/api.ts", () => ({ connect: async () => ({ tx: { identitee: hooks.chain.tx }, genesisHash: { toHex: () => `0x${"34".repeat(32)}` } }) }));
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
import { fieldSalt, openSecret } from "../src/crypto/secret.ts";
import { forgetSecret } from "../src/crypto/session.ts";
import { MyIdentity } from "../src/pages/me-editor.tsx";

const PASS = "canary passphrase 4242 zebra";
const EMAIL = "canary.value.7781@example.org";
const PHONE = "+33 6 99 88 77 66 canary";

// --- What went out ------------------------------------------------------------------------------

/** Everything that left the page, as text. */
const out: { channel: string; text: string }[] = [];

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
    return `${u8aToHex(bytes)} ${Array.from(bytes).join(",")} ${Buffer.from(bytes).toString("base64")}`;
  }
  try {
    return JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? show(v) : v)) ?? String(value);
  } catch {
    return String(value);
  }
}
const record = (channel: string, ...values: unknown[]) => out.push({ channel, text: values.map(show).join(" ") });

/** Every form a secret byte string can take in what is recorded. */
function forms(bytes: Uint8Array): string[] {
  const hex = u8aToHex(bytes).slice(2);
  const found = [hex, hex.toUpperCase(), Array.from(bytes).join(","), Array.from(bytes).join(", ")];
  // base64 of the bytes at the three alignments they can have inside a longer encoded text
  for (let shift = 0; shift < 3; shift++) {
    const b64 = Buffer.from(bytes.subarray(shift)).toString("base64").replace(/=+$/, "");
    found.push(b64.slice(0, -2), Buffer.from(bytes.subarray(shift)).toString("base64url").slice(0, -2));
  }
  return found;
}
const textForms = (text: string): string[] => [text, encodeURIComponent(text), JSON.stringify(text).slice(1, -1), ...forms(stringToU8a(text))];

function leaks(needles: Record<string, string[]>): string[] {
  const found: string[] = [];
  for (const [name, list] of Object.entries(needles)) {
    for (const needle of list) {
      for (const { channel, text } of out) if (text.includes(needle)) found.push(`${name} in ${channel} (as ${needle.slice(0, 24)}...)`);
    }
  }
  return found;
}

function watchEverything() {
  const wrap = <T extends object>(target: T | undefined, name: keyof T & string, channel: string) => {
    if (!target || typeof target[name] !== "function") return;
    const original = target[name] as (...args: unknown[]) => unknown;
    vi.spyOn(target as any, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      record(channel, ...args);
      return original.apply(this, args);
    });
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => record(`console.${method}`, ...args));
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args: unknown[]) => {
    record("fetch", ...args);
    throw new Error("no network in this test");
  });
  wrap(globalThis.XMLHttpRequest?.prototype, "open", "XMLHttpRequest.open");
  wrap(globalThis.XMLHttpRequest?.prototype, "send", "XMLHttpRequest.send");
  wrap(globalThis.WebSocket?.prototype, "send", "WebSocket.send");
  if (globalThis.WebSocket) {
    const Real = globalThis.WebSocket;
    vi.stubGlobal(
      "WebSocket",
      class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          record("new WebSocket", String(url));
          super(url, protocols);
        }
      },
    );
  }
  wrap(navigator, "sendBeacon", "sendBeacon");
  wrap(Storage.prototype, "setItem", "Storage.setItem");
  wrap(globalThis.indexedDB, "open", "indexedDB.open");
  wrap(history, "pushState", "history.pushState");
  wrap(history, "replaceState", "history.replaceState");
  wrap(globalThis.BroadcastChannel?.prototype, "postMessage", "BroadcastChannel.postMessage");
  wrap(window, "postMessage", "window.postMessage");
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (cookie?.set) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookie.get!.call(document),
      set: (v: string) => {
        record("document.cookie", v);
        cookie.set!.call(document, v);
      },
    });
  }
}

// --- The page -----------------------------------------------------------------------------------

let pair: ReturnType<Keyring["addFromUri"]>;
let ADDR = "";
const wallet = {
  signerFor: async (address: string) => ({
    address,
    signer: { signRaw: async ({ data }: { data: `0x${string}` }) => ({ id: 1, signature: u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data)))) }) },
  }),
} as unknown as WalletModule;

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
const button = (label: string, within: ParentNode = root!) =>
  [...within.querySelectorAll("button")].find((b) => text(b) === label || b.getAttribute("aria-label") === label);
const click = async (label: string, within?: ParentNode) => {
  const b = button(label, within);
  if (!b) throw new Error(`no button ${label}`);
  await act(() => b.click());
  await settle();
};
const field = (label: string, within: ParentNode = root!): HTMLInputElement => {
  const l = [...within.querySelectorAll("label")].find((x) => text(x) === label)!;
  return root!.querySelector<HTMLInputElement>(`#${CSS.escape(l.getAttribute("for")!)}`)!;
};
const type = async (el: HTMLInputElement, value: string) => {
  el.value = value;
  await act(() => void el.dispatchEvent(new Event("input", { bubbles: true })));
};
async function open() {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyIdentity address={ADDR} wallet={wallet} />, root!));
  await until(() => root!.querySelector(".editor") !== null, "the editor");
}
function close() {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
}

beforeAll(async () => {
  await cryptoWaitReady();
  pair = new Keyring({ type: "sr25519", ss58Format: 2426 }).addFromUri("//Eve");
  ADDR = pair.address;
});
afterAll(() => {
  close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a private field's way through the page", () => {
  it("leaves no value, salt, secret or passphrase anywhere but in its commitment and the blob", async () => {
    hooks.chain = fakeChain(ADDR, { empty: true });
    watchEverything();
    const urlBefore = location.href;

    // 1. no secret yet: create one, and save it with two private fields
    await open();
    await type(field("Email"), EMAIL);
    await click("Make Email private");
    await type(field("Passphrase"), PASS);
    await type(field("Repeat passphrase"), PASS);
    await click("Create secret");
    await until(() => text(root!.querySelector('[aria-label="Identity secret"]')).includes("stored with your next Save"), "the secret");
    await type(root!.querySelector<HTMLInputElement>('[aria-label="Name of a new field"]')!, "phone");
    await type(root!.querySelector<HTMLInputElement>('[aria-label="Value of a new field"]')!, PHONE);
    await click("Add field");
    await click("Make phone private");
    // the secret and both fields go in one update_profile
    await click("Save", root!.querySelector(".savebar")!);
    await until(() => hooks.chain.sent.length === 1, "update_profile");
    await until(() => button("Lock the identity secret") !== undefined, "the secret kept unlocked");

    // 2. reload: the page forgets the secret; unlock it again and make a verification packet
    close();
    forgetSecret(ADDR);
    await open();
    await click("Verification packet for Email");
    await type(field("Passphrase"), PASS);
    await click("Unlock");
    await until(() => root!.querySelector(".panel") !== null, "the unlock");
    await type(field("Value of Email"), EMAIL);
    await click("Create packet", root!.querySelector(".panel")!);
    await until(() => root!.querySelector("textarea.packet") !== null, "the packet");
    await click("Done");
    close();

    // what the chain was given is all that went to the network (the fake api.tx stands for it)
    for (const call of hooks.chain.sent) record(`chain call ${call.method}`, call.args);
    record("URL", location.href, document.title);

    const blob = hooks.chain.secret()!;
    const secret = await openSecret(blob, PASS);
    const salts = [fieldSalt(secret, { typed: "Email" }), fieldSalt(secret, { custom: "phone" })];
    // the flow did happen, and the commitments are what went out
    const sent = show(hooks.chain.sent.map((c) => c.args));
    expect(sent).toContain(privateCommitment(salts[0]!, EMAIL).slice(2));
    expect(sent).toContain(privateCommitment(salts[1]!, PHONE).slice(2));
    expect(location.href).toBe(urlBefore);

    expect(
      leaks({
        "the email value": textForms(EMAIL),
        "the phone value": textForms(PHONE),
        "the passphrase": textForms(PASS),
        "the identity secret": forms(secret),
        "the email salt": forms(salts[0]!),
        "the phone salt": forms(salts[1]!),
      }),
    ).toEqual([]);
    expect(out.filter((o) => o.channel.startsWith("Storage") || o.channel.startsWith("indexedDB") || o.channel.startsWith("console"))).toEqual([]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  }, 120_000);

  it("would see a leak in any of those forms (the detector itself is checked)", () => {
    const saved = out.splice(0);
    const salt = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const needles = { salt: forms(salt), value: textForms(EMAIL) };
    for (const leak of [
      u8aToHex(salt),
      u8aToHex(salt).toUpperCase(),
      `prefix ${Buffer.from(Uint8Array.of(9, ...salt)).toString("base64")}`,
      `xx${Buffer.from(Uint8Array.of(1, 2, ...salt)).toString("base64")}`,
      Array.from(salt).join(", "),
      salt,
      { nested: { deep: salt } },
      `0x${Buffer.from(EMAIL).toString("hex")}`,
      encodeURIComponent(EMAIL),
      Buffer.from(`{"v":"${EMAIL}"}`).toString("base64"),
    ]) {
      out.splice(0);
      record("test", leak);
      expect(leaks(needles), show(leak)).not.toEqual([]);
    }
    out.splice(0, out.length, ...saved);
  });
});
