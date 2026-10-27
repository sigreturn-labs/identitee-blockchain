// Who stands behind an address: the display name, the username and the trust level, as a link to an
// account shows them. The links of a page ask together: their addresses are gathered for one tick,
// then read in one `/api/identities` call per 50. Answers are kept a minute; a failed read is kept
// as nothing, so the link just shows the address.
import { useEffect, useState } from "preact/hooks";
import { get } from "./api.ts";

export type Identity = { display: string | null; username: string | null; trust: string | null };

const BATCH = 50;
const KEEP_MS = 60_000;

const known = new Map<string, { at: number; value: Identity | null }>();
const waiting = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function settle(address: string, value: Identity | null) {
  known.set(address, { at: Date.now(), value });
  for (const listener of listeners.get(address) ?? []) listener();
}

async function flush() {
  timer = null;
  const all = [...waiting];
  waiting.clear();
  for (let i = 0; i < all.length; i += BATCH) {
    const part = all.slice(i, i + BATCH);
    get<{ items: Record<string, Identity | null> }>(`/api/identities?a=${part.map(encodeURIComponent).join(",")}`).then(
      ({ items }) => part.forEach((a) => settle(a, items[a] ?? null)),
      () => part.forEach((a) => settle(a, null)),
    );
  }
}

function ask(address: string) {
  const hit = known.get(address);
  if ((hit !== undefined && Date.now() - hit.at < KEEP_MS) || waiting.has(address)) return;
  waiting.add(address);
  timer ??= setTimeout(flush, 0);
}

/** The identity behind `address`: undefined until read, null when there is none to show. */
export function useIdentity(address: string): Identity | null | undefined {
  const [, redraw] = useState(0);
  useEffect(() => {
    const set = listeners.get(address) ?? new Set();
    listeners.set(address, set);
    const listener = () => redraw((n) => n + 1);
    set.add(listener);
    ask(address);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(address);
    };
  }, [address]);
  return known.get(address)?.value;
}

/** For tests: forget every answer. */
export function forgetIdentities() {
  known.clear();
  waiting.clear();
}
