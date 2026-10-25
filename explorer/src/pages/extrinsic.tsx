import { useRoute } from "preact-iso";
import type { ExtrinsicFull, ExtrinsicMatches } from "../api.ts";
import { useApi } from "../data.ts";
import { formatIdt, formatNumber, formatTime, shortHash } from "../format.ts";
import { AccountLink, Age, BlockLink, Empty, ErrorCard, Section, Skeleton, Table, useNow } from "../ui/table.tsx";
import { CallView } from "../ui/value.tsx";
import { Row } from "./block.tsx";
import { eventColumns } from "./events.tsx";
import { extrinsicColumns } from "./extrinsics.tsx";

const amount = (planck: string | null) => (planck === null ? <span class="x-quiet">None</span> : formatIdt(planck));

export function Extrinsic() {
  const { params } = useRoute();
  const id = params.id ?? "";
  const { data, error, reload } = useApi<ExtrinsicFull | ExtrinsicMatches>(`/api/extrinsic/${encodeURIComponent(id)}`);
  const now = useNow();
  const title = id.startsWith("0x") ? shortHash(id) : id;

  if (error) {
    return (
      <section class="x-page">
        <h1>Extrinsic {title}</h1>
        <ErrorCard error={error} notFound={`No extrinsic ${title} on this chain.`} retry={reload} />
      </section>
    );
  }
  if (data === null) {
    return (
      <section class="x-page">
        <h1>Extrinsic {title}</h1>
        <Skeleton rows={8} />
      </section>
    );
  }
  if ("matches" in data) {
    return (
      <section class="x-page">
        <h1>Extrinsic {title}</h1>
        <p class="note">This hash was included {formatNumber(data.matches.length)} times. Each inclusion is its own extrinsic.</p>
        <Table label="Inclusions" rows={data.matches} rowKey={(x) => x.id} columns={extrinsicColumns(now)} />
      </section>
    );
  }
  const x = data;
  return (
    <section class="x-page">
      <h1>Extrinsic {x.id}</h1>
      <dl class="fields x-fields">
        <Row label="Block">
          <BlockLink n={x.block} />
        </Row>
        <Row label="Time">{x.timestamp === null ? <span class="x-quiet">Genesis</span> : <>{formatTime(x.timestamp)} <span class="x-quiet">(<Age ms={x.timestamp} now={now} />)</span></>}</Row>
        <Row label="Hash">
          <span class="x-hash">{x.hash}</span>
        </Row>
        <Row label="Signer">{x.signer === null ? <span class="x-quiet">Unsigned</span> : <AccountLink address={x.signer} />}</Row>
        <Row label="Nonce">{x.nonce === null ? <span class="x-quiet">None</span> : formatNumber(x.nonce)}</Row>
        <Row label="Tip">{amount(x.tip)}</Row>
        <Row label="Fee">{amount(x.fee)}</Row>
        <Row label="Result">
          {x.success ? (
            "Success"
          ) : (
            <span class="x-result">
              <span class="x-failed">Failed</span>
              {x.error && (
                <>
                  <span class="x-error-name">
                    {x.error.pallet}.{x.error.name}
                  </span>
                  {x.error.docs && <span class="x-error-docs">{x.error.docs}</span>}
                </>
              )}
            </span>
          )}
        </Row>
      </dl>
      <Section title="Call">
        <CallView pallet={x.pallet} method={x.method} args={x.args} />
      </Section>
      <Section title={`Events (${formatNumber(x.events.length)})`} label="Events">
        {x.events.length === 0 ? <Empty>No events for this extrinsic.</Empty> : <Table label="Events of the extrinsic" rows={x.events} rowKey={(e) => e.id} columns={eventColumns(now, false)} />}
      </Section>
    </section>
  );
}
