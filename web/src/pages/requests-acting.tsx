// What the requests page does with a button: sign one call with the wallet, send it, read the page's
// data again, and say in one line what happened. One action at a time, so a second click cannot
// race the first. A refusal says why in a sentence (the chain's error, translated by `send`, or the
// daily limit). Nothing here asks for a fee: identity calls are free, whatever the balance.

import { useRef, useState } from "preact/hooks";
import type { Call } from "../chain/calls.ts";
import { NOT_PREPARED, sentenceOf } from "../chain/refusal.ts";
import { send } from "../chain/tx.ts";
import type { WalletModule } from "../ui/lazy-wallet.ts";

/** While something waits for someone else (a request, a proposal, a migration, a request to an
 * authority) a page reads the chain again this often. */
export const POLL_MS = 20_000;

/** The sections of the requests page, and of the authority page, which works the same way. */
export type Section = "verify" | "name" | "subs" | "migration" | "inbox" | "account" | "reserved";

export interface Status {
  section: Section;
  state: "doing" | "done" | "error";
  message?: string;
  /** The row the action was for, if any: its result shows there, next to the button pressed. */
  row?: string;
}

export interface Acting {
  status: Status | null;
  /** An action is in flight: nothing else can be sent. */
  pending: boolean;
  /** Actions finished so far, whatever the outcome: what a live check watches to read again. */
  epoch: number;
  /**
   * Sign and send the call `build` makes, then read the page again. `done` is what to say once the
   * call is in a block; `after` runs at that moment (to remember what the chain cannot be asked).
   * Resolves `true` when the call went through.
   */
  run(section: Section, build: () => Promise<Call>, done: string, after?: () => void, row?: string): Promise<boolean>;
  /** The person typed in a section: its last result is no longer news. */
  touch(section: Section): void;
  /** Time has passed and the page read the chain again: no result is news any more. */
  clear(): void;
}


/** `messages`: sentences that replace `send`'s for some errors (by name), for a page where the
 * person is not the one the error is about (an agent acting on someone else's identity). */
export function useActing(address: string, wallet: WalletModule, reload: () => Promise<boolean>, messages: Record<string, string> = {}): Acting {
  const [status, setStatus] = useState<Status | null>(null);
  const [epoch, setEpoch] = useState(0);
  const busy = useRef(false);
  const pending = status?.state === "doing";

  async function run(section: Section, build: () => Promise<Call>, done: string, after?: () => void, row?: string): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    const end = (next: Status): boolean => {
      busy.current = false;
      setStatus({ ...next, row });
      setEpoch((n) => n + 1);
      return next.state === "done";
    };
    const fail = (message: string): boolean => end({ section, state: "error", message });
    setStatus({ section, state: "doing", row });
    let signer;
    try {
      signer = await wallet.signerFor(address);
    } catch {
      return fail("The wallet could not be reached. Try again.");
    }
    let call: Call;
    try {
      call = await build();
    } catch (error) {
      // a sentence of the app (a name that cannot exist) is shown as is; anything else is not for the person
      return fail(sentenceOf(error, NOT_PREPARED));
    }
    // "Sent" is all `send` can say: what the chain now holds comes from reading it again
    const result = await send(call, signer);
    if (!result.ok) return fail((result.errorName && messages[result.errorName]) || result.error || "The transaction could not be sent.");
    after?.();
    const read = await reload();
    return end({ section, state: "done", message: read ? done : `${done} The page could not be refreshed.` });
  }

  return {
    status,
    pending,
    epoch,
    run,
    touch: (section) => setStatus((now) => (now && now.section === section && now.state !== "doing" ? null : now)),
    clear: () => setStatus((now) => (now && now.state !== "doing" ? null : now)),
  };
}

/** What happened to the last action of a section, as one quiet line. With `row`, only for an action
 * on that row; with `rows` (the rows on show), only for an action on none of them (the section's
 * own, or a row that is gone since, such as a request just answered). */
export function StatusLine({ acting, section, row, rows }: { acting: Acting; section: Section; row?: string; rows?: readonly string[] }) {
  const { status } = acting;
  if (!status || status.section !== section) return null;
  if (row !== undefined && status.row !== row) return null;
  if (row === undefined && rows !== undefined && status.row !== undefined && rows.includes(status.row)) return null;
  if (status.state === "error") {
    return (
      <p class="problem" role="alert">
        {status.message}
      </p>
    );
  }
  return (
    <p class="status" role="status">
      {status.state === "doing" ? "Working. Confirm in your wallet if it asks." : status.message}
    </p>
  );
}
