import type { BlockItem } from "../api.ts";
import { formatNumber, shortHash } from "../format.ts";
import { Producer } from "../ui/fields.tsx";
import { Age, BlockLink, PagedTable, useNow } from "../ui/table.tsx";

export function Blocks() {
  const now = useNow();
  return (
    <section class="x-page">
      <h1>Blocks</h1>
      <PagedTable<BlockItem>
        path="/api/blocks"
        label="Blocks"
        empty="No blocks yet."
        rowKey={(b) => b.hash}
        columns={[
          { label: "Block", cell: (b) => <BlockLink n={b.number} /> },
          { label: "Age", cell: (b) => <Age ms={b.timestamp} now={now} /> },
          { label: "Produced by", cell: (b) => <Producer author={b.author} label={b.authorLabel} /> },
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
