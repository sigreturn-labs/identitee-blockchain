import type { ExtrinsicSummary, Ts } from "../api.ts";
import { type Column, AccountLink, Age, BlockLink, CallName, PagedTable, useNow } from "../ui/table.tsx";

/** The columns of an extrinsic list, here and on a block's page. */
export function extrinsicColumns(now: number, withBlock = true): Column<ExtrinsicSummary & Partial<Ts>>[] {
  return [
    { label: "Extrinsic", cell: (x) => <a href={`/extrinsic/${x.id}`}>{x.id}</a> },
    ...(withBlock
      ? [
          { label: "Block", cell: (x: ExtrinsicSummary) => <BlockLink n={x.block} /> },
          { label: "Age", cell: (x: ExtrinsicSummary & Partial<Ts>) => <Age ms={x.timestamp ?? null} now={now} /> },
        ]
      : []),
    { label: "Call", cell: (x) => <CallName pallet={x.pallet} method={x.method} inner={x.inner} /> },
    { label: "Signer", cell: (x) => (x.signer === null ? <span class="x-quiet">Unsigned</span> : <AccountLink address={x.signer} />) },
    { label: "Result", cell: (x) => (x.success ? "Success" : <span class="x-failed">Failed</span>), class: "x-nowrap" },
  ];
}

export function Extrinsics() {
  const now = useNow();
  return (
    <section class="x-page">
      <h1>Extrinsics</h1>
      <PagedTable<ExtrinsicSummary & Ts> path="/api/extrinsics" label="Extrinsics" empty="No extrinsics yet." rowKey={(x) => x.id} columns={extrinsicColumns(now)} />
    </section>
  );
}
