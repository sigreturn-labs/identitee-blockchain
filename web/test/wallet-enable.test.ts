import { beforeEach, describe, expect, it, vi } from "vitest";

// `web3Enable` rejects when the page cannot reach the extensions at all; the wallet must not keep
// that rejection for the rest of the session.
const { web3Enable } = vi.hoisted(() => ({ web3Enable: vi.fn() }));
vi.mock("@polkadot/extension-dapp", () => ({
  web3Enable,
  web3Accounts: vi.fn(async () => [
    { address: "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk", type: "sr25519", meta: { name: "Alice", source: "polkadot-js" } },
  ]),
  web3AccountsSubscribe: vi.fn(async () => () => undefined),
  web3FromSource: vi.fn(),
}));

beforeEach(() => {
  web3Enable.mockReset();
  vi.resetModules();
});

describe("listAccounts after web3Enable failed", () => {
  it("asks the extensions again instead of replaying the failure", async () => {
    web3Enable.mockRejectedValueOnce(new Error("document is not ready")).mockResolvedValue([{ name: "polkadot-js" }]);
    const wallet = await import("../src/chain/wallet.ts");

    expect(await wallet.listAccounts()).toEqual([]);
    expect(wallet.walletState()).toMatchObject({ phase: "error", error: "document is not ready" });

    expect(await wallet.listAccounts()).toHaveLength(1);
    expect(wallet.walletState()).toMatchObject({ phase: "ready", error: undefined });
    expect(web3Enable).toHaveBeenCalledTimes(2);
  });

  it("still asks only once while the answer is good", async () => {
    web3Enable.mockResolvedValue([{ name: "polkadot-js" }]);
    const wallet = await import("../src/chain/wallet.ts");
    await wallet.listAccounts();
    await wallet.listAccounts();
    expect(web3Enable).toHaveBeenCalledTimes(1);
  });
});
