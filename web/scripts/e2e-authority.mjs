// End-to-end check of the authority page in a real Chrome against a LOCAL dev node, with a fake
// wallet extension that signs with dev keys the way extensions sign (it is handed the payload).
//
//   ../target/release/identitee-node --dev --tmp
//   VITE_RPC=ws://127.0.0.1:9944 npx vite build --outDir .shot-dist
//   node scripts/e2e-authority.mjs --dist .shot-dist --tag desktop
//   node scripts/e2e-authority.mjs --dist .shot-dist --tag mobile --width 390 --height 844 --scale 2
//
// The run: a fresh zero-balance account asks for a private custom field to be checked from its own
// Requests page, and for a public field, a website and a GitHub name directly on chain; it never
// sees the Authority link nor the page, and neither does Bob (an agent that only migrates). Alice (agent of authority 0 in dev) finds the
// link in her menu, verifies the public field, pastes the person's verification packet and verifies
// the private field, rejects the value of a fourth (recorded on the identity, the profile shows
// Rejected), dismisses the third with a reason (nothing recorded), records and revokes the identity
// document, reserves a name and gives a username to another account. After every action it reads
// what the CHAIN holds, not what the page says, and it checks that the private value and its salt
// never went out on the WebSocket.
//
// It writes to the chain, so it refuses any node that is not a development or local chain, and it
// fails if a page opens any WebSocket to anything but that node.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToHex, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate, randomAsU8a } from "@polkadot/util-crypto";
import puppeteer from "puppeteer-core";
import { preview } from "vite";
import { privateCommitment, publicCommitment } from "../src/chain/formulas.ts";
import { makePacket } from "../src/chain/packet.ts";

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
const pendingKeys = async (pair) =>
  (await api.query.identitee.pendingRequests.entries(pair.address)).map(([k]) => JSON.stringify(json(k.args[1])[1])).sort();
const attestation = async (pair, key) => json(await api.query.identitee.fieldAttestations(pair.address, key, 0));
const fact = async (pair, kind) => json(await api.query.identitee.facts(pair.address, [kind, 0]));
const nameOf = async (pair) => {
  const name = json(await api.query.identitee.nameOf(pair.address));
  return name === null ? null : Buffer.from(name.slice(2), "hex").toString();
};
const reserved = async (name) => (await api.query.identitee.reserved(hex(name))).isSome;
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
/** Every frame a page sent on a WebSocket, to look for the private value afterwards. */
const frames = [];

/** A page in its own browser context (empty localStorage), with a wallet extension that holds `pair`. */
async function openPage(pair, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: +values.width, height: +values.height, deviceScaleFactor: +values.scale });
  const log = { signatures: 0, errors: [] };
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
  cdp.on("Network.webSocketFrameSent", (e) => frames.push(e.response.payloadData));
  return { context, page, log };
}

const url = (path) => new URL(path, base).href;
/** A screenshot of the whole page (`full`) or the viewport. For the whole page the viewport is made as
 * tall as the page first: a capture beyond the viewport leaves the fixed background where it was, a
 * band of smoke over a black rest. */
const shot = async (page, name, full = true) => {
  await page.evaluate(() => document.fonts.ready);
  const viewport = page.viewport();
  if (full) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > viewport.height) await page.setViewport({ ...viewport, height });
  }
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(SHOTS, `e2e-authority-${name}-${values.tag}.png`) });
  if (full) await page.setViewport(viewport);
};
const textOf = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());
const waitText = (page, selector, text, timeout = 30_000) =>
  page.waitForFunction((s, t) => document.querySelector(s)?.textContent.trim() === t, { timeout }, selector, text);
const waitSelector = (page, selector, timeout = 30_000) => page.waitForSelector(selector, { timeout });
const waitGone = (page, selector, timeout = 30_000) => page.waitForSelector(selector, { hidden: true, timeout });
const click = async (page, selector) => {
  await page.waitForSelector(selector);
  await page.click(selector);
};
/** Click the enabled button whose text is `text` inside `scope`. */
async function press(page, scope, text) {
  const handle = await page.evaluateHandle(
    (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text && !b.disabled),
    scope,
    text,
  );
  if (!handle.asElement()) throw new Error(`no enabled "${text}" in ${scope}`);
  await handle.asElement().click();
}
async function fill(page, selector, text) {
  await page.focus(selector);
  await page.$eval(selector, (el) => el.select());
  await page.keyboard.press("Backspace");
  if (text !== "") await page.type(selector, text);
}
/** Put a long text in a field at once, as a paste does. */
const paste = (page, selector, text) =>
  page.$eval(
    selector,
    (el, text) => {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    text,
  );
const warm = (page) => page.screenshot({ type: "png" }); // the first capture of a WebGL page is black
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (label) => `button[aria-label="${label}"]`;
const REQUESTS = 'section[aria-label="Requests"]';
const ACCOUNTS = 'section[aria-label="Accounts"]';
const RESERVED = 'section[aria-label="Reserved names"]';
const menuLinks = (page) => page.$$eval(".menu-links a", (els) => els.map((a) => a.textContent.trim()));

/** The page has no horizontal scroll and nothing runs past the card. */
async function checkFit(page, label) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(scroll <= inner, `${label}: no horizontal overflow (${scroll} of ${inner})`);
}

