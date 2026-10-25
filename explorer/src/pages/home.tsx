import { useEffect, useRef, useState } from "preact/hooks";
import type { BlockRow, EventRow, ExtrinsicSummary, Page, Stats, Ts } from "../api.ts";
import { keyLabel, useApi, useHead, useLabels } from "../data.ts";
import { formatNumber, shortHash } from "../format.ts";
import { AccountLink, Age, BlockLink, CallName, Empty, ErrorCard, Section, Skeleton, Table, useNow } from "../ui/table.tsx";

/** A number that moves when the indexed head does, after the first one: the lists are read again
 * then, not when the page first learns the head. */
function useIndexVersion(indexed: number | null | undefined): number {
  const [version, setVersion] = useState(0);
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (indexed === undefined || indexed === null) return;
    if (seen.current !== undefined && seen.current !== indexed) setVersion((v) => v + 1);
    seen.current = indexed;
  }, [indexed]);
  return version;
}

const COUNTERS: Array<[label: string, key: keyof Stats]> = [
  ["Accounts", "accounts"],
  ["Extrinsics", "extrinsics"],
  ["Transfers", "transfers"],
  ["Attestations", "attestations"],
  ["Usernames", "usernames"],
  ["Authorities", "authorities"],
];

export function Home() {
  const head = useHead();
  const version = useIndexVersion(head?.indexed);
  const now = useNow();
  const labels = useLabels(shortHash);
  const stats = useApi<Stats>("/api/stats", version);
  const blocks = useApi<Page<BlockRow, number>>("/api/blocks?limit=10", version);
  // the latest signed ones: most blocks hold only the timestamp inherent
  const extrinsics = useApi<Page<ExtrinsicSummary & Ts>>("/api/extrinsics?limit=100", version);
  const events = useApi<Page<EventRow & Ts>>("/api/events?pallet=identitee&limit=10", version);
  const signed = extrinsics.data?.items.filter((x) => x.signer !== null).slice(0, 10) ?? null;

  return (
    <section class="x-page">
      <h1>Overview</h1>
      {blocks.error && !blocks.data ? (
        <ErrorCard error={blocks.error} retry={blocks.reload} />
      ) : (
        <>
          <dl class="x-heads" aria-label="Heads">
            {(
              [
                // the API answers 0 for both heads while the node is away
                ["Best", head?.best || null],
                ["Finalized", head?.finalized || null],
                ["Indexed", head?.indexed ?? null],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{head === null ? <span class="bone x-bone-num" aria-hidden="true" /> : n === null ? <span class="x-quiet">Unknown</span> : <BlockLink n={n} />}</dd>
              </div>
            ))}
          </dl>
          {stats.data && (
            <dl class="x-counters" aria-label="Counters">
              {COUNTERS.map(([label, key]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{stats.data![key] === null ? "Unknown" : formatNumber(stats.data![key] as number)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div class="x-split">
            <Section title="Latest blocks" action={<a class="x-all" href="/blocks">All blocks</a>}>
              {blocks.data === null ? (
                <Skeleton rows={10} />
              ) : blocks.data.items.length === 0 ? (
                <Empty>No blocks yet.</Empty>
              ) : (
                <Table
                  label="Blocks"
                  rows={blocks.data.items}
                  rowKey={(b) => b.hash}
                  columns={[
                    { label: "Block", cell: (b) => <BlockLink n={b.number} /> },
                    { label: "Age", cell: (b) => <Age ms={b.timestamp} now={now} /> },
                    { label: "Produced by", cell: (b) => (b.author === null ? <span class="x-quiet">Unknown</span> : keyLabel(labels, b.author, shortHash)) },
                    { label: "Extrinsics", cell: (b) => formatNumber(b.extrinsicCount), class: "x-end" },
                  ]}
                />
              )}
            </Section>
            <Section title="Latest extrinsics" action={<a class="x-all" href="/extrinsics">All extrinsics</a>}>
              {extrinsics.error && !extrinsics.data ? (
                <ErrorCard error={extrinsics.error} retry={extrinsics.reload} />
              ) : signed === null ? (
                <Skeleton rows={10} />
              ) : signed.length === 0 ? (
                <Empty>No signed extrinsics in the latest blocks.</Empty>
              ) : (
                <Table
                  label="Extrinsics"
                  rows={signed}
                  rowKey={(x) => x.id}
                  columns={[
                    { label: "Extrinsic", cell: (x) => <a href={`/extrinsic/${x.id}`}>{x.id}</a> },
                    { label: "Call", cell: (x) => <CallName pallet={x.pallet} method={x.method} inner={x.inner} /> },
                    { label: "Signer", cell: (x) => <AccountLink address={x.signer!} /> },
                    { label: "Result", cell: (x) => (x.success ? "Success" : "Failed") },
                  ]}
                />
              )}
            </Section>
          </div>
          <Section title="Identity events" action={<a class="x-all" href="/events">All events</a>}>
            {events.error && !events.data ? (
              <ErrorCard error={events.error} retry={events.reload} />
            ) : events.data === null ? (
              <Skeleton rows={10} />
            ) : events.data.items.length === 0 ? (
              <Empty>No identity events yet.</Empty>
            ) : (
              <ul class="x-feed" aria-label="Latest identity events">
                {events.data.items.map((e) => (
                  <li key={e.id}>
                    <span class="x-sentence">{e.sentence ?? `${e.pallet}.${e.method}`}</span>
                    <span class="x-feed-meta">
                      <a href={e.extrinsicIndex === null ? `/block/${e.block}` : `/extrinsic/${e.block}-${e.extrinsicIndex}`}>Block {formatNumber(e.block)}</a>
                      <Age ms={e.timestamp} now={now} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </section>
  );
}
