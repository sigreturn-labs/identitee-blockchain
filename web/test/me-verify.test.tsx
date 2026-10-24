// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keyring } from "@polkadot/keyring";
import { hexToString, hexToU8a, stringToHex, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";

// Verifying from /me: the Verify button of each field, the panel of each channel, the identity
// document row, and the answers the service sends back in the address. The chain is a fixture the
// test changes (as the service would, by attesting), the wallet signs with a dev key, and `fetch`
// is the verification service: every request it gets is kept and checked.

const CHAIN_ID = `0x${"12".repeat(32)}`;
const hooks = vi.hoisted(() => ({ raw: null as any, blob: null as Uint8Array | null }));
vi.mock("../src/chain/api.ts", () => ({ connect: async () => ({ genesisHash: { toHex: () => CHAIN_ID } }) }));
vi.mock("../src/chain/identity.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/chain/identity.ts")>();
  return {
    ...real,
    readProfile: vi.fn(async (address: string) => (hooks.raw ? real.decodeProfile(address, structuredClone(hooks.raw)) : null)),
    identitySecret: async () => hooks.blob,
  };
});

import { privateCommitment } from "../src/chain/formulas.ts";
import { readProfile } from "../src/chain/identity.ts";
import { packetMessage } from "../src/chain/packet.ts";
import { forgetChannels, kycMessage } from "../src/chain/verify.ts";
import { fieldSalt } from "../src/crypto/secret.ts";
import { forgetSecret, keepSecret } from "../src/crypto/session.ts";
import { MyIdentity } from "../src/pages/me-editor.tsx";

const VERIFIER = "https://verify.identit.ee";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as any;
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const BLOB = Uint8Array.from({ length: 80 }, (_, i) => i);
const ATTESTED = fixture.attestations[0][2];

let pair: ReturnType<Keyring["addFromUri"]>;
let ADDR = "";
const signRaw = vi.fn();
const wallet = { signerFor: async (address: string) => ({ address, signer: { signRaw } }) } as unknown as WalletModule;

beforeAll(async () => {
  await cryptoWaitReady();
  pair = new Keyring({ type: "sr25519", ss58Format: 2426 }).addFromUri("//Ferdie");
  ADDR = pair.address;
}, 30_000);

// --- The service ------------------------------------------------------------------------------

type Answer = { status?: number; json: unknown } | "down";
interface Asked {
  method: string;
  path: string;
  body: any;
}
let asked: Asked[] = [];
let answers: Record<string, Answer | ((body: any) => Answer)> = {};

function serve(channels: string[], more: Record<string, Answer | ((body: any) => Answer)> = {}) {
  answers = { "GET /api/channels": { json: { channels, matrixBot: "@identitee:matrix.org", telegramBot: "identitee_bot" } }, ...more };
}

const fetchStub = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  asked.push({ method, path: url.pathname + url.search, body });
  const route = answers[`${method} ${url.pathname}`];
  const answer = typeof route === "function" ? route(body) : route;
  if (!answer || answer === "down") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
});
const posts = (path: string) => asked.filter((a) => a.method === "POST" && a.path === path).map((a) => a.body);

// --- The page ---------------------------------------------------------------------------------

let root: HTMLElement | undefined;
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function until(condition: () => boolean, what: string, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
}
const button = (label: string, within: ParentNode = root!): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((b) => text(b) === label || b.getAttribute("aria-label") === label);
const click = async (label: string, within?: ParentNode) => {
  const b = button(label, within);
  if (!b) throw new Error(`no button ${label}`);
  await act(() => b.click());
  await settle(5);
};
const panel = (label: string) => root!.querySelector(`[aria-label="Verify ${label}"].panel`);
const inputIn = (scope: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement => {
  const l = [...scope.querySelectorAll("label")].find((x) => text(x) === label);
  if (!l) throw new Error(`no label ${label}`);
  return root!.querySelector<HTMLInputElement>(`#${CSS.escape(l.getAttribute("for")!)}`)!;
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  await act(() => void el.dispatchEvent(new Event("input", { bubbles: true })));
};
const fieldsNotice = () => text(root!.querySelector('section[aria-label="Details"] > .verify-notice'));
const problemIn = (scope: Element | null) => text(scope?.querySelector(".problem"));
/** What the one live region says (it takes the text a moment after it is given). */
const liveText = () => text(root!.querySelector("#verify-live"));

async function open() {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyIdentity address={ADDR} wallet={wallet} />, root!));
  await until(() => root!.querySelector(".editor") !== null, "the editor");
  await settle(10);
}

/** The fixture with nothing verified and no fact, changed by `change`. */
function identity(change: (raw: any) => void = () => undefined) {
  const raw = structuredClone(fixture);
  raw.attestations = [];
  raw.facts = [];
  change(raw);
  hooks.raw = raw;
}
const attest = (ref: object) => hooks.raw.attestations.push([ref, 0, { ...ATTESTED }, true]);
const privateValue = (kind: string, value: string) => (raw: any) => {
  raw.identity.typed[kind] = { private: privateCommitment(fieldSalt(SECRET, { typed: kind as never }), value) };
};