// --- The accounts ---------------------------------------------------------------------------------

const fresh = () => keyring.addFromMnemonic(mnemonicGenerate());
const person = fresh();
const named = fresh();
const tag = Buffer.from(randomAsU8a(3)).toString("hex");
const email = `person-${tag}@example.org`;
const phone = `+33 6 12 ${tag}`;
const salt = randomAsU8a(32);
const commitment = privateCommitment(salt, phone);
// a name of its own on each run: a node kept between runs holds the requests of earlier ones
const patName = `Pat ${tag}`;
// the inbox names a person by name and short address, since two people can give themselves the same name
const patPerson = `${patName} (${person.address.slice(0, 8)}…${person.address.slice(-8)})`;

await onChain(
  idt.setIdentity([
    [{ Typed: "DisplayName" }, { Public: hex(patName) }],
    [{ Typed: "Email" }, { Public: hex(email) }],
    [{ Typed: "Web" }, { Public: hex("https://pat.example") }],
    [{ Typed: "GitHub" }, { Public: hex(`pat-${tag}`) }],
    [{ Custom: hex("phone") }, { Private: commitment }],
  ]),
  person,
);
await onChain(idt.setIdentity([[{ Typed: "DisplayName" }, { Public: hex("Nameless Example") }]]), named);
for (const pair of [person, named]) check((await balance(pair)) === 0n, `${pair.address.slice(0, 8)}… has a zero balance`);

// --- 1. The person asks, and never sees the authority page ------------------------------------------

console.log(`\n== the person asks (${values.tag}) ==`);
const { page: p, log: pLog } = await openPage(person, "Pat");
{
  await p.goto(url("/requests"), { waitUntil: "networkidle0" });
  await click(p, ".card button.primary");
  await waitSelector(p, 'section[aria-label="Verification"]');
  await warm(p);
  // a custom field is asked for by hand from this page; typed fields are verified from /me through
  // the verification service, so their requests are sent to the chain directly, as any wallet can
  await click(p, ask("Request verification of phone"));
  await waitText(p, 'section[aria-label="Verification"] .status', "Request sent.");
  for (const typed of ["Email", "Web", "GitHub"]) await onChain(idt.requestJudgement(0, { Field: { Typed: typed } }), person);
  const keys = await pendingKeys(person);
  check(
    JSON.stringify(keys) === JSON.stringify([`{"field":{"custom":"0x70686f6e65"}}`, `{"field":{"typed":"Email"}}`, `{"field":{"typed":"Web"}}`, `{"field":{"typed":"GitHub"}}`].sort()),
    `the chain holds the four requests (${keys.join(", ")})`,
  );
  await click(p, "header button.connect");
  await waitSelector(p, ".menu-links");
  await sleep(1500);
  check(!(await menuLinks(p)).includes("Authority"), `the person's menu has no Authority link (${(await menuLinks(p)).join(", ")})`);
  await p.goto(url("/authority"), { waitUntil: "networkidle0" });
  await waitText(p, ".stage .note", "Page not found.");
  check(true, "the person going to /authority gets Page not found.");
  await shot(p, "not-agent");
}
const { page: b, log: bLog } = await openPage(bob, "Bob");
{
  await b.goto(url("/authority"), { waitUntil: "networkidle0" });
  await click(b, ".card button.primary");
  await waitText(b, ".stage .note", "Page not found.");
  check(true, "Bob, an agent that only migrates, gets Page not found. on /authority");
}

// --- 2. Alice: the link, the page --------------------------------------------------------------------

console.log(`\n== Alice (${values.tag}) ==`);
const { page: a, log: aLog } = await openPage(alice, "Alice");
await a.goto(url("/"), { waitUntil: "networkidle0" });
await click(a, ".card button.primary");
await waitSelector(a, "header button.connect");
await warm(a);
await click(a, "header button.connect");
await a.waitForFunction(() => [...document.querySelectorAll(".menu-links a")].some((l) => l.textContent.trim() === "Authority"), { timeout: 20_000 });
check(true, "Alice's menu has the Authority link");
await shot(a, "menu", false);
await a.click('.menu-links a[href="/authority"]');
await waitSelector(a, '.card[aria-label="Authority"]');
await a.waitForFunction((who) => document.querySelectorAll(`ul[aria-label="Requests from ${who}"] > li`).length === 4, { timeout: 30_000 }, patPerson);
check(true, "the inbox lists the person's four requests");
check((await textOf(a, ".card .name")) === "identitee", "the card is headed by the authority's name");
await shot(a, "inbox");
await checkFit(a, "inbox");

