import { useRoute } from "preact-iso";
import type { Attestation, AuthorityDetail } from "../api.ts";
import { useApi } from "../data.ts";
import { capabilityLabel, formatNumber } from "../format.ts";
import { FeedTable } from "../ui/feed.tsx";
import { Row } from "../ui/fields.tsx";
import { AccountLink, Empty, ErrorCard, Section, Skeleton, Table } from "../ui/table.tsx";

export function Authority() {
  const { params } = useRoute();
  const id = params.id ?? "";
  // the authority itself is read from the node; its attestations come from the index, so they stay
  // on screen while the node is away
  const { data, error, reload } = useApi<AuthorityDetail>(`/api/authority/${encodeURIComponent(id)}`);
  const missing = error !== null && (error.status === 404 || error.status === 400);
  return (
    <section class="x-page">
      <h1>{data?.name ?? `Authority ${id}`}</h1>
      {error ? (
        <ErrorCard error={error} notFound={`No authority ${id} on this chain.`} retry={reload} />
      ) : data === null ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <dl class="fields x-fields">
            <Row label="Id">{data.id}</Row>
            <Row label="Status">{data.active ? "Active" : "Inactive"}</Row>
          </dl>
          <Section title={`Agents (${formatNumber(data.agents.length)})`} label="Agents">
            {data.agents.length === 0 ? (
              <Empty>This authority has no agents.</Empty>
            ) : (
              <Table
                label="Agents of the authority"
                rows={data.agents}
                rowKey={(a) => a.address}
                columns={[
                  { label: "Agent", cell: (a) => <AccountLink address={a.address} /> },
                  {
                    label: "Capabilities",
                    cell: (a) => (a.capabilityNames.length === 0 ? <span class="x-quiet">None</span> : a.capabilityNames.map(capabilityLabel).join(", ")),
                    class: "x-wide",
                  },
                ]}
              />
            )}
          </Section>
        </>
      )}
      {!missing && (
        <Section title="Attestations">
          <FeedTable<Attestation>
            key={id}
            path={`/api/attestations?authority=${encodeURIComponent(id)}`}
            label="Attestations by the authority"
            empty="No attestations by this authority yet."
            fallback={(a) => `Attestation ${a.kind}`}
          />
        </Section>
      )}
    </section>
  );
}
