import type { LazyWallet } from "./lazy-wallet.ts";
import { Card } from "./card.tsx";
import { Lookup } from "./lookup.tsx";
import { AccountList, LOAD_FAILED, walletNotice } from "./wallet-panel.tsx";

/** The way in for a visitor with no account chosen yet: one Connect wallet button, or the accounts
 * of the wallet to choose from, or the reason there is none. With `lookup` (the home page), a
 * search for a profile comes first, for a visitor who came to look someone up. */
export function ConnectCard({ wallet: { state, wallet, busy, loadFailed, connect }, lookup = false, purpose }: { wallet: LazyWallet; lookup?: boolean; purpose?: string }) {
  const notice = loadFailed ? LOAD_FAILED : walletNotice(state);
  const choosing = state?.phase === "ready" && wallet !== null && state.accounts.length > 0;
  return (
    <Card label="Connect">
      {lookup && <Lookup />}
      {purpose && !choosing && <p class="note">{purpose}</p>}
      {!choosing && (
        <button class="button primary wide" type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? "Connecting" : "Connect wallet"}
        </button>
      )}
      {notice && <p class="note">{notice}</p>}
      {choosing && <AccountList state={state} wallet={wallet} />}
    </Card>
  );
}