// --- 3. Verify the public field ------------------------------------------------------------------

{
  const before = aLog.signatures;
  await click(a, ask(`Verify Email of ${patPerson}`));
  await waitText(a, `${REQUESTS} .status`, "Email verified.");
  const att = await attestation(person, { Typed: "Email" });
  check(att?.verdict === "Verified" && att.commitment === publicCommitment(email), "the chain holds Alice's verification of the email, for its value");
  check(aLog.signatures === before + 1, "one signature");
}

// --- 4. The private field, with the packet -----------------------------------------------------------

{
  const packet = JSON.stringify(
    await makePacket({ chain: api.genesisHash.toHex(), address: person.address, ref: { custom: "phone" }, value: stringToU8a(phone), salt }, async (data) =>
      u8aToHex(person.sign(u8aWrapBytes(hexToU8a(data)))),
    ),
  );
  check(!(await a.$(ask(`Verify phone of ${patPerson}`))), "a private field has no Verify before its packet");
  // a packet from someone else is refused
  const forged = JSON.stringify(
    await makePacket({ chain: api.genesisHash.toHex(), address: named.address, ref: { custom: "phone" }, value: stringToU8a(phone), salt }, async (data) =>
      u8aToHex(named.sign(u8aWrapBytes(hexToU8a(data)))),
    ),
  );
  await click(a, ask(`Check the packet for phone of ${patPerson}`));
  await waitSelector(a, `${REQUESTS} textarea`);
  await paste(a, `${REQUESTS} textarea`, forged);
  await press(a, REQUESTS, "Check");
  await waitText(a, `${REQUESTS} [role="alert"]`, "This packet is signed by another account than the one that asked.");
  check(true, "a packet signed by another account is refused");
  await paste(a, `${REQUESTS} textarea`, packet);
  await shot(a, "packet-pasted");
  await press(a, REQUESTS, "Check");
  await waitSelector(a, `${REQUESTS} .packet-value`);
  check((await textOf(a, `${REQUESTS} .packet-value`)) === phone, "the checked packet shows the value, for Alice to check");
  check((await a.$(`${REQUESTS} textarea`)) === null, "the pasted packet is no longer on the page");
  await shot(a, "packet-checked");
  await press(a, '[aria-label="Packet for phone"]', "Verify");
  await waitText(a, `${REQUESTS} .status`, "phone verified.");
  const att = await attestation(person, { Custom: hex("phone") });
  check(att?.verdict === "Verified" && att.commitment === commitment, "the chain holds the verification of the private field, for its commitment");
  check(!(await a.evaluate((v) => document.body.innerHTML.includes(v), phone)), "the value left the page once used");
}

// --- 5. Reject a value, dismiss a request -------------------------------------------------------------

{
  await click(a, ask(`Reject the value of GitHub of ${patPerson}`));
  await waitSelector(a, '[aria-label="Reject the value of GitHub"]');
  await shot(a, "refuse");
  await press(a, '[aria-label="Reject the value of GitHub"]', "Reject the value");
  await waitText(a, `${REQUESTS} .status`, "GitHub rejected.");
  const att = await attestation(person, { Typed: "GitHub" });
  check(att?.verdict === "Rejected" && att.commitment === publicCommitment(`pat-${tag}`), "the chain holds the Rejected verdict on the GitHub value");

  await click(a, ask(`Dismiss the request for Website of ${patPerson}`));
  await waitSelector(a, '[aria-label="Dismiss the request for Website"] select');
  await a.select('[aria-label="Dismiss the request for Website"] select', "ValueMismatch");
  await a.type('[aria-label="Dismiss the request for Website"] input', "site unreachable");
  await shot(a, "dismiss");
  await press(a, '[aria-label="Dismiss the request for Website"]', "Dismiss request");
  await waitText(a, `${REQUESTS} .status`, "Request dismissed.");
  check((await pendingKeys(person)).length === 0, "the person has no request left");
  check((await attestation(person, { Typed: "Web" })) === null, "a dismissal records nothing on the identity");

  // the public profile reads the verdicts from the chain
  await p.goto(url(`/a/${person.address}`), { waitUntil: "networkidle0" });
  await p.waitForSelector(".card .level");
  const states = await p.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll(".fields .row")].map((r) => [r.querySelector("dt")?.textContent.trim(), r.querySelector(".state")?.getAttribute("title") ?? ""])),
  );
  check(states.GitHub === "Rejected" && states.Email === "Verified" && states.phone === "Verified", `the profile shows GitHub Rejected, Email and phone Verified (${JSON.stringify(states)})`);
  await shot(p, "profile-after");
}

