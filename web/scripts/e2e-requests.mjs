// End-to-end check of the requests page in a real Chrome against a LOCAL dev node, with a fake wallet
// extension that signs with dev keys the way extensions sign (it is handed the payload).
//
//   ../target/release/identitee-node --dev --tmp
//   VITE_RPC=ws://127.0.0.1:9944 npx vite build --outDir .shot-dist
//   node scripts/e2e-requests.mjs --dist .shot-dist --tag desktop
//   node scripts/e2e-requests.mjs --dist .shot-dist --tag mobile --width 390 --height 844 --scale 2
//
// The run, with fresh zero-balance accounts: verification requests for custom fields (request,
// cancel, a private field pointing to its packet, a typed field's request made elsewhere taken
// back, the authority's answer arriving while the page is open), the
// username (names that cannot exist never reach the chain, the check follows the typing, claim,
// release, the day of waiting), sub-accounts (propose from one account, accept, decline, rename,
// leave, withdraw and remove from another), and migration (request, cancel, refused, imported).
// After every action it reads what the CHAIN holds, not what the page says, and it counts the
// signatures asked of the wallet.
//
// It writes to the chain, so it refuses any node that is not a development or local chain, and it
// fails if the page opens any WebSocket to anything but that node.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { stringToHex } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate, randomAsU8a } from "@polkadot/util-crypto";
import puppeteer from "puppeteer-core";
import { preview } from "vite";
import { privateCommitment, publicCommitment } from "../src/chain/formulas.ts";

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
const hex = stringToHex;

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(values.node), noInitWarn: true });
const chainType = (await api.rpc.system.chainType()).type;
if (chainType !== "Development" && chainType !== "Local") {
  await api.disconnect();
  throw new Error(`Refusing to run against ${values.node}: it is a ${chainType} chain. Use a node started with --dev.`);
}
const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
const alice = keyring.addFromUri("//Alice");
const bob = keyring.addFromUri("//Bob");
const idt = api.tx.identitee;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

function findChrome() {
  const root = join(homedir(), ".cache/puppeteer/chrome");
  return join(root, readdirSync(root).sort().at(-1), "chrome-linux64/chrome");
}

/** Send and wait until the call is in a block; fail loudly otherwise. */
async function onChain(call, signer) {
  await new Promise((resolve, reject) => {
    call
      .signAndSend(signer, (r) => {
        if (r.dispatchError) {
          const e = r.dispatchError;
          reject(new Error(e.isModule ? api.registry.findMetaError(e.asModule).name : e.toString()));
        } else if (r.isError) reject(new Error(r.status.type));
        else if (r.status.isInBlock) resolve();
      })
      .catch((e) => reject(new Error(String(e.message).split("\n")[0])));
  });
}

// --- What the chain holds ------------------------------------------------------------------------

const json = (value) => JSON.parse(JSON.stringify(value.toJSON()));
const pending = async (pair) =>
  (await api.query.identitee.pendingRequests.entries(pair.address)).map(([k, block]) => ({ target: json(k.args[1])[1], block: block.toJSON() }));
const pendingKeys = async (pair) => (await pending(pair)).map((p) => JSON.stringify(p.target)).sort();
const profileOf = async (pair) => json(await api.call.identiteeApi.profile(pair.publicKey));
const nameOf = async (pair) => {
  const profile = await profileOf(pair);
  return profile?.name ? Buffer.from(profile.name.slice(2), "hex").toString() : null;
};
const parentOf = async (pair) => {
  const parent = json(await api.call.identiteeApi.parentOf(pair.publicKey));
  return parent === null ? null : { address: keyring.encodeAddress(parent[0]), label: Buffer.from(parent[1].slice(2), "hex").toString() };
};
const subsOf = async (pair) =>
  json(await api.call.identiteeApi.subsOf(pair.publicKey)).map(([a, l]) => [keyring.encodeAddress(a), Buffer.from(l.slice(2), "hex").toString()]);
const pendingSubs = async (pair) =>
  json(await api.call.identiteeApi.pendingSubsOf(pair.publicKey)).map(([a, l]) => [keyring.encodeAddress(a), Buffer.from(l.slice(2), "hex").toString()]);
