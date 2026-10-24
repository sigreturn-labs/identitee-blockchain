// The wallet as the first screen sees it. chain/wallet.ts pulls in the wallet libraries, which are
// most of the weight of the app, so the entry code never imports it: it is loaded with `import()`
// when the visitor presses "Connect wallet", or at start-up if an account was remembered (to take
// it back). A visitor who only reads a profile never downloads them for the wallet.

import { useEffect, useState } from "preact/hooks";
import { rememberedRaw } from "../chain/remembered.ts";
import type { WalletState } from "../chain/wallet.ts";

export type WalletModule = typeof import("../chain/wallet.ts");

let loaded: WalletModule | null = null;
let loading: Promise<WalletModule> | null = null;
/** Every component using the wallet hears of the module the moment it is there, whoever asked for it. */
const onLoaded = new Set<(module: WalletModule) => void>();

/** Load the wallet module, once. A failed load (the network) is forgotten, so the next call retries. */
export function loadWallet(): Promise<WalletModule> {
  loading ??= import("../chain/wallet.ts").then(
    (module) => {
      loaded = module;
      for (const listener of [...onLoaded]) listener(module);
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Whether the visitor chose an account on an earlier visit (the wallet is then asked on load). */
export function hasRememberedAccount(): boolean {
  const stored = rememberedRaw();
  return stored !== null && stored !== "";
}

export interface LazyWallet {
  /** `null` while the wallet module is not loaded: nobody asked for it, or it is on its way. */
  state: WalletState | null;
  /** The wallet module once loaded: `selectAccount`, `disconnectWallet`... */
  wallet: WalletModule | null;
  /** A connection is under way: the module is loading or the wallet is being asked. */
  busy: boolean;
  /** The wallet module could not be loaded (the network). */
  loadFailed: boolean;
  /** Load the wallet module now (the person pressed "Connect wallet"), then ask the wallet for its
   * accounts. Resolves with the state afterwards, or `null` if the module could not be loaded. */
  connect(): Promise<WalletState | null>;
}

/** The wallet state for a component, loading the wallet module only when it is needed. */
export function useLazyWallet(): LazyWallet {
  const [wallet, setWallet] = useState<WalletModule | null>(loaded);
  const [state, setState] = useState<WalletState | null>(loaded?.walletState() ?? null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    onLoaded.add(setWallet);
    if (loaded) setWallet(loaded);
    else if (hasRememberedAccount()) loadWallet().then(undefined, () => setLoadFailed(true));
    return () => void onLoaded.delete(setWallet);
  }, []);

  useEffect(() => {
    if (wallet === null) return;
    const stop = wallet.onWalletState(setState);
    setState(wallet.walletState());
    void wallet.restoreWallet();
    return stop;
  }, [wallet]);

  const connect = async (): Promise<WalletState | null> => {
    setBusy(true);
    setLoadFailed(false);
    try {
      const module = await loadWallet();
      await module.listAccounts();
      return module.walletState();
    } catch {
      setLoadFailed(true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { state, wallet, busy, loadFailed, connect };
}