beforeEach(() => {
  asked = [];
  forgetChannels();
  forgetSecret(ADDR);
  hooks.blob = null;
  vi.stubGlobal("fetch", fetchStub);
  signRaw.mockReset();
  signRaw.mockImplementation(async ({ data }: { data: `0x${string}` }) => ({ id: 1, signature: u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data)))) }));
  vi.mocked(readProfile).mockClear();
  history.replaceState(null, "", "/me");
  sessionStorage.clear();
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Let fake time pass in small steps, so that every promise in between settles. */
async function pass(ms: number, step = 250) {
  for (let done = 0; done < ms; done += step) await act(async () => void (await vi.advanceTimersByTimeAsync(Math.min(step, ms - done))));
}
/** Open the editor with fake timers already on. */
async function openFaked() {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyIdentity address={ADDR} wallet={wallet} />, root!));
  await pass(500, 10);
}

const unlocked = () => {
  hooks.blob = BLOB;
  keepSecret(ADDR, BLOB, SECRET);
};

// --- The button -------------------------------------------------------------------------------

describe("the Verify button", () => {
  it("shows on a saved field not verified yet whose channel the service offers, and nowhere else", async () => {
    identity((raw) => {
      raw.identity.typed.Matrix = { public: stringToHex("@me:matrix.org") };
      raw.attestations = [[{ typed: "Email" }, 0, { ...ATTESTED }, true]];
    });
    serve(["email", "pgp", "telegram", "x"]);
    await open();
    // Email is verified (its check stays), Matrix's channel is off, X is not on the identity, names are not verifiable
    const verify = [...root!.querySelectorAll("button")].filter((b) => text(b) === "Verify").map((b) => b.getAttribute("aria-label"));
    expect(verify).toEqual(["Verify Telegram", "Verify PGP"]);
    expect(button("Verify Email")).toBeUndefined();
    expect(text([...root!.querySelectorAll("label")].find((l) => text(l).startsWith("Email")))).toBe("EmailVerified");
  });

  it("is not offered when the service cannot be reached", async () => {
    identity();
    serve([], { "GET /api/channels": "down" });
    await open();
    expect(button("Verify PGP")).toBeUndefined();
    expect(root!.querySelector('section[aria-label="Identity document"]')).toBeNull();
  });

  it("waits while the form has unsaved changes", async () => {
    identity();
    serve(["pgp"]);
    await open();
    expect(button("Verify PGP")!.disabled).toBe(false);
    await click("Verify PGP");
    expect(panel("PGP")).not.toBeNull();
    await type(root!.querySelector<HTMLTextAreaElement>("#bio")!, "changed");
    // the open panel goes, and the button says why it waits
    expect(panel("PGP")).toBeNull();
    expect(button("Verify PGP")!.disabled).toBe(true);
    expect(button("Verify PGP")!.title).toBe("Save first.");
    expect(text(root!.querySelector("#verify-wait"))).toBe("Reveal, Packet and Verify wait until your changes are saved or cancelled.");
    expect(button("Verify PGP")!.getAttribute("aria-describedby")).toBe("verify-wait");
  });

  it("opens one panel at a time", async () => {
    identity((raw) => (raw.identity.typed.Web = { public: stringToHex("example.org") }));
    serve(["pgp", "web"], { "POST /api/pgp/challenge": { json: { challenge: "c", session: "s" } } });
    await open();
    await click("Verify PGP");
    await click("Verify Website");
    expect(panel("PGP")).toBeNull();
    expect(panel("Website")).not.toBeNull();
  });
});

// --- Channels ---------------------------------------------------------------------------------