const balance = async (pair) => (await api.query.system.account(pair.address)).data.free.toBigInt();

// --- The browser ----------------------------------------------------------------------------------

const server = await preview({ build: { outDir: values.dist }, preview: { port: 0, host: "127.0.0.1" } });
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu", "--ignore-gpu-blocklist"],
  // On a machine with an NVIDIA card, point EGL at its driver so WebGL renders on the GPU.
  env: existsSync(NVIDIA_EGL) ? { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: NVIDIA_EGL } : process.env,
});

const sockets = new Set();

/** A page in its own browser context (empty localStorage), with a wallet extension that holds `pair`. */
async function openPage(pair, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: +values.width, height: +values.height, deviceScaleFactor: +values.scale });
  const log = { signatures: 0, errors: [], nameChecks: 0 };
  await page.exposeFunction("__identiteeSign", async (payload) => {
    log.signatures++;
    const { signature } = api.registry.createType("ExtrinsicPayload", payload, { version: payload.version }).sign(pair);
    return { signature };
  });
  await page.evaluateOnNewDocument(
    (accounts) => {
      let id = 0;
      window.injectedWeb3 = {
        "polkadot-js": {
          version: "0.0.0",
          enable: async () => ({
            accounts: { get: async () => accounts, subscribe: (cb) => (cb(accounts), () => undefined) },
            signer: { signPayload: async (payload) => ({ id: ++id, ...(await window.__identiteeSign(payload)) }) },
          }),
        },
      };
    },
    [{ address: pair.address, name, type: "sr25519" }],
  );
  // the verification service is never reached: its list of channels is answered here, empty, and
  // any other request that leaves the page's origin (or the web fonts) is refused and fails the run
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
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", (e) => sockets.add(e.url));
  cdp.on("Network.webSocketFrameSent", (e) => {
    if (e.response.payloadData.includes("IdentiteeApi_name_status")) log.nameChecks++;
  });
  return { context, page, log };
}

const url = (path) => new URL(path, base).href;
const shot = async (page, name, full = true) => {
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: join(SHOTS, `e2e-requests-${name}-${values.tag}.png`), fullPage: full });
};
const textOf = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());
const exists = async (page, selector) => (await page.$(selector)) !== null;
const waitText = (page, selector, text, timeout = 30_000) =>
  page.waitForFunction((s, t) => document.querySelector(s)?.textContent.trim() === t, { timeout }, selector, text);
const waitSelector = (page, selector, timeout = 30_000) => page.waitForSelector(selector, { timeout });
const waitGone = (page, selector, timeout = 30_000) => page.waitForSelector(selector, { hidden: true, timeout });
const click = async (page, selector) => {
  await page.waitForSelector(selector);
  await page.click(selector);
};
/** Click the button whose text is `text` inside `scope`. */
async function press(page, scope, text) {
  const handle = await page.evaluateHandle(
    (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text && !b.disabled),
    scope,
    text,
  );
  if (!handle.asElement()) throw new Error(`no enabled "${text}" in ${scope}`);
  await handle.asElement().click();
}
async function fill(page, selector, text, delay = 0) {
  await page.focus(selector);
  await page.$eval(selector, (el) => el.select());
  await page.keyboard.press("Backspace");
  if (text !== "") await page.type(selector, text, { delay });
}
const warm = (page) => page.screenshot({ type: "png" }); // the first capture of a WebGL page is black
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERIFY = 'section[aria-label="Verification"]';
const NAME = 'section[aria-label="Username"]';
const SUBS = 'section[aria-label="Sub-accounts"]';
const MIGRATION = 'section[aria-label="Migration"]';
const ask = (label) => `button[aria-label="${label}"]`;
const rowState = (page, label) =>
  page.evaluate(
    (label) => {
      const row = [...document.querySelectorAll(".ask")].find((r) => r.querySelector(".ask-label")?.textContent.trim() === label);
      return row ? (row.querySelector(".state")?.textContent.trim() ?? "") : null;
    },
    label,
  );
const waitRowState = (page, label, state, timeout = 40_000) =>
  page.waitForFunction(
    (label, state) => {
      const row = [...document.querySelectorAll(".ask")].find((r) => r.querySelector(".ask-label")?.textContent.trim() === label);
      return row && (row.querySelector(".state")?.textContent.trim() ?? "") === state;
    },
    { timeout },
    label,
    state,
  );

