import type { BlockRow } from "../api.ts";
import { keyLabel, useLabels } from "../data.ts";
import { formatNumber, shortHash } from "../format.ts";
import { Age, BlockLink, PagedTable, useNow } from "../ui/table.tsx";

export function Blocks() {
  const now = useNow();
  const labels = useLabels(shortHash);
  return (
    <section class="x-page">
      <h1>Blocks</h1>
      <PagedTable<BlockRow>
        path="/api/blocks"
        label="Blocks"
        empty="No blocks yet."
        rowKey={(b) => b.hash}
        columns={[
          { label: "Block", cell: (b) => <BlockLink n={b.number} /> },
          { label: "Age", cell: (b) => <Age ms={b.timestamp} now={now} /> },
          { label: "Produced by", cell: (b) => (b.author === null ? <span class="x-quiet">Unknown</span> : keyLabel(labels, b.author, shortHash)) },
          { label: "Extrinsics", cell: (b) => formatNumber(b.extrinsicCount), class: "x-end" },
          { label: "Events", cell: (b) => formatNumber(b.eventCount), class: "x-end" },
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
