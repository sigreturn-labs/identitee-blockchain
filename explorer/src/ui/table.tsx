// The building blocks of the list and detail pages: a table that stacks on a phone, the paged
// list with its skeleton, empty state and Load more, the cards for errors, and the small cells
// (block link, age, account).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { LEVEL_LABELS, LevelBadge } from "@web/ui/level.tsx";
import type { TrustLevel } from "@web/chain/identity.ts";
import { shortAddress, publicKeyOf } from "../address.ts";
import type { ApiError } from "../api.ts";
import { type Paged, usePaged } from "../data.ts";
import { ago, formatNumber } from "../format.ts";
import { useIdentity } from "../identities.ts";
import { AccountAvatar } from "./account-avatar.tsx";

export const isTrust = (t: string | null): t is TrustLevel => t !== null && Object.hasOwn(LEVEL_LABELS, t);

export type Column<T> = { label: string; cell: (row: T) => ComponentChildren; class?: string };

/** A table of `rows`. On a phone each row becomes a block, every cell under its column's label. */
export function Table<T>({ label, columns, rows, rowKey }: { label: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string }) {
  return (
    <table class="x-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.label} scope="col" class={c.class}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td key={c.label} class={c.class} data-label={c.label}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Quiet bars where the rows will be: the space the table takes, without its data. */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div class="x-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} class="bone x-bone-row" aria-hidden="true" />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="x-empty">{children}</p>;
}

/** What went wrong with a read, and the way out when there is one. `notFound` says what is missing
 * (a 404, or an id the API refused as malformed). */
export function ErrorCard({ error, notFound, retry }: { error: ApiError; notFound?: string; retry?: () => void }) {
  if (notFound !== undefined && (error.status === 404 || error.status === 400)) {
    return (
      <section class="x-card" role="alert">
        <h2>Not found</h2>
        <p class="note">{notFound}</p>
        <a class="button" href="/">
          Back to the overview
        </a>
      </section>
    );
  }
  const text =
    error.code === "node_down"
      ? "The node behind the explorer is not answering. Try again in a moment."
      : error.code === "too_many_clients"
        ? "The explorer is busy. Try again in a moment."
        : "The explorer API is not answering. Try again in a moment.";
  return (
    <section class="x-card" role="alert">
      <h2>Unavailable</h2>
      <p class="note">{text}</p>
      {retry && (
        <button class="button" type="button" onClick={retry}>
          Try again
        </button>
      )}
    </section>
  );
}

/** A list read page by page: skeleton, error card, empty state, rows, then Load more. */
export function PagedTable<T>({
  path,
  label,
  columns,
  rowKey,
  empty,
  version,
}: {
  path: string;
  label: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty: string;
  /** A new value reads the first page again (see `usePaged`). */
  version?: unknown;
}) {
  const list = usePaged<T>(path, 25, version);
  return <PagedView list={list} label={label} columns={columns} rowKey={rowKey} empty={empty} />;
}

export function PagedView<T>({ list, label, columns, rowKey, empty }: { list: Paged<T>; label: string; columns: Column<T>[]; rowKey: (row: T) => string; empty: string }) {
  if (list.error !== null) return <ErrorCard error={list.error} retry={list.reload} />;
  if (list.items === null) return <Skeleton />;
  if (list.items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      <Table label={label} columns={columns} rows={list.items} rowKey={rowKey} />
      {(list.hasMore || list.moreError) && (
        <div class="x-more">
          {list.moreError && <p class="problem">Could not load more. Try again.</p>}
          {list.hasMore && (
            <button class="button" type="button" disabled={list.loadingMore} onClick={list.more}>
              {list.loadingMore ? "Loading" : "Load more"}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The current time, moving every `ms`: for ages that stay true while the page is open. */
export function useNow(ms = 5_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export const Age = ({ ms, now }: { ms: number | null; now: number }) =>
  ms === null ? <span class="x-quiet">Genesis</span> : <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toISOString()}>{ago(ms, now)}</time>;

export const BlockLink = ({ n }: { n: number }) => <a href={`/block/${n}`}>{formatNumber(n)}</a>;

/** A display name that could pass for an address once shown. Allowlist after NFKC: letters, marks,
 * digits, single spaces and `' - & ,` only, and no long base58 run. */
export const looksLikeAddress = (name: string): boolean => {
  const folded = name.normalize("NFKC");
  return !/^[\p{L}\p{M}\p{N}'&,-]+( [\p{L}\p{M}\p{N}'&,-]+)*$/u.test(folded) || /[1-9A-HJ-NP-Za-km-z]{16,}/.test(folded);
};

/** What a link calls an account: `@` and its username, which is unique and needs a verified field,
 * else its display name, which anyone may set, unless that name could pass for an address. A display
 * name cannot hold `@`, so it never passes for a username. */
export function accountName(identity: { display: string | null; username: string | null } | null | undefined): string | null {
  if (identity?.username) return `@${identity.username}`;
  const display = identity?.display ?? null;
  // shown as checked: the NFKC form, so a look-alike character never reaches the page
  const folded = display?.normalize("NFKC") ?? null;
  return folded !== null && folded.trim() !== "" && !looksLikeAddress(folded) ? folded : null;
}

/** An account: its avatar, then who it is when it says so (its name, with the edges of
 * the address in brackets and the trust badge), else the edges of the address, linking to its page. */
export function AccountLink({ address }: { address: string }) {
  const key = publicKeyOf(address);
  const identity = useIdentity(address);
  const name = accountName(identity);
  const trust = identity?.trust ?? null;
  return (
    <a class="x-account" href={`/account/${address}`} title={address}>
      {key !== null && (
        <span class="x-account-avatar" aria-hidden="true">
          <AccountAvatar address={address} publicKey={key} version={identity?.avatar} size={18} />
        </span>
      )}
      {name === null ? (
        <span>{shortAddress(address)}</span>
      ) : (
        <>
          <span class="x-account-name">{name}</span>
          <span class="x-account-addr">({shortAddress(address, 4)})</span>
        </>
      )}
      {trust !== null && isTrust(trust) && <LevelBadge trust={trust} />}
    </a>
  );
}

/** The name of a call, `pallet.method`, followed by the calls nested in it. */
export const CallName = ({ pallet, method, inner = [] }: { pallet: string; method: string; inner?: Array<{ pallet: string; method: string }> }) => (
  <span class="x-callname">
    <span>
      {pallet}.{method}
    </span>
    {inner.map((c, i) => (
      <span key={i} class="x-inner">
        {c.pallet}.{c.method}
      </span>
    ))}
  </span>
);

/** A titled part of a page. */
export function Section({ title, label, action, children }: { title: string; label?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="x-section" aria-label={label ?? title}>
      <div class="x-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