/** The page has no horizontal scroll and nothing runs past the card. */
async function checkFit(page, label) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(scroll <= inner, `${label}: no horizontal overflow (${scroll} of ${inner})`);
}

// --- The accounts ---------------------------------------------------------------------------------

const fresh = () => keyring.addFromMnemonic(mnemonicGenerate());
const main = fresh();
const kid = fresh();
const mover = fresh();
const email = `main-${Buffer.from(randomAsU8a(4)).toString("hex")}@example.org`;
const telegram = "@main_tg";
const MASTODON = "@main@m.example";
const salt = randomAsU8a(32);

await onChain(
  idt.setIdentity([
    [{ Typed: "DisplayName" }, { Public: hex("Main Account") }],
    [{ Typed: "Email" }, { Public: hex(email) }],
    [{ Typed: "Web" }, { Public: hex("https://main.example") }],
    [{ Typed: "Telegram" }, { Private: privateCommitment(salt, telegram) }],
    [{ Custom: hex("mastodon") }, { Public: hex(MASTODON) }],
    [{ Custom: hex("phone") }, { Private: privateCommitment(salt, "+33 6 00 00 00 00") }],
  ]),
  main,
);
await onChain(idt.addLink(hex("Notes"), hex("https://main.example/notes")), main);
for (const pair of [main, kid, mover]) check((await balance(pair)) === 0n, `${pair.address.slice(0, 8)}… has a zero balance`);

// --- 1. Not connected ------------------------------------------------------------------------------

console.log(`\n== not connected (${values.tag}) ==`);
const { context: mainContext, page, log } = await openPage(main, "Main");
{
  await page.goto(url("/requests"), { waitUntil: "networkidle0" });
  await page.waitForSelector('.card[aria-label="Connect"]');
  await warm(page);
  check(
    (await textOf(page, ".card .note")) === "Connect your wallet to see your requests." && (await textOf(page, ".card button.primary")) === "Connect wallet",
    "/requests without a wallet connected shows the Connect wallet card, saying what for",
  );
  check((await page.$("header button")) === null, "the header has no second Connect wallet button there");
  await shot(page, "connect");
  await click(page, ".card button.primary");
  await waitSelector(page, '.card[aria-label="Requests"]');
  check(new URL(page.url()).pathname === "/requests", "connecting stays on /requests and shows the page");
}

// --- 2. Verification ---------------------------------------------------------------------------------

