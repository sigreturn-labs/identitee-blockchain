// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE_KEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const BOB_GENERIC = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const BOB = "idq6mNVZUu81C8CHeHPoHeScVrnwwiVw61SMCYkfeoAdHGiUc";
const ETHEREUM = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

interface Fake {
  name: string;
  accounts: { address: string; name?: string; type?: string }[];
  signer: object;
}

/** Install fake wallet extensions the way real ones announce themselves. */
function inject(...fakes: Fake[]): void {
  (window as unknown as { injectedWeb3: object }).injectedWeb3 = Object.fromEntries(
    fakes.map((f) => [
      f.name,
      {
        version: "1.0.0",
        enable: async () => ({
          accounts: {
            get: async () => f.accounts,
            subscribe: (cb: (list: Fake["accounts"]) => void) => {
              cb(f.accounts);
              return () => undefined;
            },
          },
          signer: f.signer,
        }),
      },
    ]),
  );
}

const talisman: Fake = {
  name: "talisman",
  signer: { id: "talisman-signer" },
  accounts: [
    { address: BOB_GENERIC, name: "Bob", type: "sr25519" },
    { address: ETHEREUM, name: "Eth", type: "ethereum" },
  ],
};
const polkadotJs: Fake = {
  name: "polkadot-js",
  signer: { id: "pjs-signer" },
  accounts: [{ address: ALICE_KEY, name: "Alice", type: "sr25519" }],
};

async function freshWallet() {
  vi.resetModules();
  return import("../src/chain/wallet.ts");
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { injectedWeb3?: object }).injectedWeb3;
});

describe("listAccounts", () => {
  it("lists the accounts of every extension, in prefix 2426, without Ethereum ones", async () => {
    inject(talisman, polkadotJs);
    const wallet = await freshWallet();
    const accounts = await wallet.listAccounts();
    expect(accounts).toEqual([
      { address: BOB, name: "Bob", source: "talisman" },
      { address: ALICE, name: "Alice", source: "polkadot-js" },
    ]);
    expect(wallet.walletState().phase).toBe("ready");
  });

  it("says there is no wallet when nothing is installed", async () => {
    inject();
    const wallet = await freshWallet();
    expect(await wallet.listAccounts()).toEqual([]);
    expect(wallet.walletState().phase).toBe("no-wallet");
  });

  it("says the wallet refused, not that there is none, when an installed extension gives nothing", async () => {
    // an extension announces itself in injectedWeb3; one that refuses the site rejects enable()
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = {
      talisman: { version: "1.0.0", enable: async () => Promise.reject(new Error("Rejected")) },
    };
    const wallet = await freshWallet();
    expect(await wallet.listAccounts()).toEqual([]);
    expect(wallet.walletState()).toMatchObject({ phase: "refused", accounts: [], selected: null });
  });

  it("selects the only account by itself, and none of several", async () => {
    inject(polkadotJs);
    let wallet = await freshWallet();
    await wallet.listAccounts();
    expect(wallet.walletState().selected).toBe(ALICE);

    localStorage.clear();
    inject(talisman, polkadotJs);
    wallet = await freshWallet();
    await wallet.listAccounts();
    expect(wallet.walletState().selected).toBeNull();
  });
});

