import { useRoute } from "preact-iso";
import { knownHeight, type BlockDetail } from "../api.ts";
import { useApi, useHead } from "../data.ts";
import { formatNumber, formatTime } from "../format.ts";
import { blockTitle, finalizedBy, Producer, Row } from "../ui/fields.tsx";
import { Age, Empty, ErrorCard, Section, Skeleton, Table, useNow } from "../ui/table.tsx";
import { eventColumns } from "./events.tsx";
import { extrinsicColumns } from "./extrinsics.tsx";

export function Block() {
  const { params } = useRoute();
  const id = params.id ?? "";
  const { data, error, reload } = useApi<BlockDetail>(`/api/block/${encodeURIComponent(id)}`);
  const head = useHead();
  const now = useNow();
  // unknown until the head is read, and while the node is away (the API then answers null): the row
  // says so rather than naming signers of a block that may not be final
  const finalized = knownHeight(head?.finalized);
  const top = head === null ? null : (head.indexed ?? knownHeight(head.best));

  return (
    <section class="x-page">
      <h1>Block {data ? formatNumber(data.number) : blockTitle(id)}</h1>
      {error ? (
        <ErrorCard error={error} notFound={`No block ${id} on this chain.`} retry={reload} />
      ) : data === null ? (
        <Skeleton rows={8} />
      ) : (
        <>
          <dl class="fields x-fields">
            <Row label="Hash">
              <span class="x-hash">{data.hash}</span>
            </Row>
            <Row label="Parent">
              {data.number === 0 ? (
                <span class="x-quiet">None</span>
              ) : (
                <a class="x-hash" href={`/block/${data.number - 1}`}>
                  {data.parentHash}
                </a>
              )}
            </Row>
            <Row label="Time">{data.timestamp === null ? <span class="x-quiet">Genesis</span> : <>{formatTime(data.timestamp)} <span class="x-quiet">(<Age ms={data.timestamp} now={now} />)</span></>}</Row>
            <Row label="Produced by">
              <Producer author={data.author} label={data.authorLabel} account={data.authorAccount} />
            </Row>
            <Row label="Finalized by">
              {finalized === null ? <span class="x-quiet">Unknown</span> : data.number > finalized ? <span class="x-pending">Not finalized yet</span> : finalizedBy(data)}
            </Row>
            <Row label="State root">
              <span class="x-hash">{data.stateRoot}</span>
            </Row>
            <Row label="Extrinsics root">
              <span class="x-hash">{data.extrinsicsRoot}</span>
            </Row>
            <Row label="Runtime">Version {data.specVersion}</Row>
          </dl>
          <nav class="x-pager" aria-label="Neighbouring blocks">
            {data.number > 0 && (
              <a class="button" rel="prev" href={`/block/${data.number - 1}`}>
                Block {formatNumber(data.number - 1)}
              </a>
            )}
            {top !== null && data.number < top && (
              <a class="button" rel="next" href={`/block/${data.number + 1}`}>
                Block {formatNumber(data.number + 1)}
              </a>
            )}
          </nav>
          <Section title={`Extrinsics (${formatNumber(data.extrinsics.length)})`} label="Extrinsics">
            {data.extrinsics.length === 0 ? (
              <Empty>No extrinsics in this block.</Empty>
            ) : (
              <Table label="Extrinsics of the block" rows={data.extrinsics} rowKey={(x) => x.id} columns={extrinsicColumns(now, false)} />
            )}
          </Section>
          <Section title={`Events (${formatNumber(data.events.length)})`} label="Events">
            {data.events.length === 0 ? <Empty>No events in this block.</Empty> : <Table label="Events of the block" rows={data.events} rowKey={(e) => e.id} columns={eventColumns(now, false)} />}
          </Section>
          <Section title="Digest logs">
            {data.logs === null ? (
              <Empty>Not available while the node is unreachable.</Empty>
            ) : data.logs.length === 0 ? (
              <Empty>No digest logs in this block.</Empty>
            ) : (
              <Table
                label="Digest logs of the block"
                rows={data.logs.map((log, index) => ({ ...log, index }))}
                rowKey={(l) => String(l.index)}
                columns={[
                  { label: "Log", cell: (l) => l.index },
                  { label: "Type", cell: (l) => l.type },
                  { label: "Engine", cell: (l) => (l.engine === null ? <span class="x-quiet">None</span> : l.engine) },
                  { label: "Data", cell: (l) => <span class="x-hash">{l.data}</span>, class: "x-wide" },
                ]}
              />
            )}
          </Section>
        </>
      )}
    </section>
  );
}