console.log(`\n== verification (${values.tag}) ==`);
{
  // typed fields are verified from /me, by the verification service: only custom fields, links and
  // requests already made are listed here
  const labels = await page.$$eval(`${VERIFY} .ask-label`, (els) => els.map((e) => e.textContent.trim()));
  check(
    JSON.stringify(labels) === JSON.stringify(["mastodon", "phone", "Notes"]),
    `the list offers the custom fields and the link, not the typed fields: ${labels.join(", ")}`,
  );
  await checkFit(page, "requests page");
  await shot(page, "initial");

  let before = log.signatures;
  await click(page, ask("Request verification of mastodon"));
  await waitText(page, `${VERIFY} .status`, "Request sent.");
  check(log.signatures - before === 1, "a request takes one signature");
  check(JSON.stringify(await pendingKeys(main)) === JSON.stringify([JSON.stringify({ field: { custom: hex("mastodon") } })]), "the chain holds the request for mastodon, to authority 0");
  check((await rowState(page, "mastodon")) === "Pending", "the row says Pending, read back from the chain");

  await click(page, ask("Cancel the request for mastodon"));
  await waitText(page, `${VERIFY} .status`, "Request cancelled.");
  check((await pending(main)).length === 0, "cancelling removes it from the chain");
  check((await rowState(page, "mastodon")) === "", "the row has no state again");

  await click(page, ask("Request verification of mastodon"));
  await waitText(page, `${VERIFY} .status`, "Request sent.");
  check(!(await exists(page, "p.ask-note")), "a public field shows no packet note");
  await click(page, ask("Request verification of phone"));
  await waitSelector(page, "p.ask-note");
  const note = await page.$eval("p.ask-note", (el) => ({ text: el.textContent.trim(), href: el.querySelector("a")?.getAttribute("href") }));
  check(note.text === "Make its verification packet in My identity and send it to identitee." && note.href === "/me", "a pending private field points to the packet in My identity");
  check((await pending(main)).length === 2, "two requests on the chain");

  // a typed field asked about outside this page is listed, so that it can be taken back
  await onChain(idt.requestJudgement(0, { Field: { Typed: "Email" } }), main);
  await page.reload({ waitUntil: "networkidle0" });
  await waitSelector(page, ask("Cancel the request for Email"));
  check((await rowState(page, "Email")) === "Pending", "a request for a typed field made elsewhere is listed as Pending, with a Cancel");
  await shot(page, "verification-pending");

  // the public profile says Pending only for what an authority was asked about
  {
    const { context, page: pub } = await openPage(main, "Main");
    await pub.goto(url(`/a/${main.address}`), { waitUntil: "networkidle0" });
    await pub.waitForSelector(".card .level");
    const states = await pub.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll(".fields .row")].map((r) => [r.querySelector("dt")?.textContent.trim(), r.querySelector(".state")?.getAttribute("title") ?? ""])),
    );
    check(
      states.Email === "Pending" && states.mastodon === "Pending" && states.phone === "Pending" && states.Website === "" && states.Telegram === "",
      `the public profile says Pending for the three fields asked about and nothing for the others (${JSON.stringify(states)})`,
    );
    await context.close();
  }

  await click(page, ask("Cancel the request for Email"));
  await waitText(page, `${VERIFY} .status`, "Request cancelled.");
  check((await pending(main)).length === 2, "the typed field's request is cancelled from here");
  await waitGone(page, ask("Cancel the request for Email"));
  check(!(await page.$$eval(`${VERIFY} .ask-label`, (els) => els.map((e) => e.textContent.trim()))).includes("Email"), "and its row goes away");

  // the authority answers while the page is open: the page finds out by itself
  await onChain(idt.provideJudgement(main.address, { Custom: hex("mastodon") }, publicCommitment(MASTODON), "Verified", "Manual", null), alice);
  await waitRowState(page, "mastodon", "Verified");
  check(true, "the page showed Verified without being touched (it reads the chain again while a request waits)");
  check((await pending(main)).length === 1, "the answered request is gone from the chain");
  check(!(await exists(page, ask("Cancel the request for mastodon"))), "no Cancel on a verified field");
  await shot(page, "verification-verified");
}

// --- 3. Username ---------------------------------------------------------------------------------------

