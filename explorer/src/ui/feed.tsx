// The identity feeds (attestations, migrations, usernames): newest first, one sentence per row with
// the account, the block and the age, and links between the three.
import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import type { Ts } from "../api.ts";
import { type Column, AccountLink, Age, BlockLink, PagedTable, useNow } from "./table.tsx";

export type FeedRow = { who: string | null; kind: string; block: number; eventId: string; sentence: string | null } & Ts;

const FEEDS: Array<[label: string, path: string]> = [
  ["Attestations", "/attestations"],
  ["Migrations", "/migrations"],
  ["Usernames", "/usernames"],
];

/** What happened: the sentence of the event, else `fallback` (the feed's noun and the kind). */
export function feedColumns<T extends FeedRow>(now: number, fallback: (row: T) => string): Column<T>[] {
  return [
    { label: "What", cell: (r) => (r.sentence !== null ? <span class="x-sentence">{r.sentence}</span> : fallback(r)), class: "x-wide" },
    { label: "Account", cell: (r) => (r.who === null ? <span class="x-quiet">None</span> : <AccountLink address={r.who} />) },
    { label: "Block", cell: (r) => <BlockLink n={r.block} /> },
    { label: "Age", cell: (r) => <Age ms={r.timestamp} now={now} /> },
  ];
}

/** A feed read page by page from `path`. */
export function FeedTable<T extends FeedRow>({ path, label, empty, fallback }: { path: string; label: string; empty: string; fallback: (row: T) => string }) {
  const now = useNow();
  return <PagedTable<T> path={path} label={label} empty={empty} rowKey={(r) => r.eventId} columns={feedColumns<T>(now, fallback)} />;
}

/** A feed page: its title, the links to the other feeds, then the list. */
export function FeedPage({ title, children }: { title: string; children: ComponentChildren }) {
  const { path } = useLocation();
  return (
    <section class="x-page">
      <div class="x-feed-head">
        <h1>{title}</h1>
        <nav class="x-subnav" aria-label="Identity feeds">
          {FEEDS.map(([label, to]) => (
            <a key={to} href={to} aria-current={path === to ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </div>
      {children}
    </section>
  );
}