describe("email", () => {
  it("sends a code, checks it with the same session, then reads the chain until the field is verified", async () => {
    identity();
    serve(["email"], {
      "POST /api/email/send": { json: { sent: true, session: "S-1" } },
      "POST /api/email/check": (body) => {
        if (body.code !== "123456") return { status: 400, json: { error: "That code is not right." } };
        attest({ typed: "Email" });
        return { json: { verified: true } };
      },
    });
    await open();
    await click("Verify Email");
    await click("Send code", panel("Email")!);
    expect(posts("/api/email/send")).toEqual([{ address: ADDR }]);
    const code = inputIn(panel("Email")!, "Code") as HTMLInputElement;
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");

    await type(code, "12 34");
    await click("Confirm", panel("Email")!);
    expect(problemIn(panel("Email"))).toBe("Enter the 6-digit code.");
    expect(posts("/api/email/check")).toEqual([]);

    await type(code, "654321");
    await click("Confirm", panel("Email")!);
    expect(problemIn(panel("Email"))).toBe("That code is not right.");

    await type(code, "123 456");
    await click("Confirm", panel("Email")!);
    expect(posts("/api/email/check")).toEqual([
      { address: ADDR, session: "S-1", code: "654321" },
      { address: ADDR, session: "S-1", code: "123456" },
    ]);
    expect(panel("Email")).toBeNull();
    await until(() => text([...root!.querySelectorAll("label")].find((l) => text(l).startsWith("Email"))) === "EmailVerified", "the check mark");
    expect(fieldsNotice()).toBe("Email verified.");
    expect(button("Verify Email")).toBeUndefined();
  });

  it("says the service is unavailable when it cannot be reached", async () => {
    identity();
    serve(["email"], { "POST /api/email/send": "down" });
    await open();
    await click("Verify Email");
    await click("Send code", panel("Email")!);
    expect(problemIn(panel("Email"))).toBe("Verification is unavailable right now. Try again in a moment.");
  });

  it("stops reading the chain after two minutes, and says the mark may take a moment", async () => {
    identity();
    serve(["email"], { "POST /api/email/send": { json: { sent: true, session: "S" } }, "POST /api/email/check": { json: { verified: true } } });
    await open();
    await click("Verify Email");
    await click("Send code", panel("Email")!);
    await type(inputIn(panel("Email")!, "Code"), "123456");
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const confirm = button("Confirm", panel("Email")!)!;
    await act(async () => {
      confirm.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fieldsNotice()).toBe("Email verified.");
    const reads = vi.mocked(readProfile).mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(121_000)));
    expect(fieldsNotice()).toBe("Verified. It may take a moment to show.");
    const after = vi.mocked(readProfile).mock.calls.length;
    // every 3 s for 2 min
    expect(after - reads).toBeGreaterThanOrEqual(40);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(vi.mocked(readProfile).mock.calls.length).toBe(after);
  });
});

describe("sign-in with X, Discord or GitHub", () => {
  function popupStub() {
    const win = { closed: false, close: vi.fn(() => void (win.closed = true)), focus: vi.fn(), location: { href: "" } };
    return win;
  }
  const post = async (data: unknown, origin: string, source: unknown) =>
    act(() => void window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window })));

  it("opens a window on the service, and listens only to that window from the service's origin", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    const opened = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    await click("Continue with X", panel("X")!);
    expect(opened).toHaveBeenCalledTimes(1);
    const [url, name, features] = opened.mock.calls[0]!;
    expect(String(url)).toBe(`${VERIFIER}/oauth/x/start?address=${ADDR}&mode=popup`);
    expect(name).toBe("identitee-x");
    expect(features).toBe("popup,width=500,height=700");
    expect(text(panel("X"))).toContain("Waiting for the sign-in");

    // a second press focuses the window open, it does not start a second flow
    await click("Continue with X", panel("X")!);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();

    await post({ type: "identitee-verified", channel: "x" }, "https://evil.example", win);
    await post({ type: "identitee-verified", channel: "x" }, VERIFIER, window);
    await post({ type: "something-else", channel: "x" }, VERIFIER, win);
    await post({ type: "identitee-verified", channel: "github" }, VERIFIER, win);
    expect(panel("X")).not.toBeNull();
    expect(fieldsNotice()).toBe("");

    await post({ type: "identitee-verify-error", message: "You signed in to X as @bob, but this identity says @alice." }, VERIFIER, win);
    expect(problemIn(panel("X"))).toBe("You signed in to X as @bob, but this identity says @alice.");

    await click("Continue with X", panel("X")!);
    const again = opened.mock.results[1]!.value as ReturnType<typeof popupStub>;
    await post({ type: "identitee-verified", channel: "x" }, VERIFIER, again);
    expect(panel("X")).toBeNull();
    expect(fieldsNotice()).toBe("X verified.");
  });

  it("goes to the service in this tab on a phone, and remembers it left", async () => {
    identity((raw) => (raw.identity.typed.GitHub = { public: stringToHex("alice") }));
    serve(["github"]);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
    const assign = vi.spyOn(location, "assign").mockImplementation(() => undefined);
    const opened = vi.spyOn(window, "open");
    await open();
    await click("Verify GitHub");
    await click("Continue with GitHub", panel("GitHub")!);
    expect(opened).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(`${VERIFIER}/oauth/github/start?address=${ADDR}&mode=redirect`);
    expect(sessionStorage.getItem("identitee-verify-return")).toBe("github");
  });

  it("leaves a private field's packet with the service first, and gives the window its id", async () => {
    unlocked();
    identity(privateValue("Discord", "alice"));
    serve(["discord"], { "POST /api/packet": { json: { id: "P-24" } } });
    await open();
    const win = popupStub();
    const opened = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify Discord");
    await type(inputIn(panel("Discord")!, "Value of Discord"), "alice");
    await click("Continue", panel("Discord")!);
    expect(signRaw).toHaveBeenCalledTimes(1);
    await click("Continue with Discord", panel("Discord")!);
    expect(opened.mock.calls[0]![0]).toBe("about:blank");
    await until(() => win.location.href !== "", "the window's address");
    expect(win.location.href).toBe(`${VERIFIER}/oauth/discord/start?address=${ADDR}&mode=popup&packet=P-24`);
    const [sent] = posts("/api/packet");
    expect(sent.address).toBe(ADDR);
    expect(sent.packet.value).toBe("alice");
    expect(sent.packet.field).toEqual({ typed: "Discord" });
  });
});

