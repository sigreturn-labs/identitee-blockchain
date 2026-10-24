// End-to-end check of private fields in a real Chrome against a LOCAL dev node, with a fake wallet
// extension that signs with a fresh key the way extensions sign (signPayload for transactions,
// signRaw with the <Bytes> wrapping for messages).
//
//   ../target/release/identitee-node --dev --tmp
//   VITE_RPC=ws://127.0.0.1:9944 npx vite build --outDir .shot-dist
//   node scripts/e2e-private.mjs --dist .shot-dist --tag desktop
//   node scripts/e2e-private.mjs --dist .shot-dist --tag mobile --width 390 --height 844 --scale 2
//
// The run: a zero-balance account creates its identity secret and saves it with two private fields
// in one signature, reloads the page, is refused a wrong passphrase, unlocks, makes a verification
// packet, then reveals one field. Every way out of the page is watched all along (WebSocket frames seen by Chrome itself,
// requests, fetch, storage, IndexedDB, cookies, console, history, the payloads given to the
// wallet to sign), and none may carry a private value, a salt, the secret or the passphrase,
// except reveal_field, which publishes the value and salt of the field revealed by design.
//
// It writes to the chain, so it refuses any node that is not a development or local chain.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import puppeteer from "puppeteer-core";
import { preview } from "vite";
import { privateCommitment } from "../src/chain/formulas.ts";
import { decodeProfile } from "../src/chain/identity.ts";
import { readPacket } from "../src/chain/packet.ts";
import { fieldSalt, openSecret } from "../src/crypto/secret.ts";

const NVIDIA_EGL = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";

const { values } = parseArgs({
  options: {
    dist: { type: "string", default: ".shot-dist" },
    node: { type: "string", default: "ws://127.0.0.1:9944" },
    tag: { type: "string", default: "desktop" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    scale: { type: "string", default: "1" },
  },
});
const SHOTS = "screenshots";
const FONTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
mkdirSync(SHOTS, { recursive: true });

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(values.node), noInitWarn: true });
const chainType = (await api.rpc.system.chainType()).type;
if (chainType !== "Development" && chainType !== "Local") {
  await api.disconnect();
  throw new Error(`Refusing to run against ${values.node}: it is a ${chainType} chain. Use a node started with --dev.`);
}
const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

function findChrome() {
  const root = join(homedir(), ".cache/puppeteer/chrome");
  return join(root, readdirSync(root).sort().at(-1), "chrome-linux64/chrome");
}

const server = await preview({ build: { outDir: values.dist }, preview: { port: 0, host: "127.0.0.1" } });
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu", "--ignore-gpu-blocklist"],
  // On a machine with an NVIDIA card, point EGL at its driver so WebGL renders on the GPU.
  env: existsSync(NVIDIA_EGL) ? { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: NVIDIA_EGL } : process.env,
});

async function chain(address) {
  const raw = (await api.call.identiteeApi.profile(keyring.decodeAddress(address))).toJSON();
  return raw === null ? null : decodeProfile(address, JSON.parse(JSON.stringify(raw)));
}
async function storedSecret(address) {
  const answer = await api.rpc.state.call("IdentiteeApi_identity_secret", u8aToHex(keyring.decodeAddress(address)));
  const bytes = answer.toU8a(true);
  if (bytes[0] === 0) return null;
  // Option tag, then a compact length (one byte below 64, two bytes up to 16383)
  const mode = bytes[1] & 3;
  const start = mode === 0 ? 2 : 3;
  return bytes.subarray(start);
}

// --- The page, every way out of it watched -----------------------------------------------------

