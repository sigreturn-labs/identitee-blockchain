import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// The chain libraries are most of the weight of the app. They get their own chunks, away from the
// pages, so that a change to a page does not make the browser download them again, and so that the
// wallet (util, crypto, extension-dapp) loads without the API (api, rpc, types) behind it:
//   polkadot-core  what the wallet and the address helpers need
//   polkadot-api   the API, the RPC client and the type registry
// Two details keep the chunk graph acyclic (runtime -> core -> api -> pages), which matters because
// a cycle between chunks can run a module before the helper it calls at load time exists:
// the shared address helpers (not short.ts: the header uses that one, and the first screen must
// not need the core) and the browser stubs of Node modules live in the core chunk, and
// groups do not drag in their dependencies (the API's would take util and util-crypto with them).
// @noble/ciphers stays out of the core: only the identity secret uses it, so it goes with the editor
// and the wallet does not carry it.
const API = /[\\/]node_modules[\\/](?:@polkadot[\\/](?:api|api-augment|api-base|api-derive|rpc-augment|rpc-core|rpc-provider|types|types-augment|types-codec|types-create|types-known|types-support)|@substrate[\\/](?:connect|connect-extension-protocol|connect-known-chains|light-client-extension-helpers)|rxjs)[\\/]/;
const CORE = /[\\/]node_modules[\\/](?:@polkadot|@noble[\\/](?!ciphers[\\/])[^\\/]+|@scure|@substrate[\\/]ss58-registry|bn\.js|tslib|eventemitter3)[\\/]|__vite-browser-external|[\\/]src[\\/]chain[\\/]address\.ts/;

export default defineConfig({
  plugins: [preact()],
  build: {
    target: "es2022",
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: "polkadot-api", test: API, priority: 2 },
            { name: "polkadot-core", test: CORE, priority: 1 },
          ],
        },
      },
    },
  },
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/support/no-network.ts"] },
});