console.log(`\n== username (${values.tag}) ==`);
{
  const INPUT = `${NAME} input`;
  check(!(await exists(page, `${NAME} .hint`)), "a verified field takes the cannot-claim hint away");
  const checksBefore = log.nameChecks;
  const claimDisabled = () => page.$eval(`${NAME} button[type=submit]`, (b) => b.disabled);
  for (const [typed, message] of [
    ["ab", "Names have at least 3 characters."],
    ["Bad Name!", "Names use only a to z, 0 to 9, hyphens and underscores."],
    ["requests", "That name belongs to a page of this site and cannot be taken."],
    ["authority", "That name belongs to a page of this site and cannot be taken."],
  ]) {
    await fill(page, INPUT, typed, 20);
    await waitText(page, `${NAME} .problem`, message);
    check(await claimDisabled(), `"${typed}" is refused locally with its reason, Claim is off`);
  }
  await sleep(700);
  check(log.nameChecks === checksBefore, `none of those names reached the chain (${log.nameChecks - checksBefore} name checks)`);
  await shot(page, "name-refused");

  const name = `e2e-${Buffer.from(randomAsU8a(3)).toString("hex")}`;
  await fill(page, INPUT, name, 40);
  await waitText(page, `${NAME} .status`, `${name} is available.`);
  check(log.nameChecks === checksBefore + 1, `typing ${name.length} characters in one go asked the chain once (${log.nameChecks - checksBefore})`);
  check(!(await claimDisabled()), "an available name can be claimed");
  await shot(page, "name-available");

  const before = log.signatures;
  await press(page, NAME, "Claim");
  await waitText(page, `${NAME} .member`, `Your username is ${name}.`);
  check(log.signatures - before === 1, "a claim takes one signature");
  check((await nameOf(main)) === name, `the chain says the name is ${name}`);
  check((await page.$eval(`${NAME} .member a`, (a) => a.getAttribute("href"))) === `/${name}`, "the name links to its public page");
  await shot(page, "name-claimed");

  await press(page, NAME, "Release username");
  await waitSelector(page, `${NAME} .confirm`);
  const ask1 = await textOf(page, `${NAME} .confirm .hint`);
  check(ask1 === `Release ${name}? Nobody can claim it for 30 days, and you cannot claim a name for 1 day.`, `the release says what it costs: ${ask1}`);
  check((await nameOf(main)) === name, "nothing is released before the confirmation");
  await shot(page, "name-release-confirm");
  await press(page, `${NAME} .confirm`, "Release");
  await waitText(page, `${NAME} .status`, "Username released.");
  check((await nameOf(main)) === null, "the chain has released the name");
  const hint = await textOf(page, `${NAME} .hint`);
  check(/^You released a name recently\. You can claim one again in about (23|24) hours\.$/.test(hint) || /about 1 day/.test(hint), `the day of waiting is shown: ${hint}`);
  await fill(page, INPUT, name, 40);
  await waitText(page, `${NAME} .problem`, "That name was released recently. It can be claimed again in about 30 days.");
  check(await claimDisabled(), "the released name cannot be claimed again, by anyone");
  await shot(page, "name-released");
  await fill(page, INPUT, "");
}

// --- 4. Sub-accounts -------------------------------------------------------------------------------------