describe("the remembered account", () => {
  it("is kept in localStorage and chosen again on the next visit", async () => {
    inject(talisman, polkadotJs);
    let wallet = await freshWallet();
    await wallet.listAccounts();
    wallet.selectAccount(ALICE_KEY);
    expect(wallet.walletState().selected).toBe(ALICE);
    expect(localStorage.getItem("identitee.account")).toBe(ALICE);

    wallet = await freshWallet();
    await wallet.restoreWallet();
    expect(wallet.walletState().selected).toBe(ALICE);
  });

  it("is not restored when the wallet no longer has it", async () => {
    localStorage.setItem("identitee.account", ALICE);
    const carol = { address: "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y", name: "Carol", type: "sr25519" };
    inject(talisman, { name: "other", signer: {}, accounts: [carol] });
    const wallet = await freshWallet();
    await wallet.restoreWallet();
    expect(wallet.walletState().selected).toBeNull();
  });

  it("is not looked for at all when nothing was remembered", async () => {
    const enable = vi.fn();
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = { spy: { version: "1", enable } };
    const wallet = await freshWallet();
    await wallet.restoreWallet();
    expect(enable).not.toHaveBeenCalled();
    expect(wallet.walletState().phase).toBe("idle");
  });

  it("ignores a remembered value that is not an address", async () => {
    localStorage.setItem("identitee.account", "not-an-address");
    const enable = vi.fn();
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = { spy: { version: "1", enable } };
    let wallet = await freshWallet();
    await wallet.restoreWallet();
    expect(enable).not.toHaveBeenCalled();
    expect(wallet.walletState().phase).toBe("idle");

    // and it does not break a connection that asks the wallet
    inject(talisman, polkadotJs);
    wallet = await freshWallet();
    await wallet.listAccounts();
    expect(wallet.walletState()).toMatchObject({ phase: "ready", selected: null });
  });

  it("is forgotten on disconnect", async () => {
    inject(polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    wallet.disconnectWallet();
    expect(wallet.walletState().selected).toBeNull();
    expect(localStorage.getItem("identitee.account")).toBeNull();
  });

  it("goes back to idle on disconnect, with no account listed, until the person connects again", async () => {
    inject(talisman, polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    wallet.selectAccount(ALICE_KEY);
    wallet.disconnectWallet();
    expect(wallet.walletState()).toMatchObject({ phase: "idle", accounts: [], selected: null });
    await wallet.listAccounts();
    expect(wallet.walletState().phase).toBe("ready");
    expect(wallet.walletState().accounts).toHaveLength(2);
  });

  it("forgets what it saw of the migration of the account, and only of that account", async () => {
    inject(polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    expect(wallet.walletState().selected).toBe(ALICE);
    localStorage.setItem("identitee.migration", JSON.stringify({ [ALICE]: "Polkadot", [BOB]: "Kusama" }));
    wallet.disconnectWallet();
    expect(JSON.parse(localStorage.getItem("identitee.migration")!)).toEqual({ [BOB]: "Kusama" });
    // with no account chosen there is nothing of its to forget
    wallet.disconnectWallet();
    expect(JSON.parse(localStorage.getItem("identitee.migration")!)).toEqual({ [BOB]: "Kusama" });
  });

  it("refuses to select an account the wallet does not have", async () => {
    inject(polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    expect(() => wallet.selectAccount(BOB_GENERIC)).toThrow(/not in the wallet/i);
    // a sentence of the app (a `Refusal`, a class of the module copy the test loaded): shown as it is
    expect(() => wallet.selectAccount(BOB_GENERIC)).toThrow(expect.objectContaining({ name: "Refusal" }));
  });

  it("works when localStorage is unavailable", async () => {
    inject(polkadotJs);
    const wallet = await freshWallet();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await wallet.listAccounts();
    wallet.selectAccount(ALICE);
    expect(wallet.walletState().selected).toBe(ALICE);
  });
});

describe("signerFor", () => {
  it("gives the signer of the extension the account comes from", async () => {
    inject(talisman, polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    expect(await wallet.signerFor(ALICE)).toEqual({ address: ALICE, signer: polkadotJs.signer });
    expect(await wallet.signerFor(BOB_GENERIC)).toEqual({ address: BOB, signer: talisman.signer });
  });

  it("uses the selected account by default and refuses without one", async () => {
    inject(talisman, polkadotJs);
    const wallet = await freshWallet();
    await wallet.listAccounts();
    await expect(wallet.signerFor()).rejects.toThrow(/choose an account/i);
    await expect(wallet.signerFor()).rejects.toMatchObject({ name: "Refusal" });
    wallet.selectAccount(ALICE);
    expect((await wallet.signerFor()).signer).toBe(polkadotJs.signer);
  });
});

describe("useAccount", () => {
  it("follows the wallet: connect, then choose", async () => {
    inject(talisman, polkadotJs);
    const wallet = await freshWallet();
    function Probe() {
      const { phase, accounts, address } = wallet.useAccount();
      return <p>{`${phase}|${accounts.length}|${address ?? "none"}`}</p>;
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(<Probe />, root));
    expect(root.textContent).toBe("idle|0|none");

    await act(async () => {
      await wallet.listAccounts();
    });
    expect(root.textContent).toBe("ready|2|none");

    await act(() => wallet.selectAccount(BOB_GENERIC));
    expect(root.textContent).toBe(`ready|2|${BOB}`);
  });
});
