import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// The design (tokens, styles, pure helpers) is imported from the identit.ee front under `@web`,
// never copied. The API and the profile site are build settings with production defaults.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [preact()],
    // one Preact for both trees: the components imported from web/ would otherwise bring their own
    resolve: { alias: { "@web": fileURLToPath(new URL("../web/src", import.meta.url)) }, dedupe: ["preact"] },
    server: { fs: { allow: [".."] } },
    // the same icon, and the same single-page fallback (_redirects) on Cloudflare Pages
    publicDir: "../web/public",
    define: {
      "import.meta.env.VITE_API": JSON.stringify(env.VITE_API || "https://explorer-api.identit.ee"),
      "import.meta.env.VITE_PROFILE_BASE": JSON.stringify(env.VITE_PROFILE_BASE || "https://identit.ee"),
    },
    build: { target: "es2022" },
    test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/support/no-network.ts"] },
  };
});
