import type { ComponentChildren } from "preact";
import { shorten } from "../chain/short.ts";
import type { WalletState } from "../chain/wallet.ts";
import type { WalletModule } from "./lazy-wallet.ts";
import { mayLeave } from "./unsaved.ts";

/** The wallet module itself could not be downloaded. */
export const LOAD_FAILED = "The wallet could not be loaded. Check your connection and try again.";

const out = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {text}
  </a>
);

/** A phone or a tablet: wallet extensions do not exist there, wallet apps with a browser do. */
const onTouchDevice = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** What to tell the person about a wallet that did not give an account (yet), or `null`. */
export function walletNotice(state: WalletState | null): ComponentChildren | null {
  switch (state?.phase) {
    case "connecting":
      return "Approve the request in your wallet.";
    case "no-wallet":
      return onTouchDevice() ? (
        <>
          No wallet found. On a phone, open identit.ee in the browser of a wallet app such as {out("https://novawallet.io", "Nova Wallet")} or{" "}
          {out("https://www.subwallet.app", "SubWallet")}.
        </>
      ) : (
        <>
          No wallet found. Install {out("https://talisman.xyz", "Talisman")}, {out("https://www.subwallet.app", "SubWallet")} or{" "}
          {out("https://polkadot.js.org/extension/", "polkadot.js")}, then try again.
        </>
      );
    case "refused":
      return "Your wallet did not give identit.ee access. Allow it in the wallet, then try again.";
    case "error":
      return "The wallet could not be reached. Try again.";
    case "ready":
      if (state.accounts.length === 0) return "No account found in your wallet.";
      return state.selected === null ? "Choose an account." : null;
    default:
      return null;
  }
}

/** The accounts of the wallet, to choose from; the chosen one carries a dot. */
export function AccountList({ state, wallet, onChosen }: { state: WalletState; wallet: WalletModule; onChosen?: () => void }) {
  return (
    <ul class="accounts">
      {state.accounts.map((account) => (
        <li key={account.address}>
          <button
            type="button"
            class={account.address === state.selected ? "account chosen" : "account"}
            title={account.address}
            aria-pressed={account.address === state.selected}
            onClick={() => {
              // another account drops what this one has not saved
              if (account.address !== state.selected && !mayLeave()) return;
              wallet.selectAccount(account.address);
              onChosen?.();
            }}
          >
            <span class="account-name">{account.name?.trim() || "Account"}</span>
            <span class="addr">{shorten(account.address)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
