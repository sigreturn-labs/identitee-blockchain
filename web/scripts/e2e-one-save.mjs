// End-to-end check of the one-signature editor (/me, `update_profile`) in a real Chrome against a
// development node, with a fake wallet extension that signs with throwaway keys.
//
//   ../target/release/identitee-node --dev --tmp
//   VITE_RPC=ws://127.0.0.1:9944 npx vite build --outDir .shot-dist
//   node scripts/e2e-one-save.mjs --dist .shot-dist --image photo.png
//   node scripts/e2e-one-save.mjs ... --tag mobile --width 390 --height 844 --scale 2
//
// It writes to the chain, so it refuses any node that is not a development or local chain. Each
// save must ask the wallet for exactly one signature, and what the chain then holds is checked. The
// verification service is never reached: its list of channels is answered here, empty, and any
// other request that leaves the page's own origin (or the web fonts) fails the run.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import puppeteer from "puppeteer-core";
import { preview } from "vite";
import { decodeProfile } from "../src/chain/identity.ts";

const { values } = parseArgs({
  options: {
    dist: { type: "string", default: ".shot-dist" },
    node: { type: "string", default: "ws://127.0.0.1:9944" },
    image: { type: "string" },
    tag: { type: "string", default: "desktop" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    scale: { type: "string", default: "1" },
  },
});
if (values.image && !existsSync(values.image)) throw new Error(`No image at ${values.image}`);
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

const root = join(homedir(), ".cache/puppeteer/chrome");
const server = await preview({ build: { outDir: values.dist }, preview: { port: 0, host: "127.0.0.1" } });
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: join(root, readdirSync(root).sort().at(-1), "chrome-linux64/chrome"), headless: true, args: ["--no-sandbox"] });
const mobile = +values.width < 600;

async function chain(address) {
  const raw = (await api.call.identiteeApi.profile(keyring.decodeAddress(address))).toJSON();
  return raw === null ? null : decodeProfile(address, JSON.parse(JSON.stringify(raw)));
}
const field = (profile, id) => profile?.fields.find((f) => f.id === id) ?? null;

const pair = keyring.addFromMnemonic(mnemonicGenerate());
const context = await browser.createBrowserContext();
const page = await context.newPage();
await page.setViewport({ width: +values.width, height: +values.height, deviceScaleFactor: +values.scale, isMobile: mobile, hasTouch: mobile });
const log = { signatures: 0, errors: [] };
await page.exposeFunction("__sign", async (payload) => {
  log.signatures++;
  return { signature: api.registry.createType("ExtrinsicPayload", payload, { version: payload.version }).sign(pair).signature };
});
await page.evaluateOnNewDocument((accounts) => {
  let id = 0;
  window.injectedWeb3 = {
    "polkadot-js": {
      version: "0",
      enable: async () => ({
        accounts: { get: async () => accounts, subscribe: (cb) => (cb(accounts), () => undefined) },
        signer: { signPayload: async (payload) => ({ id: ++id, ...(await window.__sign(payload)) }) },
      }),
    },
  };
}, [{ address: pair.address, name: "One save", type: "sr25519" }]);
await page.setRequestInterception(true);
page.on("request", (r) => {
  const url = new URL(r.url());
  if (url.origin === new URL(base).origin || ["data:", "blob:"].includes(url.protocol) || FONTS.includes(url.host)) return r.continue();
  if (url.pathname === "/api/channels") {
    return r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"channels":[]}' });
  }
  log.errors.push(`unexpected request to ${r.url()}`);
  return r.abort();
});
page.on("dialog", (d) => d.accept());
page.on("console", (m) => m.type() === "error" && log.errors.push(m.text()));
page.on("pageerror", (e) => log.errors.push(e.message));

