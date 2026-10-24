// Checks the chunk graph of web/dist after a build (run by `npm run build`):
//   1. the first screen (index.html and everything it loads statically) holds no chain library;
//   2. pressing "Connect wallet" does not download the API (only the wallet chunk does);
//   3. no cycle between chunks, which could run a module before the helper it calls at load time;
//   4. the first download stays small;
//   5. Argon2 (hash-wasm) is a chunk of its own that only the identity secret loads, with import().
// It reads the built files, so it fails when a change of imports or of vite.config.ts breaks one of them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";
const assets = join(dist, "assets");
const FIRST_SCREEN_BUDGET = 60 * 1024; // bytes of JavaScript, gzipped, before the chain libraries

const chunks = readdirSync(assets).filter((f) => f.endsWith(".js"));
const source = Object.fromEntries(chunks.map((f) => [f, readFileSync(join(assets, f), "utf8")]));
const targets = (code, pattern) => [...code.matchAll(pattern)].map((m) => m[1]).filter((f) => chunks.includes(f));
const staticImports = (f) => targets(source[f], /(?:from|import)\s*["'`]\.\/([^"'`]+\.js)["'`]/g);
const dynamicImports = (f) => targets(source[f], /import\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g);

function closure(starts, next) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    next(f).forEach(visit);
  };
  starts.forEach(visit);
  return seen;
}

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = /<script[^>]*src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
const preloaded = [...html.matchAll(/modulepreload"[^>]*href="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
if (!entry) throw new Error("No entry script in dist/index.html");

const failures = [];
const isChain = (f) => /^polkadot-/.test(f);

const first = closure([entry, ...preloaded], staticImports);
const heavy = [...first].filter(isChain);
if (heavy.length) failures.push(`the first screen loads ${heavy.join(", ")}`);

// chain/wallet.ts is its own chunk (named after the module), reached only by a dynamic import
const walletChunk = chunks.find((f) => /^wallet-/.test(f));
if (!walletChunk) failures.push("no wallet chunk found");
else {
  if (first.has(walletChunk)) failures.push("the first screen loads the wallet chunk");
  if (!chunks.some((f) => dynamicImports(f).includes(walletChunk))) failures.push(`${walletChunk} is never imported dynamically`);
  const walletPath = closure([walletChunk], staticImports);
  if ([...walletPath].some((f) => /^polkadot-api/.test(f))) failures.push(`the wallet chunk loads the API (${[...walletPath].join(", ")})`);
}

// crypto/argon2.ts (hash-wasm) is downloaded the first time a passphrase is used, by nothing else
const argonChunk = chunks.find((f) => /^argon2-/.test(f));
if (!argonChunk) failures.push("no argon2 chunk found");
else {
  const importers = chunks.filter((f) => staticImports(f).includes(argonChunk));
  if (importers.length) failures.push(`${argonChunk} is imported statically by ${importers.join(", ")}`);
  if (first.has(argonChunk)) failures.push("the first screen loads the argon2 chunk");
  if (!chunks.some((f) => dynamicImports(f).includes(argonChunk))) failures.push(`${argonChunk} is never imported dynamically`);
}

const state = new Map();
const cycle = [];
function walk(f, trail) {
  if (state.get(f) === "done") return;
  if (state.get(f) === "open") return void cycle.push([...trail.slice(trail.indexOf(f)), f].join(" -> "));
  state.set(f, "open");
  for (const next of staticImports(f)) walk(next, [...trail, f]);
  state.set(f, "done");
}
chunks.forEach((f) => walk(f, []));
if (cycle.length) failures.push(`static import cycle: ${cycle[0]}`);

const gz = (files) => [...files].reduce((n, f) => n + gzipSync(source[f]).length, 0);
const firstGz = gz(first);
if (firstGz > FIRST_SCREEN_BUDGET) failures.push(`the first screen is ${firstGz} bytes gzipped, over ${FIRST_SCREEN_BUDGET}`);

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const all = chunks.reduce((n, f) => n + statSync(join(assets, f)).size, 0);
console.log(`first screen: ${[...first].join(", ")} (${kb(gzipSync(Buffer.concat([...first].map((f) => Buffer.from(source[f])))).length)} gzipped)`);
console.log(`all JavaScript: ${kb(all)} in ${chunks.length} chunks`);
if (failures.length) {
  console.error(`chunk check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("chunk check ok");