console.log(`\n== sub-accounts (${values.tag}) ==`);
const kidPage = await openPage(kid, "Kid");
{
  const ADDRESS = `${SUBS} input[aria-label="Account address"]`;
  const LABEL = `${SUBS} input[aria-label="Label"]`;
  const propose = async (label) => {
    await fill(page, ADDRESS, kid.address);
    await fill(page, LABEL, label);
    await press(page, SUBS, "Propose");
    await waitText(page, `${SUBS} .status`, "Proposal sent.");
  };
  const short = (a) => `${a.slice(0, 8)}…${a.slice(-8)}`;

  await fill(page, ADDRESS, "not an address");
  await waitText(page, `${SUBS} .problem`, "That is not a valid account address.");
  await fill(page, ADDRESS, main.address);
  await waitText(page, `${SUBS} .problem`, "An account cannot be its own sub-account.");
  await fill(page, ADDRESS, "");

  // propose, and the other account sees it from its own wallet
  let before = log.signatures;
  await propose("phone");
  check(log.signatures - before === 1, "a proposal takes one signature");
  check(JSON.stringify(await pendingSubs(main)) === JSON.stringify([[kid.address, "phone"]]), "the chain holds the proposal");
  check((await textOf(page, `${SUBS} ul[aria-label="Your sub-accounts"] .state`)) === "Waiting", "the page lists it as Waiting");
  check((await page.$eval(ADDRESS, (e) => e.value)) === "", "the form is cleared");
  await shot(page, "subs-proposed");

  const k = kidPage.page;
  await k.goto(url("/requests"), { waitUntil: "networkidle0" });
  await warm(k);
  await click(k, ".card button.primary");
  await waitSelector(k, `${SUBS} ul[aria-label="Proposals to you"] li`);
  // the parent's name is read after the list, by a second query
  await waitText(k, `${SUBS} ul[aria-label="Proposals to you"] .link-title`, "From Main Account").catch(() => undefined);
  const received = await k.$eval(`${SUBS} ul[aria-label="Proposals to you"] li`, (li) => [li.querySelector(".link-title").textContent.trim(), li.querySelector(".link-url").textContent.trim()]);
  check(
    received[0] === "From Main Account" && received[1] === `${short(main.address)}, would list you as phone`,
    `the other account (no identity at all) sees the proposal, from the parent's name (${received.join(" | ")})`,
  );
  await checkFit(k, "the other account's page");
  await shot(k, "subs-received");
  await click(k, ask("Decline the proposal from Main Account"));
  await waitText(k, `${SUBS} .status`, "Proposal declined.");
  check((await pendingSubs(main)).length === 0, "declining removes the proposal from the chain");

  // the parent's page still shows what it knew until it reads again (it does, every 20 seconds)
  await page.reload({ waitUntil: "networkidle0" });
  await waitSelector(page, ADDRESS);
  check(!(await exists(page, `${SUBS} ul[aria-label="Your sub-accounts"]`)), "the parent reads again and no longer lists the declined proposal");
  await propose("phone");
  await k.reload({ waitUntil: "networkidle0" });
  await waitSelector(k, `${SUBS} ul[aria-label="Proposals to you"] li`);
  before = kidPage.log.signatures;
  await click(k, ask("Accept the proposal from Main Account"));
  await waitText(k, `${SUBS} .status`, "Proposal accepted.");
  check(kidPage.log.signatures - before === 1, "accepting takes one signature, from an account with nothing in it");
  const parent = await parentOf(kid);
  check(parent?.address === main.address && parent.label === "phone", "the chain links the account to its parent");
  await waitText(k, `${SUBS} .member`, "Sub-account of Main Account, listed as phone.").catch(() => undefined);
  check((await textOf(k, `${SUBS} .member`)) === "Sub-account of Main Account, listed as phone.", "the account shows its parent");
  check(!(await exists(k, `${SUBS} form`)), "a sub-account cannot propose sub-accounts");
  await shot(k, "subs-member");

  // the parent reads it again, renames, then the sub leaves
  await page.reload({ waitUntil: "networkidle0" });
  await waitSelector(page, `${SUBS} ul[aria-label="Your sub-accounts"] .state`);
  check((await textOf(page, `${SUBS} ul[aria-label="Your sub-accounts"] .state`)) === "Accepted", "the parent lists it as Accepted");
  await click(page, ask("Rename phone"));
  await fill(page, `${SUBS} input[aria-label="Label of phone"]`, "tablet");
  await press(page, SUBS, "Save");
  await waitText(page, `${SUBS} .status`, "Label changed.");
  check(JSON.stringify(await subsOf(main)) === JSON.stringify([[kid.address, "tablet"]]), "the chain has the new label");
  await shot(page, "subs-renamed");

  await press(k, SUBS, "Leave");
  await waitSelector(k, `${SUBS} .confirm`);
  check((await parentOf(kid)) !== null, "nothing is left before the confirmation");
  await press(k, `${SUBS} .confirm`, "Leave");
  await waitText(k, `${SUBS} .status`, "You left the account.");
  check((await parentOf(kid)) === null && (await subsOf(main)).length === 0, "leaving ends the link on the chain");

  // withdraw a proposal, then remove an accepted link
  await page.reload({ waitUntil: "networkidle0" });
  await waitSelector(page, ADDRESS);
  check(!(await exists(page, `${SUBS} ul[aria-label="Your sub-accounts"]`)), "the parent reads again and no longer lists the account that left");
  await propose("watch");
  await click(page, ask("Withdraw the proposal to watch"));
  await waitText(page, `${SUBS} .status`, "Proposal withdrawn.");
  check((await pendingSubs(main)).length === 0, "withdrawing removes the proposal from the chain");
  await propose("laptop");
  await k.reload({ waitUntil: "networkidle0" });
  await waitSelector(k, ask("Accept the proposal from Main Account"));
  await click(k, ask("Accept the proposal from Main Account"));
  await waitText(k, `${SUBS} .status`, "Proposal accepted.");
  await page.reload({ waitUntil: "networkidle0" });
  await waitSelector(page, ask("Remove laptop"));
  await click(page, ask("Remove laptop"));
  // ending an accepted link asks first
  check((await parentOf(kid)) !== null, "Remove asks before anything is sent");
  await press(page, `${SUBS} .confirm`, "Remove");
  await waitText(page, `${SUBS} .status`, "Sub-account removed.");
  check((await parentOf(kid)) === null && (await subsOf(main)).length === 0, "removing an accepted sub-account ends the link on the chain");
  await checkFit(page, "requests page, long");
  await shot(page, "subs-end");
}

// --- 5. Migration -----------------------------------------------------------------------------------------

