// Data hooks of the pages: one read, a paged list, the live head and the validator labels.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, get, live, type Head, type Network, type Page, type Status } from "./api.ts";

const asError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "network"));

export type Read<T> = { data: T | null; error: ApiError | null; reload(): void };

/** GET `path` (null: nothing to read yet). `version` reads it again, keeping the previous answer on
 * screen meanwhile; a new `path` starts over. */
export function useApi<T>(path: string | null, version: unknown = 0): Read<T> {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | null }>({ path, data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let gone = false;
    get<T>(path).then(
      (data) => !gone && setState({ path, data, error: null }),
      (e: unknown) => !gone && setState((s) => ({ path, data: s.path === path ? s.data : null, error: asError(e) })),
    );
    return () => {
      gone = true;
    };
  }, [path, version, attempt]);
  const reload = useCallback(() => {
    setState({ path, data: null, error: null });
    setAttempt((a) => a + 1);
  }, [path]);
  // an answer to an older path is not shown under a new one
  if (state.path !== path) return { data: null, error: null, reload };
  return { data: state.data, error: state.error, reload };
}

export type Paged<T> = {
  items: T[] | null;
  /** The first page failed: the list has nothing to show. */
  error: ApiError | null;
  /** A later page failed: the items stay. */
  moreError: ApiError | null;
  loadingMore: boolean;
  hasMore: boolean;
  more(): void;
  reload(): void;
};

/** A list read page by page: `base` (which may carry its own query) with `limit`, then the cursor
 * of the previous page. */
export function usePaged<T>(base: string, limit = 25): Paged<T> {
  const join = base.includes("?") ? "&" : "?";
  const first = `${base}${join}limit=${limit}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ items: T[] | null; next: string | null; error: ApiError | null; moreError: ApiError | null; loadingMore: boolean }>({
    items: null,
    next: null,
    error: null,
    moreError: null,
    loadingMore: false,
  });
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    setState({ items: null, next: null, error: null, moreError: null, loadingMore: false });
    get<Page<T, string | number>>(first).then(
      (p) => mine === ticket.current && setState({ items: p.items, next: p.next === null ? null : String(p.next), error: null, moreError: null, loadingMore: false }),
      (e: unknown) => mine === ticket.current && setState((s) => ({ ...s, error: asError(e) })),
    );
    return () => {
      ticket.current++;
    };
  }, [first, attempt]);
  const more = () => {
    if (state.next === null || state.loadingMore) return;
    const mine = ticket.current;
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    get<Page<T, string | number>>(`${first}&cursor=${encodeURIComponent(state.next)}`).then(
      (p) =>
        mine === ticket.current &&
        setState((s) => ({ ...s, items: [...(s.items ?? []), ...p.items], next: p.next === null ? null : String(p.next), loadingMore: false })),
      (e: unknown) => mine === ticket.current && setState((s) => ({ ...s, loadingMore: false, moreError: asError(e) })),
    );
  };
  return { ...state, hasMore: state.next !== null, more, reload: () => setAttempt((a) => a + 1) };
}

/** The best, finalized and indexed heights: read once from /api/status, then followed on the live
 * stream (shared with the header). Null until known. */
export function useHead(): Head | null {
  const [head, setHead] = useState<Head | null>(null);
  useEffect(() => {
    let gone = false;
    let streamed = false;
    get<Status>("/api/status").then(
      (s) => !gone && !streamed && setHead({ best: s.best, finalized: s.finalized, indexed: s.indexed }),
      () => {},
    );
    const stop = live((h) => {
      streamed = true;
      setHead(h);
    });
    return () => {
      gone = true;
      stop();
    };
  }, []);
  return head;
}

export type Labels = {
  /** Lowercase hex key to label, Aura and GRANDPA keys alike. */
  byKey: Map<string, string>;
  /** The GRANDPA set the node is on, and its members' labels (short keys when unlabelled). */
  setId: number | null;
  grandpa: string[];
};

/** The short form of a key: its label when the API knows one. */
export const keyLabel = (labels: Labels, key: string, short: (k: string) => string): string => labels.byKey.get(key.toLowerCase()) ?? short(key);

/** Labels of the validators, from /api/network. Empty when the node is away: keys are then shown. */
export function useLabels(short: (k: string) => string): Labels {
  const { data } = useApi<Network>("/api/network");
  const byKey = new Map<string, string>();
  if (data === null || !Array.isArray(data.validators?.aura) || !Array.isArray(data.validators.grandpa)) return { byKey, setId: null, grandpa: [] };
  for (const v of [...data.validators.aura, ...data.validators.grandpa]) if (v.label !== null) byKey.set(v.key.toLowerCase(), v.label);
  return { byKey, setId: data.validators.setId, grandpa: data.validators.grandpa.map((v) => v.label ?? short(v.key)) };
}
