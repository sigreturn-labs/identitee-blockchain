// The wallet: polkadot.js, Talisman and SubWallet extensions through @polkadot/extension-dapp.
//
// One module-level store, so every page sees the same account. Keys never reach this code: the
// extension signs, `signerFor` only hands out its signer. The chosen address is remembered in
// localStorage (an address, nothing secret) and the wallet is only asked again on a later visit
// if one was remembered, so a visitor who never connected never sees a wallet popup.

import { web3Accounts, web3AccountsSubscribe, web3Enable, web3FromSource } from "@polkadot/extension-dapp";
import { useEffect, useState } from "preact/hooks";
import { isAddress, publicKeyOf, sameAccount, SS58_PREFIX, toIdentitee } from "./address.ts";
import { forgetAll } from "../crypto/session.ts";
import { storedMarkers } from "./markers.ts";
import { Refusal } from "./refusal.ts";
import { rememberedRaw, writeRemembered } from "./remembered.ts";
import type { Signing } from "./tx.ts";

/** The name wallets show when the site asks for access. */
export const APP_NAME = "identit.ee";

export interface WalletAccount {
  /** Prefix 2426. */
  address: string;
  name: string | undefined;
  /** The extension it comes from (`talisman`, `polkadot-js`...). */
  source: string;
}

export interface WalletState {
  /** `idle` until the wallet is asked (and again after Disconnect); `no-wallet` when no extension is
   * installed; `refused` when one is installed but did not give this site access. */
  phase: "idle" | "connecting" | "ready" | "no-wallet" | "refused" | "error";
  accounts: WalletAccount[];
  /** The chosen account, prefix 2426. */
  selected: string | null;
  error?: string;
}

let state: WalletState = { phase: "idle", accounts: [], selected: null };
const listeners = new Set<(state: WalletState) => void>();

function update(patch: Partial<WalletState>): void {
  // an identity secret unlocked for one account is not left open for the next one, or after Disconnect
  if ("selected" in patch && patch.selected !== state.selected) forgetAll();
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener(state);
}

/** The state now. It is replaced, never changed, so it can be compared and stored. */
export function walletState(): WalletState {
  return state;
}

