import type { ApiPromise } from "@polkadot/api";
import { TypeRegistry } from "@polkadot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIdentitee, assertKnownExtensions, DEFAULT_RPC, linkState, rpcEndpoint } from "../src/chain/api.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rpcEndpoint", () => {
  it("is the public node unless the build says otherwise", () => {
    expect(DEFAULT_RPC).toBe("wss://rpc.identit.ee");
    vi.stubEnv("VITE_RPC", "");
    expect(rpcEndpoint()).toBe(DEFAULT_RPC);
    vi.stubEnv("VITE_RPC", "ws://127.0.0.1:9944");
    expect(rpcEndpoint()).toBe("ws://127.0.0.1:9944");
  });
});

describe("the link before any connection", () => {
  it("is disconnected", () => {
    expect(linkState()).toBe("disconnected");
  });
});

/** An API stand-in with the signed extensions of a chain. */
function chainWith(extensions: string[]): ApiPromise {
  const registry = new TypeRegistry();
  registry.setSignedExtensions(extensions);
  return { registry } as unknown as ApiPromise;
}

describe("assertKnownExtensions", () => {
  const known = ["CheckNonce", "CheckMortality", "ChargeTransactionPayment"];

  it("accepts the chain's extensions: AuthorizeCall carries no data and is allowed", () => {
    expect(() => assertKnownExtensions(chainWith([...known, "AuthorizeCall"]))).not.toThrow();
  });

  it("refuses an extension polkadot.js does not know and that is not allowed", () => {
    expect(() => assertKnownExtensions(chainWith([...known, "AuthorizeCall", "MysteryExtension"]))).toThrow(
      /MysteryExtension/,
    );
  });
});

describe("assertIdentitee", () => {
  const node = (specName: string, call: object): ApiPromise =>
    ({ runtimeVersion: { specName: { toString: () => specName } }, call }) as unknown as ApiPromise;

  it("accepts an identitee runtime that serves the API", () => {
    expect(() => assertIdentitee(node("identitee", { identiteeApi: {} }))).not.toThrow();
  });

  it("refuses another chain, and a node without the API", () => {
    expect(() => assertIdentitee(node("polkadot", { identiteeApi: {} }))).toThrow(/not an identitee node/);
    expect(() => assertIdentitee(node("identitee", {}))).toThrow(/runtime API/);
  });
});
