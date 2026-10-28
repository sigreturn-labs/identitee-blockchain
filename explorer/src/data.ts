// Data hooks of the pages: one read, a paged list and the live head.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, get, live, type Head, type Page, type Status } from "./api.ts";

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
 * of the previous page. A new `version` reads the first page again in place, unless more pages were
 * loaded: the list does not move under someone reading further down. */
export function usePaged<T>(base: string, limit = 25, version: unknown = 0): Paged<T> {
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
  const loadedMore = useRef(false);
  const seenVersion = useRef(version);
  useEffect(() => {
    const mine = ++ticket.current;
    loadedMore.current = false;
    setState({ items: null, next: null, error: null, moreError: null, loadingMore: false });
    get<Page<T, string | number>>(first).then(
      (p) => mine === ticket.current && setState({ items: p.items, next: p.next === null ? null : String(p.next), error: null, moreError: null, loadingMore: false }),
      (e: unknown) => mine === ticket.current && setState((s) => ({ ...s, error: asError(e) })),
    );
    return () => {
      ticket.current++;
    };
  }, [first, attempt]);
  useEffect(() => {
    if (Object.is(seenVersion.current, version)) return;
    seenVersion.current = version;
    if (loadedMore.current) return;
    const mine = ticket.current;
    get<Page<T, string | number>>(first).then(
      (p) => mine === ticket.current && !loadedMore.current && setState((s) => ({ ...s, items: p.items, next: p.next === null ? null : String(p.next), error: null })),
      () => {}, // the list on screen stays; the next version tries again
    );
  }, [version, first]);
  const more = () => {
    if (state.next === null || state.loadingMore) return;
    loadedMore.current = true;
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