const pair = keyring.addFromMnemonic(mnemonicGenerate());
const context = await browser.createBrowserContext();
const page = await context.newPage();
await page.setViewport({ width: +values.width, height: +values.height, deviceScaleFactor: +values.scale });
const log = { payloads: [], raw: [], errors: [], frames: [], requests: [] };
await page.exposeFunction("__identiteeSign", async (payload) => {
  log.payloads.push(JSON.stringify(payload));
  const { signature } = api.registry.createType("ExtrinsicPayload", payload, { version: payload.version }).sign(pair);
  return { signature };
});
await page.exposeFunction("__identiteeSignRaw", async (raw) => {
  log.raw.push(raw.data);
  return { signature: u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(raw.data)))) };
});
await page.evaluateOnNewDocument(
  (accounts) => {
    let id = 0;
    window.injectedWeb3 = {
      "polkadot-js": {
        version: "0.0.0",
        enable: async () => ({
          accounts: { get: async () => accounts, subscribe: (cb) => (cb(accounts), () => undefined) },
          signer: {
            signPayload: async (payload) => ({ id: ++id, ...(await window.__identiteeSign(payload)) }),
            signRaw: async (raw) => ({ id: ++id, ...(await window.__identiteeSignRaw(raw)) }),
          },
        }),
      },
    };
    // what the page itself hands to a way out, kept across reloads in the window name's stead:
    // sessionStorage would be a way out, so the record goes to the test through a binding
    const out = (channel, args) => {
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof ArrayBuffer || ArrayBuffer.isView(a)) {
            const bytes = new Uint8Array(a instanceof ArrayBuffer ? a : a.buffer);
            return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
          }
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      window.__identiteeOut?.(channel, text);
    };
    const wrap = (target, name, channel) => {
      if (!target || typeof target[name] !== "function") return;
      const original = target[name];
      target[name] = function (...args) {
        out(channel, args);
        return original.apply(this, args);
      };
    };
    for (const m of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"]) wrap(console, m, `console.${m}`);
    wrap(window, "fetch", "fetch");
    wrap(XMLHttpRequest.prototype, "open", "XMLHttpRequest.open");
    wrap(XMLHttpRequest.prototype, "send", "XMLHttpRequest.send");
    wrap(WebSocket.prototype, "send", "WebSocket.send");
    wrap(navigator, "sendBeacon", "sendBeacon");
    wrap(Storage.prototype, "setItem", "Storage.setItem");
    wrap(indexedDB, "open", "indexedDB.open");
    wrap(history, "pushState", "history.pushState");
    wrap(history, "replaceState", "history.replaceState");
    wrap(BroadcastChannel.prototype, "postMessage", "BroadcastChannel.postMessage");
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookie.get.call(document),
      set: (v) => {
        out("document.cookie", [v]);
        cookie.set.call(document, v);
      },
    });
  },
  [{ address: pair.address, name: "Private", type: "sr25519" }],
);
const pageOut = [];
await page.exposeFunction("__identiteeOut", (channel, text) => pageOut.push({ channel, text }));
const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.webSocketFrameSent", (e) => log.frames.push(e.response.payloadData));
page.on("request", (r) => log.requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`));
// the verification service is never reached: its list of channels is answered here, empty, and any
// other request that leaves the page's origin (or the web fonts) is refused and fails the run
await page.setRequestInterception(true);
page.on("request", (r) => {
  const where = new URL(r.url());
  if (where.origin === new URL(base).origin || ["data:", "blob:"].includes(where.protocol) || FONTS.includes(where.host)) return r.continue();
  if (where.pathname === "/api/channels") {
    return r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"channels":[]}' });
  }
  log.errors.push(`unexpected request to ${r.url()}`);
  return r.abort();
});
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") log.errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => log.errors.push(`page error: ${e.message}`));
page.on("response", (r) => {
  if (r.status() >= 400) log.errors.push(`HTTP ${r.status()}: ${r.url()}`);
});

const url = (path) => new URL(path, base).href;
const shot = async (name, full = true) => {
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: join(SHOTS, `e2e-${name}-${values.tag}.png`), fullPage: full });
};
async function press(scope, label) {
  const handle = await page.evaluateHandle(
    (scope, label) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label),
    scope,
    label,
  );
  if (!handle.asElement()) throw new Error(`no "${label}" in ${scope}`);
  // in the middle of the window: the Save bar stuck to the bottom must not take the click
  await handle.asElement().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await handle.asElement().click();
}
async function fill(selector, text) {
  await page.focus(selector);
  await page.$eval(selector, (el) => el.select());
  await page.keyboard.press("Backspace");
  if (text !== "") await page.type(selector, text);
}
const byLabel = (label) =>
  page.evaluate((label) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim() === label);
    return l ? `#${CSS.escape(l.getAttribute("for"))}` : null;
  }, label);
const fillLabel = async (label, text) => fill(await byLabel(label), text);
const waitFor = (fn, arg, timeout = 60_000) => page.waitForFunction(fn, { timeout }, arg);
const DETAILS = 'section[aria-label="Details"]';
const textIn = (selector) => page.$eval(selector, (el) => el.textContent.trim()).catch(() => null);

const PASS = "a passphrase for the e2e run 7731";
const EMAIL = `e2e.private.${Date.now() % 100000}@example.org`;
const PHONE = "+33 6 55 44 33 22 e2e";

console.log(`\n== private fields (${values.tag}) ==`);
const balance = (await api.query.system.account(pair.address)).data.free.toBigInt();
check(balance === 0n, `the account has a zero balance (${balance})`);

