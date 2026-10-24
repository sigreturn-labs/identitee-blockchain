import { useLocation } from "preact-iso";
import { useEffect, useRef, useState } from "preact/hooks";
import { shorten } from "../chain/short.ts";
import { CONNECT_CARD_PATHS } from "../routes.ts";
import { useIsAgent } from "./agent-check.ts";
import { useLazyWallet } from "./lazy-wallet.ts";
import { mayLeave } from "./unsaved.ts";
import { AccountList, LOAD_FAILED, walletNotice } from "./wallet-panel.tsx";

/** Top bar: the mark on the left, the wallet button on the right. Once an account is chosen the
 * button shows its address and opens a small menu (Authority only for an authority agent). Nothing
 * here imports the wallet or chain libraries. */
export function Header() {
  const { state, wallet, busy, loadFailed, connect } = useLazyWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { path } = useLocation();

  const selected = state?.selected ?? null;
  const account = state?.accounts.find((a) => a.address === selected) ?? null;
  // the Authority link is for an active agent only; the chain is asked again when the menu opens
  const agent = useIsAgent(selected, open);
  const connecting = busy || state?.phase === "connecting";
  const notice = loadFailed ? LOAD_FAILED : walletNotice(state);
  // These pages say "Connect wallet" in their own card until an account is chosen: one button, not two.
  const hasOwnCard = selected === null && CONNECT_CARD_PATHS.includes(path);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    addEventListener("pointerdown", outside);
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("pointerdown", outside);
      removeEventListener("keydown", escape);
    };
  }, [open]);

  async function press() {
    if (state?.phase === "ready") return setOpen(!open);
    const after = await connect();
    setOpen(after === null || after.selected === null);
  }

  return (
    <header class="top">
      <a class="mark" href="/">
        identit<span>.ee</span>
      </a>
      {!hasOwnCard && (
        <div
          class="account-box"
          ref={box}
          // the menu closes when the keyboard leaves it, as it does on a click outside
          onFocusOut={(e) => {
            if (open && !box.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
        >
          <button
            ref={button}
            class="connect"
            type="button"
            disabled={connecting}
            title={selected ?? undefined}
            aria-expanded={open}
            aria-controls="account-menu"
            onClick={() => void press()}
          >
            {connecting ? "Connecting" : selected ? account?.name?.trim() || shorten(selected) : "Connect wallet"}
          </button>
          {open && (
            <div class="menu" id="account-menu" role="group" aria-label="Wallet">
              {notice && <p class="note">{notice}</p>}
              {state?.phase === "ready" && wallet && state.accounts.length > (selected ? 1 : 0) && (
                <AccountList state={state} wallet={wallet} onChosen={() => setOpen(false)} />
              )}
              {selected && state && wallet && (
                <nav class={state.accounts.length > 1 ? "menu-links ruled" : "menu-links"} onClick={() => setOpen(false)}>
                  <a href="/me">My identity</a>
                  <a href="/requests">Requests</a>
                  {agent && <a href="/authority">Authority</a>}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (mayLeave()) wallet.disconnectWallet();
                    }}
                  >
                    Disconnect
                  </button>
                </nav>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