describe("a sign-in window that closes without a word", () => {
  function popupStub() {
    const win = { closed: false, close: vi.fn(() => void (win.closed = true)), focus: vi.fn(), location: { href: "" } };
    return win;
  }

  it("reads the chain, and shows the success when the field turns verified", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    await click("Continue with X", panel("X")!);
    attest({ typed: "X" });
    win.closed = true;
    await until(() => fieldsNotice() === "X verified.", "the chain's word");
    expect(panel("X")).toBeNull();
  });

  it("keeps the provider and reads the chain for ten minutes, then says the window closed", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const go = button("Continue with X", panel("X")!)!;
    await act(async () => {
      go.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    win.closed = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(text(panel("X"))).toContain("Finish the sign-in in the other window.");
    expect(button("Continue with X", panel("X")!)!.disabled).toBe(true);
    // past the two minutes of other checks, the person may still be signing in
    await pass(300_000, 1_000);
    expect(text(panel("X"))).toContain("Finish the sign-in in the other window.");
    expect(problemIn(panel("X"))).toBe("");
    await pass(305_000, 1_000);
    expect(problemIn(panel("X"))).toBe("The sign-in window closed. If you finished, your field shows as verified in a moment; otherwise try again.");
    expect(button("Continue with X", panel("X")!)!.disabled).toBe(false);
  });

  it("finds a sign-in finished after two minutes in a window cut from this page", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const go = button("Continue with X", panel("X")!)!;
    await act(async () => {
      go.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    win.closed = true;
    await pass(200_000, 1_000);
    expect(panel("X")).not.toBeNull();
    attest({ typed: "X" });
    await pass(5_000);
    expect(panel("X")).toBeNull();
    expect(fieldsNotice()).toBe("X verified.");
  });

  it("can be cancelled while it waits, which frees the provider for a new sign-in", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    const opened = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    await click("Continue with X", panel("X")!);
    win.closed = true;
    await until(() => text(panel("X")).includes("Finish the sign-in in the other window."), "the wait");
    const reads = vi.mocked(readProfile).mock.calls.length;
    await click("Cancel", panel("X")!);
    expect(text(panel("X"))).not.toContain("Finish the sign-in");
    expect(button("Cancel", panel("X")!)).toBeUndefined();
    await settle(3_200);
    expect(vi.mocked(readProfile).mock.calls.length).toBe(reads);
    const next = popupStub();
    opened.mockReturnValue(next as unknown as Window);
    await click("Continue with X", panel("X")!);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(text(panel("X"))).toContain("Waiting for the sign-in");
  });

  it("is closed with the panel", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    await click("Continue with X", panel("X")!);
    await click("Close the verification of X");
    expect(win.close).toHaveBeenCalled();
    expect(panel("X")).toBeNull();
  });

  it("is listened to once back on this site, as the same window", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    await open();
    const win = popupStub();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    await click("Verify X");
    await click("Continue with X", panel("X")!);
    await act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "identitee-verified", channel: "x" }, origin: location.origin, source: win as unknown as Window })));
    expect(fieldsNotice()).toBe("X verified.");
  });
});