// 1. a fresh account: no identity, no secret
await page.goto(url("/"), { waitUntil: "networkidle0" });
await press(".card", "Connect wallet");
await page.waitForSelector(".card .note");
await page.goto(url("/me"), { waitUntil: "networkidle0" });
await page.waitForSelector('section[aria-label="My identity"]');
await page.screenshot({ type: "png" }); // the first capture of a WebGL page is black

await fillLabel("Display name", "Private Person");
await fillLabel("Email", EMAIL);
await press(DETAILS, "Make Email private");
await page.waitForSelector('[aria-label="Identity secret"]');
check((await textIn('[aria-label="Identity secret"] .hint'))?.startsWith("Private fields need an identity secret."), "an account without a secret is asked to create one");
check(await page.$eval('.savebar .button.primary', (b) => b.disabled), "the form cannot be saved before the secret exists");
await fill('[aria-label="Name of a new field"]', "phone");
await fill('[aria-label="Value of a new field"]', PHONE);
await press(".add", "Add field");
await press(DETAILS, "Make phone private");
await fillLabel("Passphrase", PASS);
await fillLabel("Repeat passphrase", PASS);
await shot("private-create-secret");
let signatures = log.payloads.length;
await press('[aria-label="Identity secret"]', "Create secret");
// the passphrase goes through Argon2 (64 MiB), slow on a cold page
await waitFor(() => document.querySelector('[aria-label="Identity secret"]')?.textContent.includes("stored with your next Save"), undefined, 90_000);
check(log.payloads.length === signatures, "creating the secret asks the wallet nothing: it waits for the Save");
await press(".savebar", "Save");
await waitFor(() => document.querySelector(".savebar .status")?.textContent === "Saved");
check(log.payloads.length - signatures === 1, "the secret, the name and two private fields are saved with one signature");
const blob = await storedSecret(pair.address);
check(blob?.length === 89 && blob[0] === 1, `the chain holds an 89-byte blob, version 1 (${blob?.length})`);
const secret = await openSecret(blob, PASS);
const salts = { email: fieldSalt(secret, { typed: "Email" }), phone: fieldSalt(secret, { custom: "phone" }) };

let onChain = await chain(pair.address);
const field = (p, id) => p?.fields.find((f) => f.id === id);
check(
  field(onChain, "typed:Email")?.privacy === "private" && field(onChain, "typed:Email").commitment === privateCommitment(salts.email, EMAIL),
  "the chain holds the email as the commitment under its derived salt",
);
check(field(onChain, "custom:phone")?.commitment === privateCommitment(salts.phone, PHONE), "and the phone as well");
check(field(onChain, "typed:DisplayName")?.value === "Private Person", "the public field next to them is public");
await shot("private-saved");

// 2. reload: the secret is forgotten; a wrong passphrase is refused, the right one unlocks
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector('section[aria-label="My identity"]');
check(
  (await page.$$eval(".field .private", (els) => els.map((e) => e.textContent.trim()))).length === 2,
  "after a reload both fields show as Private",
);
await press(DETAILS, "Verification packet for phone");
await page.waitForSelector('[aria-label="Identity secret"]');
await fillLabel("Passphrase", "not the passphrase at all");
await press('[aria-label="Identity secret"]', "Unlock");
await waitFor(() => document.querySelector('[aria-label="Identity secret"] .problem')?.textContent === "Wrong passphrase.");
check(true, "a wrong passphrase is refused with Wrong passphrase.");
check((await page.$eval(await byLabel("Passphrase"), (el) => el.value)) === "", "and the passphrase input is emptied");
await shot("private-wrong-passphrase");
await fillLabel("Passphrase", PASS);
await press('[aria-label="Identity secret"]', "Unlock");
await page.waitForSelector(".panel");
await fillLabel("Value of phone", PHONE);
await shot("private-packet-value");
await press(".panel", "Create packet");
await page.waitForSelector("textarea.packet");
const json = await page.$eval("textarea.packet", (el) => el.value);
const read = await readPacket(json);
check("packet" in read && read.packet.address === pair.address && read.packet.value === PHONE, "the verification packet is signed by the account and holds the value");
check("packet" in read && read.packet.commitment === field(onChain, "custom:phone").commitment, "its commitment is the one on chain");
check("packet" in read && read.packet.chain === api.genesisHash.toHex(), "it names this chain");
check(log.raw.length === 1, "the wallet was asked to sign one message");
await shot("private-packet");
await press(".panel", "Done");