// --- 6. Accounts: the identity document -------------------------------------------------------------

{
  await fill(a, `${ACCOUNTS} input[aria-label="Account address"]`, person.address);
  await press(a, ACCOUNTS, "Look up");
  await waitSelector(a, 'ul[aria-label="Facts"]');
  await a.type(`${ACCOUNTS} input[aria-label="Note"]`, "passport seen");
  await click(a, ask(`Record the identity document of ${patName}`));
  await waitText(a, `${ACCOUNTS} .status`, "Identity document recorded.");
  let doc = await fact(person, "DocumentChecked");
  check(doc !== null && doc.revoked === null && Buffer.from(doc.note.slice(2), "hex").toString() === "passport seen", "the chain holds the identity document, with its note");
  await shot(a, "account");
  await a.select(`${ACCOUNTS} select`, "UserRequest");
  await click(a, ask(`Revoke Identity document of ${patName}`));
  await press(a, `${ACCOUNTS} .confirm`, "Revoke");
  await waitText(a, `${ACCOUNTS} .status`, "Identity document revoked.");
  doc = await fact(person, "DocumentChecked");
  check(doc?.revoked?.[1] === "UserRequest", "the chain holds the revocation, with its reason");
}

// --- 7. Names: reserve, give ----------------------------------------------------------------------

{
  const name = `pat${tag}`;
  await fill(a, `${RESERVED} input`, name);
  await a.waitForFunction((s, n) => document.querySelector(`${s} [aria-live]`)?.textContent.trim() === `${n} is available.`, { timeout: 20_000 }, RESERVED, name);
  await press(a, RESERVED, "Reserve");
  await waitText(a, `${RESERVED} .status[role=status]`, `${name} reserved.`);
  check(await reserved(name), "the chain holds the reservation");
  await shot(a, "reserved");

  await fill(a, `${ACCOUNTS} input[aria-label="Account address"]`, named.address);
  await press(a, ACCOUNTS, "Look up");
  await waitSelector(a, `${ACCOUNTS} input[aria-label="Username to give"]`);
  await fill(a, `${ACCOUNTS} input[aria-label="Username to give"]`, name);
  await a.waitForFunction((s, n) => document.querySelector(`${s} [aria-live]`)?.textContent.trim() === `${n} is reserved: you can give it.`, { timeout: 20_000 }, ACCOUNTS, name);
  await press(a, ACCOUNTS, "Give");
  await waitText(a, `${ACCOUNTS} .status[role=status]`, `${name} given.`);
  check((await nameOf(named)) === name, `the chain gives ${name} to the other account`);
  check(!(await reserved(name)), "the reservation was used up");
  await shot(a, "given");
  await checkFit(a, "authority page");
}

// --- 8. Everything together --------------------------------------------------------------------------------

console.log(`\n== whole run (${values.tag}) ==`);
for (const [who, page, log] of [["person", p, pLog], ["bob", b, bLog], ["alice", a, aLog]]) {
  const body = await page.evaluate(() => document.body.innerText);
  check(!/[·—]/.test(body), `${who}: no separator dot, no em dash`);
  check(!/\bfees?\b|\bIDT\b|\bcosts?\b|\bbalance\b|\bgas\b/i.test(body), `${who}: no fee, price or balance`);
  const fonts = await page.evaluate(() => [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))]);
  check(fonts.every((f) => /Inter/.test(f) && !/mono/i.test(f)), `${who}: Inter only (${fonts.join(" | ")})`);
  check(log.errors.length === 0, `${who}: no console error or warning${log.errors.length ? `: ${log.errors.join(" / ")}` : ""}`);
}
const wire = frames.join("\n");
const needles = { value: phone, "value (hex)": u8aToHex(stringToU8a(phone)).slice(2), salt: u8aToHex(salt).slice(2) };
for (const [what, needle] of Object.entries(needles)) check(!wire.includes(needle), `the private ${what} never went out on a WebSocket (${frames.length} frames)`);
check(wire.includes(commitment.slice(2)), "the commitment did (the verdict carries it)");
const local = new URL(values.node);
check(
  [...sockets].every((s) => new URL(s).host === local.host),
  `every WebSocket the pages opened went to ${local.host} (${[...sockets].join(", ")})`,
);
for (const pair of [person, named]) check((await balance(pair)) === 0n, `${pair.address.slice(0, 8)}… still has a zero balance`);

await browser.close();
await server.close();
await api.disconnect();
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