console.log(`\n== migration (${values.tag}) ==`);
const moverPage = await openPage(mover, "Mover");
{
  const m = moverPage.page;
  await m.goto(url("/requests"), { waitUntil: "networkidle0" });
  await warm(m);
  await click(m, ".card button.primary");
  await waitSelector(m, MIGRATION);
  const buttons = await m.$$eval(`${MIGRATION} button`, (els) => els.map((e) => e.textContent.trim()));
  check(JSON.stringify(buttons) === JSON.stringify(["Migrate from Polkadot", "Migrate from Kusama"]), "an account with no identity is offered both chains");
  await shot(m, "migration-start");

  const migrationOf = async () => json(await api.query.identitee.migrationRequests(mover.address));
  let before = moverPage.log.signatures;
  await press(m, MIGRATION, "Migrate from Polkadot");
  await waitText(m, `${MIGRATION} .status`, "Migration requested.");
  check(moverPage.log.signatures - before === 1, "a migration request takes one signature");
  check(JSON.stringify((await migrationOf())?.[0]) === '"Polkadot"', "the chain holds a request from Polkadot");
  check((await textOf(m, `${MIGRATION} .member`)) === "Waiting for the migration service to read your Polkadot identity.", "the page says it is waiting");
  await shot(m, "migration-pending");
  await press(m, MIGRATION, "Cancel request");
  await waitText(m, `${MIGRATION} .status`, "Migration request cancelled.");
  check((await migrationOf()) === null, "cancelling removes the request from the chain");

  await press(m, MIGRATION, "Migrate from Kusama");
  await waitText(m, `${MIGRATION} .status`, "Migration requested.");
  await onChain(idt.rejectMigration(mover.address, "Unspecified"), bob);
  check((await migrationOf()) === null, "the migration service refused: the chain keeps no trace");
  await waitText(m, `${MIGRATION} .member`, "The migration from Kusama ended without an import: it was refused or withdrawn. You can ask again.", 45_000);
  check(true, "the page told the refusal by itself, from what this browser saw (the chain forgets it)");
  await shot(m, "migration-refused");

  await press(m, MIGRATION, "Migrate from Polkadot");
  await waitText(m, `${MIGRATION} .status`, "Migration requested.");
  const header = (await api.rpc.chain.getHeader()).number.toNumber();
  const blockHash = (await api.rpc.chain.getBlockHash(header)).toHex();
  await onChain(
    idt.fulfilMigration(mover.address, "Polkadot", header, blockHash, {
      typed: [["Email", hex("mover@example.org")]],
      custom: [],
      judgements: [[5, "Reasonable"]],
    }),
    bob,
  );
  await waitText(m, `${MIGRATION} .member`, `Imported from Polkadot at block ${header}.`, 45_000);
  check(true, "the page showed the import by itself, from the chain's history");
  await shot(m, "migration-imported");
  await checkFit(m, "migration page");
}

// --- 6. Everything together --------------------------------------------------------------------------------

console.log(`\n== whole run (${values.tag}) ==`);
for (const [who, p] of [["main", { page, log }], ["other account", kidPage], ["mover", moverPage]]) {
  const body = await p.page.evaluate(() => document.body.innerText);
  check(!/[·—]/.test(body), `${who}: no separator dot, no em dash`);
  check(!/\bfees?\b|\bIDT\b|\bcosts?\b|\bbalance\b|\bgas\b/i.test(body), `${who}: no fee, price or balance`);
  const fonts = await p.page.evaluate(() => [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))]);
  check(fonts.every((f) => /Inter/.test(f) && !/mono/i.test(f)), `${who}: Inter only (${fonts.join(" | ")})`);
  check(p.log.errors.length === 0, `${who}: no console error or warning${p.log.errors.length ? `: ${p.log.errors.join(" / ")}` : ""}`);
}
const local = new URL(values.node);
check(
  [...sockets].every((s) => new URL(s).host === local.host),
  `every WebSocket the pages opened went to ${local.host} (${[...sockets].join(", ")})`,
);
for (const pair of [main, kid, mover]) check((await balance(pair)) === 0n, `${pair.address.slice(0, 8)}… still has a zero balance`);

await browser.close();
await server.close();
await api.disconnect();
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
