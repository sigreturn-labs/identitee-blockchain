// Headless screenshot of a built route, rendered on the GPU when one is available (WebGL through EGL).
//   npm run build && npm run screenshot -- --route /me --width 390 --height 844 --scale 2 --out screenshots/me-mobile.png
// Serves web/dist with vite preview, opens it in the Chrome that puppeteer downloaded and prints the
// WebGL renderer, so a silent fall back to software rendering does not go unnoticed.
//
// A page that reads the chain: build against a local dev node into another folder, seed it
// (scripts/seed-profiles.mjs), and wait for the content:
//   VITE_RPC=ws://127.0.0.1:9944 npx vite build --outDir .shot-dist
//   npm run screenshot -- --dist .shot-dist --route /dave --wait ".card .level" --out screenshots/dave-desktop.png
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { preview } from "vite";

const NVIDIA_EGL = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";

const { values } = parseArgs({
  options: {
    route: { type: "string", default: "/" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    scale: { type: "string", default: "1" },
    out: { type: "string", default: "screenshots/home.png" },
    full: { type: "boolean", default: false },
    dist: { type: "string", default: "dist" },
    wait: { type: "string" },
  },
});

function findChrome() {
  const root = join(homedir(), ".cache/puppeteer/chrome");
  const versions = readdirSync(root).sort();
  if (!versions.length) throw new Error(`No Chrome in ${root}`);
  return join(root, versions.at(-1), "chrome-linux64/chrome");
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
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: +values.width, height: +values.height, deviceScaleFactor: +values.scale });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log(`console ${m.type()}: ${m.text()}`);
      failed ||= m.type() === "error";
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on("pageerror", (e) => {
    console.log(`page error: ${e.message}`);
    failed = true;
  });
  await page.goto(new URL(values.route, base).href, { waitUntil: "networkidle0" });
  if (values.wait) await page.waitForSelector(values.wait, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "no WebGL";
  });
  console.log(`WebGL renderer: ${gpu}`);
  // A page wider than the window (a long unbreakable text stretching a grid) is a bug, not a look.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) {
    console.log(`horizontal overflow: the page is ${overflow}px wider than the window`);
    failed = true;
  }
  const faces = await page.evaluate(() => [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`));
  console.log(`font faces: ${faces.join(", ") || "none"}`);
  // The first capture of a WebGL page comes out black: take a throwaway one first.
  await page.screenshot({ type: "png" });
  await new Promise((r) => setTimeout(r, 400));
  mkdirSync(dirname(values.out), { recursive: true });
  await page.screenshot({ path: values.out, type: "png", fullPage: values.full });
  console.log(`saved ${values.out}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
