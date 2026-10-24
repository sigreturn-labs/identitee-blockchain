// No test reaches the network: `fetch` refuses unless a test replaces it. The verification service
// is then unreachable, so a page that asks it for its channels offers none.
import { beforeEach } from "vitest";
import { forgetChannels } from "../../src/chain/verify.ts";

const refuse = () => Promise.reject(new TypeError("no network in tests"));
globalThis.fetch = refuse as typeof fetch;
beforeEach(() => {
  globalThis.fetch = refuse as typeof fetch;
  forgetChannels();
});
