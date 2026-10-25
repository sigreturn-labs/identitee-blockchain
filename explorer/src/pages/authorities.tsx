import type { Authority } from "../api.ts";
import { useApi } from "../data.ts";
import { formatNumber } from "../format.ts";
import { Empty, ErrorCard, Skeleton, Table } from "../ui/table.tsx";

export function Authorities() {
  const { data, error, reload } = useApi<{ items: Authority[] }>("/api/authorities");
  return (
    <section class="x-page">
      <h1>Authorities</h1>
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : data === null ? (
        <Skeleton rows={4} />
      ) : data.items.length === 0 ? (
        <Empty>No authorities registered yet.</Empty>
      ) : (
        <Table
          label="Authorities"
          rows={data.items}
          rowKey={(a) => String(a.id)}
          columns={[
            { label: "Authority", cell: (a) => <a href={`/authority/${a.id}`}>{a.name}</a>, class: "x-wide" },
            { label: "Id", cell: (a) => a.id },
            { label: "Status", cell: (a) => (a.active ? "Active" : <span class="x-quiet">Inactive</span>) },
            { label: "Agents", cell: (a) => formatNumber(a.agents.length), class: "x-end" },
          ]}
        />
      )}
    </section>
  );
}