/** Call `listener` on each change; returns the function that stops it. */
export function onWalletState(listener: (state: WalletState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The remembered account is a convenience only: localStorage can be missing, full, blocked, or
// hold something that is not an address (another version of the app, a hand edit). Only a valid
// address counts.
function remembered(): string | null {
  const stored = rememberedRaw();
  return stored !== null && isAddress(stored) ? stored : null;
}

const has = (accounts: WalletAccount[], address: string | null): string | null =>
  address === null ? null : (accounts.find((a) => sameAccount(a.address, address))?.address ?? null);

/** Take a new list from the wallet and keep the choice valid: the current one, else the
 * remembered one, else the only account there is. */
function applyAccounts(accounts: WalletAccount[]): void {
  const selected =
    has(accounts, state.selected) ?? has(accounts, remembered()) ?? (accounts.length === 1 ? accounts[0]!.address : null);
  if (selected !== null && selected !== remembered()) writeRemembered(selected);
  update({ phase: "ready", accounts, selected, error: undefined });
}

let enabling: Promise<unknown[]> | null = null;
let watching = false;
let listing: Promise<WalletAccount[]> | null = null;

async function enable(): Promise<unknown[]> {
  const asked = (enabling ??= web3Enable(APP_NAME));
  try {
    const extensions = await asked;
    // An extension installed since the last try must be found by the next one.
    if (extensions.length === 0 && enabling === asked) enabling = null;
    return extensions;
  } catch (e) {
    // a failure must not be replayed for the rest of the session
    if (enabling === asked) enabling = null;
    throw e;
  }
}

function installedExtensions(): number {
  const injected = (globalThis as { injectedWeb3?: Record<string, unknown> }).injectedWeb3;
  return injected ? Object.keys(injected).length : 0;
}

async function readAccounts(): Promise<WalletAccount[]> {
  const found = await web3Accounts({ ss58Format: SS58_PREFIX });
  return found
    // Ethereum accounts have 20-byte addresses: not accounts of this chain.
    .filter((account) => account.type !== "ethereum")
    .map((account) => ({ address: toIdentitee(account.address), name: account.meta.name, source: account.meta.source }));
}

const sameList = (a: WalletAccount[], b: WalletAccount[]): boolean =>
  a.length === b.length && a.every((x, i) => x.address === b[i]!.address && x.name === b[i]!.name && x.source === b[i]!.source);

/** Follow the wallet: an account added or removed there shows up here. Extensions answer a new
 * subscription with the list we have just read, which changes nothing. */
async function watch(): Promise<void> {
  if (watching) return;
  watching = true;
  const refresh = (list: WalletAccount[]): void => {
    // after Disconnect the site shows no account until the person connects again
    if (state.phase === "ready" && !sameList(list, state.accounts)) applyAccounts(list);
  };
  try {
    await web3AccountsSubscribe(() => void readAccounts().then(refresh, () => undefined), { ss58Format: SS58_PREFIX });
  } catch {
    watching = false;
  }
}

/**
 * Ask the wallet for access and list its accounts (every extension together). Opens the
 * extension's own authorisation prompt the first time. Resolves with `[]` when there is no
 * wallet or it refused; the reason is in `walletState()`.
 */
export function listAccounts(): Promise<WalletAccount[]> {
  listing ??= (async () => {
    update({ phase: "connecting", error: undefined });
    try {
      if ((await enable()).length === 0) {
        // extensions announce themselves in window.injectedWeb3 before they are asked: one that is
        // there and gave nothing refused the site, it is not missing
        update({ phase: installedExtensions() > 0 ? "refused" : "no-wallet", accounts: [], selected: null });
        return [];
      }
      applyAccounts(await readAccounts());
      await watch();
      return state.accounts;
    } catch (e) {
      update({ phase: "error", accounts: [], selected: null, error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  })().finally(() => {
    listing = null;
  });
  return listing;
}

/** On a later visit, take the remembered account back. Does nothing, and asks nothing of the
 * wallet, if the visitor never chose one. */
export async function restoreWallet(): Promise<void> {
  if (state.phase === "idle" && remembered() !== null) await listAccounts();
}

/** Choose the account to act as (prefix of the address does not matter). */
export function selectAccount(address: string): void {
  const chosen = has(state.accounts, address);
  if (chosen === null) throw new Refusal("That account is not in the wallet.");
  writeRemembered(chosen);
  update({ selected: chosen });
}

/** Forget the chosen account and the accounts listed: the site is back to "Connect wallet". The
 * wallet keeps its authorisation for the site, so connecting again asks nothing more. */
export function disconnectWallet(): void {
  // what this browser remembers of this account's migration goes with the connection
  if (state.selected !== null) storedMarkers.clear(state.selected);
  forgetAll();
  writeRemembered(null);
  update({ phase: "idle", accounts: [], selected: null });
}

/** What `send` needs to sign as `address` (default: the chosen account). */
export async function signerFor(address?: string): Promise<Signing> {
  const target = address ?? state.selected;
  if (target === null) throw new Refusal("Choose an account first.");
  publicKeyOf(target);
  const account = state.accounts.find((a) => sameAccount(a.address, target));
  if (!account) throw new Refusal("That account is not in the wallet.");
  const extension = await web3FromSource(account.source);
  return { address: account.address, signer: extension.signer };
}

export interface UseAccount extends WalletState {
  /** The chosen account, with its name and extension. */
  account: WalletAccount | null;
  /** Its address (prefix 2426). */
  address: string | null;
  connect: typeof listAccounts;
  select: typeof selectAccount;
  disconnect: typeof disconnectWallet;
  signer: typeof signerFor;
}

/** The wallet state for a component; re-renders on each change. */
export function useAccount(): UseAccount {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    const stop = onWalletState(setSnapshot);
    setSnapshot(state);
    void restoreWallet();
    return stop;
  }, []);
  const account = snapshot.accounts.find((a) => a.address === snapshot.selected) ?? null;
  return {
    ...snapshot,
    account,
    address: snapshot.selected,
    connect: listAccounts,
    select: selectAccount,
    disconnect: disconnectWallet,
    signer: signerFor,
  };
}