describe("focus and announcements", () => {
  it("moves into a panel when it opens, and back to its Verify when it closes", async () => {
    identity();
    serve(["email"], { "POST /api/email/send": { json: { sent: true, session: "S" } } });
    await open();
    button("Verify Email")!.focus();
    await click("Verify Email");
    await until(() => document.activeElement === button("Send code", panel("Email")!), "the focus in the panel");
    await click("Close the verification of Email");
    expect(document.activeElement).toBe(button("Verify Email"));
    expect(button("Verify Email")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("says each step through one live region that is always there", async () => {
    identity();
    let reply!: (answer: Response) => void;
    serve(["email"]);
    await open();
    const region = root!.querySelector("#verify-live")!;
    expect(region.getAttribute("role")).toBe("status");
    fetchStub.mockImplementationOnce(() => new Promise<Response>((resolve) => (reply = resolve)));
    await click("Verify Email");
    await click("Send code", panel("Email")!);
    await until(() => liveText() === "Sending…", "Sending");
    await act(() => reply(new Response(JSON.stringify({ sent: true, session: "S" }), { headers: { "Content-Type": "application/json" } })));
    await until(() => liveText() === "Code sent.", "Code sent");
    expect(root!.querySelector("#verify-live")).toBe(region);
  });
});

describe("a code that expired", () => {
  it("offers to start again, with a new link and session", async () => {
    identity((raw) => (raw.identity.typed.Matrix = { public: stringToHex("@alice:matrix.org") }));
    let n = 0;
    serve(["matrix"], {
      "POST /api/matrix/start": () => ({ json: { command: `!identitee T${++n}`, bot: "@identitee:matrix.org", session: `S-${n}` } }),
      "POST /api/matrix/check": { status: 400, json: { error: "This code has expired. Ask for a new one." } },
    });
    await open();
    await click("Verify Matrix");
    await until(() => text(panel("Matrix")).includes("!identitee T1"), "the command");
    await type(inputIn(panel("Matrix")!, "Code"), "123456");
    await click("Confirm", panel("Matrix")!);
    await click("Start again", panel("Matrix")!);
    await until(() => text(panel("Matrix")).includes("!identitee T2"), "the new command");
    await type(inputIn(panel("Matrix")!, "Code"), "123456");
    await click("Confirm", panel("Matrix")!);
    expect(posts("/api/matrix/check").map((b) => b.session)).toEqual(["S-1", "S-2"]);
  });
});

describe("too many wrong codes", () => {
  it("offers to start again on Telegram", async () => {
    identity((raw) => (raw.identity.typed.Telegram = { public: stringToHex("@alice") }));
    let n = 0;
    serve(["telegram"], {
      "POST /api/telegram/start": () => ({ json: { url: `https://t.me/identitee_bot?start=T${++n}`, session: `S-${n}` } }),
      "POST /api/telegram/check": { status: 429, json: { error: "Too many wrong codes. Ask for a new one." } },
    });
    await open();
    await click("Verify Telegram");
    await until(() => panel("Telegram")!.querySelector("a") !== null, "the link");
    const link = panel("Telegram")!.querySelector("a")!;
    link.addEventListener("click", (e) => e.preventDefault());
    await act(() => link.click());
    await type(inputIn(panel("Telegram")!, "Code"), "123456");
    await click("Confirm", panel("Telegram")!);
    expect(problemIn(panel("Telegram"))).toBe("Too many wrong codes. Ask for a new one.");
    await click("Start again", panel("Telegram")!);
    await until(() => panel("Telegram")!.querySelector("a")?.getAttribute("href") === "https://t.me/identitee_bot?start=T2", "the new link");
    expect((inputIn(panel("Telegram")!, "Code") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("a website value the service would refuse", () => {
  it("says how to write it instead of showing the instructions", async () => {
    identity((raw) => (raw.identity.typed.Web = { public: stringToHex("https://exa mple.org") }));
    serve(["web"]);
    await open();
    await click("Verify Website");
    expect(problemIn(panel("Website"))).toBe("Write your website as a plain address, like example.com.");
    expect(button("Check", panel("Website")!)).toBeUndefined();
  });
});

describe("a private field", () => {
  it("is checked against its commitment, then signed once into a packet that goes with the start", async () => {
    unlocked();
    identity(privateValue("Telegram", "@alice"));
    serve(["telegram"], {
      "POST /api/telegram/start": { json: { url: "https://t.me/identitee_bot?start=TOKEN", session: "S-T" } },
      "POST /api/telegram/check": { json: { verified: true } },
    });
    await open();
    await click("Verify Telegram");
    const value = inputIn(panel("Telegram")!, "Value of Telegram");
    await type(value, "@bob");
    await click("Continue", panel("Telegram")!);
    expect(problemIn(panel("Telegram"))).toBe("That is not the value of this field, or it was saved with another identity secret.");
    expect(signRaw).not.toHaveBeenCalled();

    await type(value, "@alice");
    await click("Continue", panel("Telegram")!);
    await until(() => posts("/api/telegram/start").length === 1, "the start");
    expect(signRaw).toHaveBeenCalledTimes(1);
    const [start] = posts("/api/telegram/start");
    expect(start.address).toBe(ADDR);
    expect(start.packet).toMatchObject({ address: ADDR, chain: CHAIN_ID, field: { typed: "Telegram" }, value: "@alice" });
    // the wallet's signature of the packet, the one signature of the flow
    expect(signatureVerify(u8aWrapBytes(packetMessage(start.packet)), start.packet.signature, ADDR).isValid).toBe(true);
  });

  it("asks for the identity secret first when it is locked", async () => {
    hooks.blob = BLOB;
    identity(privateValue("Telegram", "@alice"));
    serve(["telegram"]);
    await open();
    await click("Verify Telegram");
    expect(text(panel("Telegram"))).toContain("Enter its passphrase to unlock it for this visit.");
    // the prompt shows once, in the panel
    expect(root!.querySelectorAll('[aria-label="Identity secret"]')).toHaveLength(1);
  });
});

describe("Telegram", () => {
  it("opens the bot's link, and only then takes the code, with the session of the start", async () => {
    identity((raw) => (raw.identity.typed.Telegram = { public: stringToHex("@alice") }));
    serve(["telegram"], {
      "POST /api/telegram/start": { json: { url: "https://t.me/identitee_bot?start=TOKEN", session: "S-T" } },
      "POST /api/telegram/check": { json: { verified: true } },
    });
    await open();
    await click("Verify Telegram");
    await until(() => panel("Telegram")!.querySelector("a") !== null, "the link");
    expect(posts("/api/telegram/start")).toEqual([{ address: ADDR }]);
    expect(text(panel("Telegram"))).toContain("Tap Start in Telegram, then type the code the bot sends you.");
    const link = panel("Telegram")!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://t.me/identitee_bot?start=TOKEN");
    expect(link.getAttribute("target")).toBe("_blank");
    const code = inputIn(panel("Telegram")!, "Code") as HTMLInputElement;
    expect(code.disabled).toBe(true);
    link.addEventListener("click", (e) => e.preventDefault());
    await act(() => link.click());
    expect(code.disabled).toBe(false);
    await type(code, "111222");
    await click("Confirm", panel("Telegram")!);
    expect(posts("/api/telegram/check")).toEqual([{ address: ADDR, session: "S-T", code: "111222" }]);
    expect(fieldsNotice()).toBe("Telegram verified.");
  });
});

describe("Matrix", () => {
  it("shows the command and the bot, then takes the code with the session of the start", async () => {
    identity((raw) => (raw.identity.typed.Matrix = { public: stringToHex("@alice:matrix.org") }));
    serve(["matrix"], {
      "POST /api/matrix/start": { json: { command: "!identitee TOKEN22", bot: "@identitee:matrix.org", session: "S-M" } },
      "POST /api/matrix/check": { json: { verified: true } },
    });
    await open();
    await click("Verify Matrix");
    await until(() => text(panel("Matrix")).includes("!identitee TOKEN22"), "the command");
    expect(text(panel("Matrix")!.querySelector(".hint"))).toBe(
      "Send this message to @identitee:matrix.org in a direct chat. The bot then invites you to a new private chat: accept it to receive your code.",
    );
    expect(button("Copy message", panel("Matrix")!)).toBeDefined();
    await type(inputIn(panel("Matrix")!, "Code"), "333444");
    await click("Confirm", panel("Matrix")!);
    expect(posts("/api/matrix/start")).toEqual([{ address: ADDR }]);
    expect(posts("/api/matrix/check")).toEqual([{ address: ADDR, session: "S-M", code: "333444" }]);
  });
});

describe("Website", () => {
  it("shows the file and the DNS record for the host in its ASCII form, then checks", async () => {
    identity((raw) => (raw.identity.typed.Web = { public: stringToHex("https://Bücher.example/about") }));
    serve(["web"], { "POST /api/web/check": { status: 400, json: { error: "Neither the file nor the DNS record was found." } } });
    await open();
    await click("Verify Website");
    const shown = [...panel("Website")!.querySelectorAll(".copyable-text")].map(text);
    expect(shown).toEqual(["https://xn--bcher-kva.example/.well-known/identitee.txt", ADDR, `identitee=${ADDR}`]);
    expect(text(panel("Website"))).toContain("Or add a TXT record on _identitee.xn--bcher-kva.example or on xn--bcher-kva.example, with this value:");
    await click("Check", panel("Website")!);
    expect(posts("/api/web/check")).toEqual([{ address: ADDR }]);
    expect(problemIn(panel("Website"))).toBe("Neither the file nor the DNS record was found.");
  });

  it("asks to make a private website public, and asks the service nothing", async () => {
    unlocked();
    identity(privateValue("Web", "example.org"));
    serve(["web"]);
    await open();
    await click("Verify Website");
    expect(text(panel("Website"))).toContain("Make your website public to verify it.");
    expect(asked.filter((a) => a.method === "POST")).toEqual([]);
    expect(signRaw).not.toHaveBeenCalled();
  });
});

describe("PGP", () => {
  const CHALLENGE = "identitee verification: link this key to identity X on chain 1212121212 nonce abc";

  it("gives the challenge and its command, and sends the signed text without a key", async () => {
    identity();
    serve(["pgp"], { "POST /api/pgp/challenge": { json: { challenge: CHALLENGE, session: "S-P" } }, "POST /api/pgp/verify": { json: { verified: true } } });
    await open();
    await click("Verify PGP");
    await until(() => panel("PGP")!.querySelector(".copyable") !== null, "the challenge");
    expect(text(panel("PGP")!.querySelector(".copyable-text"))).toBe(`echo '${CHALLENGE}' | gpg --clearsign`);
    await type(inputIn(panel("PGP")!, "Signed challenge"), "-----BEGIN PGP SIGNED MESSAGE-----");
    await click("Verify", panel("PGP")!);
    expect(posts("/api/pgp/challenge")).toEqual([{ address: ADDR }]);
    expect(posts("/api/pgp/verify")).toEqual([{ address: ADDR, session: "S-P", signed: "-----BEGIN PGP SIGNED MESSAGE-----" }]);
    expect(fieldsNotice()).toBe("PGP verified.");
  });

  it("asks for the public key of a private fingerprint, and sends it", async () => {
    unlocked();
    const fingerprint = "AB".repeat(20);
    identity((raw) => (raw.identity.typed.Pgp = { private: privateCommitment(fieldSalt(SECRET, { typed: "Pgp" }), hexToU8a(`0x${fingerprint}`)) }));
    serve(["pgp"], { "POST /api/pgp/challenge": { json: { challenge: CHALLENGE, session: "S-P" } }, "POST /api/pgp/verify": { json: { verified: true } } });
    await open();
    await click("Verify PGP");
    await type(inputIn(panel("PGP")!, "Value of PGP"), fingerprint);
    await click("Continue", panel("PGP")!);
    await until(() => posts("/api/pgp/challenge").length === 1 && panel("PGP")!.querySelector(".copyable") !== null, "the challenge");
    expect(posts("/api/pgp/challenge")[0].packet.value).toBe(`0x${fingerprint.toLowerCase()}`);
    await type(inputIn(panel("PGP")!, "Signed challenge"), "signed");
    await click("Verify", panel("PGP")!);
    expect(problemIn(panel("PGP"))).toBe("Paste your public key to verify a private PGP.");
    expect(posts("/api/pgp/verify")).toEqual([]);
    await type(inputIn(panel("PGP")!, "Public key"), "-----BEGIN PGP PUBLIC KEY BLOCK-----");
    await click("Verify", panel("PGP")!);
    const [sent] = posts("/api/pgp/verify");
    expect(sent).toMatchObject({ address: ADDR, session: "S-P", signed: "signed", key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" });
  });
});

// --- Identity document ------------------------------------------------------------------------

describe("the identity document", () => {
  const section = () => root!.querySelector('section[aria-label="Identity document"]')!;

  it("signs the four-line message with the wallet, starts the check, and gives the link", async () => {
    identity();
    serve(["kyc"], { "GET /api/kyc/status": { json: { status: "none" } }, "POST /api/kyc/start": { json: { url: "https://verify.didit.me/session/abc" } } });
    await open();
    await until(() => button("Verify with Didit", section()) !== undefined, "the button");
    expect(text(section())).toContain("Not checked");
    const before = Date.now();
    await click("Verify with Didit", section());
    await until(() => section().querySelector("a") !== null, "the link");
    expect(signRaw).toHaveBeenCalledTimes(1);
    const { data, type: kind, address } = signRaw.mock.calls[0]![0];
    expect([kind, address]).toEqual(["bytes", ADDR]);
    const message = hexToString(data);
    const lines = message.split("\n");
    expect(lines.slice(0, 3)).toEqual(["identitee kyc", `chain: ${CHAIN_ID}`, `address: ${ADDR}`]);
    expect(lines).toHaveLength(4);
    const time = Number(lines[3]!.replace(/^time: /, ""));
    expect(lines[3]).toBe(`time: ${time}`);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(message).toBe(kycMessage(CHAIN_ID, ADDR, time));
    const [start] = posts("/api/kyc/start");
    expect(start.address).toBe(ADDR);
    expect(start.message).toBe(message);
    expect(signatureVerify(u8aWrapBytes(message), start.signature, ADDR).isValid).toBe(true);
    expect(section().querySelector("a")!.getAttribute("href")).toBe("https://verify.didit.me/session/abc");
    expect(text(section())).toContain("Being checked.");
  });

  it("signs again with a fresh time for each start, and shows the service's refusal as is", async () => {
    identity();
    serve(["kyc"], {
      "GET /api/kyc/status": { json: { status: "pending" } },
      "POST /api/kyc/start": { status: 409, json: { error: "Your identity document is already being checked." } },
    });
    await open();
    await until(() => button("Continue", section()) !== undefined, "Continue");
    expect(text(section())).toContain("Being checked.");
    await click("Continue", section());
    expect(problemIn(section())).toBe("Your identity document is already being checked.");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    await click("Continue", section());
    const [first, second] = posts("/api/kyc/start");
    expect(first.message).not.toBe(second.message);
  });

  it("follows a check under way until the fact is on chain", async () => {
    identity();
    serve(["kyc"], { "GET /api/kyc/status": { json: { status: "pending" } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await openFaked();
    expect(text(section())).toContain("Being checked.");
    const asks = () => asked.filter((a) => a.path.startsWith("/api/kyc/status")).length;
    const before = asks();
    await pass(10_000);
    expect(asks() - before).toBe(2);
    hooks.raw.facts = structuredClone(fixture.facts);
    await pass(5_000);
    expect(text(section())).toContain("Checked");
    expect(section().querySelector(".state.verified")).not.toBeNull();
    const after = asks();
    await pass(60_000, 1_000);
    expect(asks()).toBe(after);
  });

  it("shows a declined check", async () => {
    identity();
    let status = "pending";
    serve(["kyc"], { "GET /api/kyc/status": () => ({ json: { status } }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await openFaked();
    status = "declined";
    await pass(5_000);
    expect(text(section())).toContain("Your last check was declined.");
    expect(button("Verify with Didit", section())).toBeDefined();
  });

  it("gives up on a check still under way after 15 minutes", async () => {
    identity();
    serve(["kyc"], { "GET /api/kyc/status": { json: { status: "pending" } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    await openFaked();
    await pass(15 * 60_000 + 6_000, 1_000);
    const asks = asked.filter((a) => a.path.startsWith("/api/kyc/status")).length;
    expect(asks).toBeGreaterThan(150);
    await pass(60_000, 1_000);
    expect(asked.filter((a) => a.path.startsWith("/api/kyc/status")).length).toBe(asks);
  });

  it("brings the button back, without the old link, when a check started here is declined", async () => {
    identity();
    let status = "none";
    serve(["kyc"], {
      "GET /api/kyc/status": () => ({ json: { status } }),
      "POST /api/kyc/start": () => ((status = "pending"), { json: { url: "https://verify.didit.me/session/abc" } }),
    });
    await open();
    await until(() => button("Verify with Didit", section()) !== undefined, "the button");
    await click("Verify with Didit", section());
    await until(() => section().querySelector("#open-didit") !== null, "the link");
    status = "declined";
    await until(() => button("Verify with Didit", section()) !== undefined, "the button again", 8_000);
    expect(section().querySelector("#open-didit")).toBeNull();
    expect(text(section())).toContain("Your last check was declined.");
  }, 15_000);

  it("says what the wallet did when it does not sign", async () => {
    identity();
    serve(["kyc"], { "GET /api/kyc/status": { json: { status: "none" } } });
    signRaw.mockRejectedValueOnce(new Error("Cancelled by the user"));
    await open();
    await until(() => button("Verify with Didit", section()) !== undefined, "the button");
    await click("Verify with Didit", section());
    expect(problemIn(section())).toBe("Cancelled in the wallet.");
    expect(posts("/api/kyc/start")).toEqual([]);
  });

  it("shows Checked when the chain holds the fact, without asking the service", async () => {
    identity((raw) => (raw.facts = structuredClone(fixture.facts)));
    serve(["kyc"]);
    await open();
    expect(text(section())).toContain("Checked");
    expect(section().querySelector(".state.verified")).not.toBeNull();
    expect(button("Verify with Didit", section())).toBeUndefined();
    expect(asked.some((a) => a.path.startsWith("/api/kyc/status"))).toBe(false);
  });
});

// --- Coming back --------------------------------------------------------------------------------

describe("coming back from the service", () => {
  it("says a field was verified when this tab left for the service, and takes the answer out of the address", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    sessionStorage.setItem("identitee-verify-return", "x");
    history.replaceState(null, "", "/me?verified=x&keep=1");
    await open();
    expect(fieldsNotice()).toBe("X verified.");
    expect(location.pathname + location.search).toBe("/me?keep=1");
    // the page-level notice goes through the live region, mounted before its text arrives
    await until(() => liveText() === "X verified.", "the announcement");
  });

  it("does not believe ?verified= from elsewhere: it says it only once the chain shows it", async () => {
    identity((raw) => (raw.identity.typed.X = { public: stringToHex("@alice") }));
    serve(["x"]);
    history.replaceState(null, "", "/me?verified=x");
    await open();
    expect(fieldsNotice()).toBe("");
    expect(location.search).toBe("");
    attest({ typed: "X" });
    await until(() => fieldsNotice() === "X verified.", "the chain's word", 6_000);
  });

  it("in a sign-in window cut from nothing, hands the answer to the page that opened it and closes", async () => {
    identity();
    serve([]);
    const postMessage = vi.fn();
    vi.stubGlobal("opener", { location: { origin: location.origin }, postMessage });
    const closeWindow = vi.spyOn(window, "close").mockImplementation(() => undefined);
    history.replaceState(null, "", "/me?verified=github");
    await open();
    expect(postMessage).toHaveBeenCalledWith({ type: "identitee-verified", channel: "github" }, location.origin);
    expect(closeWindow).toHaveBeenCalled();
  });

  it("shows an error only when this tab left for the service", async () => {
    identity();
    serve([]);
    history.replaceState(null, "", "/me?verify_error=Send%20your%20phrase%20to%20support");
    await open();
    expect(fieldsNotice()).toBe("");
    expect(location.search).toBe("");
    if (root) render(null, root);
    root?.remove();

    sessionStorage.setItem("identitee-verify-return", "x");
    history.replaceState(null, "", "/me?verify_error=The%20sign-in%20to%20X%20was%20cancelled.");
    await open();
    expect(fieldsNotice()).toBe("The sign-in to X was cancelled.");
    expect(location.search).toBe("");
    expect(sessionStorage.getItem("identitee-verify-return")).toBeNull();
  });

  it("ignores an answer in the address of a sign-in window cut from its opener", async () => {
    identity();
    serve([]);
    vi.stubGlobal("name", "identitee-x");
    history.replaceState(null, "", "/me?verify_error=Send%20your%20phrase%20to%20support");
    await open();
    expect(fieldsNotice()).toBe("");
    expect(location.search).toBe("");
  });

  it("says the identity document is being checked after Didit", async () => {
    identity();
    serve(["kyc"], { "GET /api/kyc/status": { json: { status: "pending" } } });
    history.replaceState(null, "", "/me?kyc=done&verificationSessionId=11111111-2222-3333-4444-555555555555&status=Approved&other=1");
    await open();
    await until(() => text(root!.querySelector('section[aria-label="Identity document"]')).includes("Being checked."), "the status");
    expect(text(root!.querySelector('section[aria-label="Identity document"] .verify-notice'))).toBe("Your identity document is being checked.");
    expect(location.search).toBe("");
  });
});
