import type { BlockItem } from "../api.ts";
import { formatNumber, shortHash } from "../format.ts";
import { useHead } from "../data.ts";
import { BlockCell, Producer } from "../ui/fields.tsx";
import { Age, PagedTable, useNow } from "../ui/table.tsx";

export function Blocks() {
  const now = useNow();
  const head = useHead();
  return (
    <section class="x-page">
      <h1>Blocks</h1>
      <PagedTable<BlockItem>
        path="/api/blocks"
        label="Blocks"
        empty="No blocks yet."
        rowKey={(b) => b.hash}
        version={head === null ? null : `${head.best}/${head.finalized}/${head.indexed}`}
        columns={[
          { label: "Block", cell: (b) => <BlockCell block={b} /> },
          { label: "Age", cell: (b) => <Age ms={b.timestamp} now={now} /> },
          { label: "Produced by", cell: (b) => <Producer author={b.author} label={b.authorLabel} account={b.authorAccount} /> },
          { label: "Extrinsics", cell: (b) => formatNumber(b.extrinsicCount), class: "x-end" },
          { label: "Events", cell: (b) => (b.eventCount === null ? <span class="x-quiet">Pending</span> : formatNumber(b.eventCount)), class: "x-end" },
          {
            label: "Hash",
            cell: (b) => (
              <a href={`/block/${b.hash}`} title={b.hash}>
                {shortHash(b.hash)}
              </a>
            ),
          },
        ]}
      />
    </section>
  );
}
