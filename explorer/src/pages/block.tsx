import type { ComponentChildren } from "preact";
import { useRoute } from "preact-iso";
import type { BlockDetail } from "../api.ts";
import { type Labels, keyLabel, useApi, useHead, useLabels } from "../data.ts";
import { formatNumber, formatTime, shortHash } from "../format.ts";
import { Age, Empty, ErrorCard, Section, Skeleton, Table, useNow } from "../ui/table.tsx";
import { eventColumns } from "./events.tsx";
import { extrinsicColumns } from "./extrinsics.tsx";

/** A page title for a block id: its number, or the edges of its hash. */
export const blockTitle = (id: string): string => (/^\d+$/.test(id) ? formatNumber(Number(id)) : shortHash(id));

export const Row = ({ label, children }: { label: string; children: ComponentChildren }) => (
  <div class="row">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** Who finalized the block: the signers of its justification when it carries one, else the
 * GRANDPA set that was in charge (with its members when the node is on that set). */
export function finalizedBy(block: BlockDetail, labels: Labels): string {
  if (block.justificationSigners !== null) return `Signed by ${block.justificationSigners.map((k) => keyLabel(labels, k, shortHash)).join(", ")}`;
  const members = labels.setId === block.authoritySetId && labels.grandpa.length > 0 ? `: ${labels.grandpa.join(", ")}` : "";
  return `GRANDPA authority set #${block.authoritySetId}${members}`;
}

export function Block() {
  const { params } = useRoute();
  const id = params.id ?? "";
  const { data, error, reload } = useApi<BlockDetail>(`/api/block/${encodeURIComponent(id)}`);
  const head = useHead();
  const labels = useLabels(shortHash);
  const now = useNow();
  // the API answers 0 while the node is away: unknown, not "nothing is final"
  const finalized = head !== null && head.finalized > 0 ? head.finalized : null;
  const top = head === null ? null : (head.indexed ?? head.best);

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
            <Row label="Produced by">{data.author === null ? <span class="x-quiet">Unknown</span> : keyLabel(labels, data.author, shortHash)}</Row>
            <Row label="Finalized by">{finalized !== null && data.number > finalized ? <span class="x-pending">Not finalized yet</span> : finalizedBy(data, labels)}</Row>
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
        </>
      )}
    </section>
  );
}