const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: join(SHOTS, `e2e-one-save-${name}-${values.tag}.png`), fullPage: true });
};
async function press(scope, text) {
  const handle = await page.evaluateHandle(
    (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => (b.textContent.trim() === text || b.getAttribute("aria-label") === text) && !b.disabled),
    scope,
    text,
  );
  if (!handle.asElement()) throw new Error(`no enabled "${text}" in ${scope}`);
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
const barText = () => page.$eval(".savebar .savebar-text", (el) => el.textContent.trim()).catch(() => null);
async function saveOnce(what) {
  const before = log.signatures;
  await press(".savebar", "Save");
  await page
    .waitForFunction(() => document.querySelector(".savebar .status")?.textContent.trim() === "Saved", { timeout: 60_000 })
    .catch(async () => {
      throw new Error(`${what}: no "Saved"; the bar says "${await barText()}", ${log.signatures - before} signature(s), errors: ${log.errors.join(" | ")}`);
    });
  check(log.signatures - before === 1, `${what}: one signature (${log.signatures - before})`);
}

await page.goto(new URL("/me", base).href, { waitUntil: "load" });
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Connect wallet"), { timeout: 20_000 });
await press(".card", "Connect wallet");
await page.waitForSelector("#bio", { timeout: 30_000 });
check((await page.$(".savebar")) === null, "an untouched form shows no Save bar");

// --- 1. a first identity: everything at once --------------------------------------------------
await fill("#bio", "One signature for all of it.");
await fill("#field-0", "Single Save");
await fill("#field-3", "single@save.example");
// Legal name, private: it needs an identity secret, made now and stored by the same Save
await fill("#field-1", "Ada Single");
await page.$eval('button[aria-label="Make Legal name private"]', (el) => el.click());
await page.waitForSelector("#secret-new");
await fill("#secret-new", "correct horse battery staple");
await fill("#secret-repeat", "correct horse battery staple");
await press(".secret", "Create secret");
// the passphrase goes through Argon2 (64 MiB), slow on a cold page
await page.waitForFunction(() => document.querySelector(".secret")?.textContent.includes("stored with your next Save"), { timeout: 90_000 });
// a custom field left in the add row: Save takes it in
await fill('[aria-label="Name of a new field"]', "pronouns");
await fill('[aria-label="Value of a new field"]', "she/her");
for (const [title, url] of [
  ["Blog", "blog.example/ada"],
  ["Code", "https://git.example/ada"],
]) {
  await fill('[aria-label="New link title"]', title);
  await fill('[aria-label="New link address"]', url);
  await press('section[aria-label="Links"] .add', "Add link");
}
if (values.image) {
  await press('section[aria-label="Avatar"]', "Add an avatar");
  const input = await page.waitForSelector('.avatar-editor input[type="file"]');
  await input.uploadFile(values.image);
  await page.waitForFunction(() => [...document.querySelectorAll(".avatar-editor button")].some((b) => b.textContent.trim() === "Use this image" && !b.disabled), { timeout: 30_000 });
  await press(".avatar-editor", "Use this image");
}
check(/changes/.test((await barText()) ?? ""), `the Save bar counts the changes ("${await barText()}")`);
await shot("filled");
await saveOnce("first identity with bio, fields, a private field, a new secret, links and avatar");

let onChain = await chain(pair.address);
check(onChain?.bio === "One signature for all of it.", "bio on chain");
check(field(onChain, "typed:DisplayName")?.value === "Single Save" && field(onChain, "typed:Email")?.value === "single@save.example", "public fields on chain");
check(field(onChain, "typed:LegalName")?.privacy === "private", "Legal name is private on chain (a commitment)");
check(field(onChain, "custom:pronouns")?.value === "she/her", "the add row went in with the Save");
check(JSON.stringify(onChain?.links.map((l) => [l.title, l.url])) === JSON.stringify([["Blog", "https://blog.example/ada"], ["Code", "https://git.example/ada"]]), "links on chain, in order");
check(!values.image || (onChain?.avatar?.length ?? 0) > 0, "avatar on chain");
const secret = (await api.query.identitee.identitySecrets(pair.address)).toJSON();
check(typeof secret === "string" && secret.length > 2, "the identity secret is on chain, from the same call");

// --- 2. a second save: change, remove, add and reorder at once --------------------------------
await page.waitForSelector(".savebar", { hidden: true, timeout: 10_000 }).catch(() => undefined);
await fill("#bio", "Edited in one go.");
await page.$eval('button[aria-label="Edit Blog"]', (el) => el.click());
await fill('[aria-label="Link title"]', "Writing");
await press(".item-edit", "Done");
await page.$eval('button[aria-label="Remove Code"]', (el) => el.click());
await fill('[aria-label="New link title"]', "Talks");
await fill('[aria-label="New link address"]', "talks.example");
await press('section[aria-label="Links"] .add', "Add link");
await page.$eval('button[aria-label="Move Talks up"]', (el) => el.click());
if (values.image) await press('section[aria-label="Avatar"]', "Remove avatar");
await fill("#field-3", "");
await shot("edited");
await saveOnce("second save with bio, link edit, removal, addition, reorder, avatar removal and a cleared field");

onChain = await chain(pair.address);
check(onChain?.bio === "Edited in one go.", "new bio on chain");
check(JSON.stringify(onChain?.links.map((l) => l.title)) === JSON.stringify(["Talks", "Writing"]), `links on chain: Talks then Writing (${onChain?.links.map((l) => l.title)})`);
check(!values.image || onChain?.avatar === null, "avatar removed on chain");
check(field(onChain, "typed:Email") === null, "the emptied Email field is gone");

// --- 3. Cancel sends nothing ------------------------------------------------------------------
await fill("#bio", "Never saved.");
const before = log.signatures;
await press(".savebar", "Cancel");
check((await page.$eval("#bio", (el) => el.value)) === "Edited in one go.", "Cancel puts the bio back");
check(log.signatures === before, "Cancel asks for no signature");

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no horizontal scroll (${overflow})`);
check(log.errors.length === 0, `no console errors${log.errors.length ? `: ${log.errors.join(" | ")}` : ""}`);

await browser.close();
await server.close();
await api.disconnect();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