// 3. reveal the email: reveal_field publishes its value and salt, by design
const framesBeforeReveal = log.frames.length;
const payloadsBeforeReveal = log.payloads.length;
await press(DETAILS, "Reveal Email");
await page.waitForSelector(".panel");
await fillLabel("Value of Email", EMAIL);
await shot("private-reveal");
await press(".panel", "Reveal");
await waitFor((email) => [...document.querySelectorAll(".field .control input")].some((i) => i.value === email), EMAIL);
onChain = await chain(pair.address);
check(field(onChain, "typed:Email")?.privacy === "public" && field(onChain, "typed:Email").value === EMAIL, "Reveal makes the email public on chain");
check(log.payloads.length - payloadsBeforeReveal === 1, "with one signature");
await shot("private-revealed");

// 4. nothing leaked
const hex = (bytes) => u8aToHex(bytes).slice(2);
const b64 = (bytes) => [0, 1, 2].map((s) => Buffer.from(bytes.subarray(s)).toString("base64").replace(/=+$/, "").slice(0, -2));
const forms = (bytes) => [hex(bytes), hex(bytes).toUpperCase(), Array.from(bytes).join(","), ...b64(bytes)];
const textForms = (text) => [text, encodeURIComponent(text), ...forms(stringToU8a(text))];
const needles = {
  email: textForms(EMAIL),
  phone: textForms(PHONE),
  passphrase: textForms(PASS),
  secret: forms(secret),
  "email salt": forms(salts.email),
  "phone salt": forms(salts.phone),
};
const everywhere = (name, list) => {
  const found = [];
  for (const [what, needlesOf] of Object.entries(needles)) {
    for (const needle of needlesOf) for (const text of list) if (text.includes(needle)) found.push(`${what} in ${name}`);
  }
  return [...new Set(found)];
};
const afterReveal = (name, list) =>
  everywhere(name, list).filter((f) => !f.startsWith("email in") && !f.startsWith("email salt in"));
const stored = await page.evaluate(async () => ({
  local: JSON.stringify({ ...localStorage }),
  session: JSON.stringify({ ...sessionStorage }),
  idb: JSON.stringify(await indexedDB.databases()),
  url: location.href,
  title: document.title,
}));
const cookies = JSON.stringify(await context.cookies?.().catch(() => []) ?? []);
const leaks = [
  ...everywhere("WebSocket frames before the reveal", log.frames.slice(0, framesBeforeReveal)),
  ...afterReveal("WebSocket frames of the reveal", log.frames.slice(framesBeforeReveal)),
  ...everywhere("transaction payloads before the reveal", log.payloads.slice(0, payloadsBeforeReveal)),
  ...afterReveal("the reveal's transaction payload", log.payloads.slice(payloadsBeforeReveal)),
  ...everywhere("requests", log.requests),
  ...everywhere("what the page handed to a way out", pageOut.filter((o) => o.channel !== "WebSocket.send").map((o) => `${o.channel} ${o.text}`)),
  ...afterReveal("WebSocket.send", pageOut.filter((o) => o.channel === "WebSocket.send").map((o) => o.text)),
  ...everywhere("storage, IndexedDB, URL and title", Object.values(stored)),
  ...everywhere("cookies", [cookies]),
];
check(log.frames.length > 20 && log.payloads.length === 2, `the watch saw the traffic (${log.frames.length} frames, ${log.payloads.length} transactions)`);
check(log.frames.slice(0, framesBeforeReveal).some((f) => f.includes(privateCommitment(salts.email, EMAIL).slice(2))), "the email's commitment went out (the watch reads the right frames)");
check(leaks.length === 0, `no private value, salt, secret or passphrase left the page${leaks.length ? `: ${leaks.join(" / ")}` : ""}`);
// the chosen account is remembered (an address, nothing secret); nothing else may go there
// (and @polkadot/extension-dapp says how many extensions and accounts it found, in console.info;
// the page asks the verification service which channels it offers, a GET with no body)
const written = pageOut.filter(
  (o) =>
    !o.channel.startsWith("WebSocket") &&
    !(o.channel === "fetch" && /^\S+\/api\/channels \{"method":"GET"/.test(o.text)) &&
    !(o.channel === "Storage.setItem" && o.text === `identitee.account ${pair.address}`) &&
    !(o.channel === "console.info" && /^web3(Enable|Accounts): (Enabled \d+ extension|Found \d+ address)/.test(o.text)),
);
check(written.length === 0, `nothing else written to storage, console or history${written.length ? `: ${written.map((o) => `${o.channel} ${o.text.slice(0, 120)}`).join(" / ")}` : ""}`);
check(stored.local === JSON.stringify({ "identitee.account": pair.address }) && stored.session === "{}", `localStorage holds the account only (${stored.local}), sessionStorage nothing`);
check(log.errors.length === 0, `no console error or warning${log.errors.length ? `: ${log.errors.join(" / ")}` : ""}`);

await context.close();
await browser.close();
await server.close();
await api.disconnect();
console.log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
