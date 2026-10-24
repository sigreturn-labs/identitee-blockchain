import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ProfileSkeleton } from "./card.tsx";
import { ConnectCard } from "./connect-card.tsx";
import { hasRememberedAccount, useLazyWallet, type WalletModule } from "./lazy-wallet.ts";
import { LoadFailed } from "./lazy-page.tsx";

export interface GateProps {
  /** The chosen account, prefix 2426. */
  address: string;
  wallet: WalletModule;
}

/**
 * A page that needs an account (the home page, `/me`): the connect card until one is chosen, then
 * the page. Its code, and the chain libraries behind it, are only downloaded once there is an
 * account to show it for, so a visitor who only came to connect downloads none of it.
 */
export function AccountGate({ load, lookup = false, purpose }: { load: () => Promise<ComponentType<GateProps>>; lookup?: boolean; purpose?: string }) {
  const lazyWallet = useLazyWallet();
  const { state, wallet, busy, loadFailed } = lazyWallet;
  const selected = state?.selected ?? null;
  const [Page, setPage] = useState<ComponentType<GateProps> | null>(null);
  const [pageFailed, setPageFailed] = useState(false);

  useEffect(() => {
    if (selected !== null) load().then((page) => setPage(() => page), () => setPageFailed(true));
  }, [selected !== null]);

  if (pageFailed) return <LoadFailed />;
  if (selected !== null) return Page && wallet ? <Page address={selected} wallet={wallet} /> : <ProfileSkeleton />;
  // A remembered account is being taken back from the wallet: no flash of the connect card.
  // (A remembered value that is not an address leaves the wallet `idle`: nothing to take back.)
  const restoring = state === null ? hasRememberedAccount() && !loadFailed : state.phase === "connecting";
  if (restoring && !busy) return <ProfileSkeleton />;
  return <ConnectCard wallet={lazyWallet} lookup={lookup} purpose={purpose} />;
}
