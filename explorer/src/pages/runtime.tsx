import type { Runtime as RuntimeData, RuntimeItem } from "../api.ts";
import { useApi } from "../data.ts";
import { formatNumber } from "../format.ts";
import { Row } from "../ui/fields.tsx";
import { BlockLink, ErrorCard, Section, Skeleton, Table } from "../ui/table.tsx";

type Pallet = RuntimeData["pallets"][number];

const KINDS: Array<[title: string, key: "calls" | "events" | "errors" | "storage" | "constants", one: string, many: string]> = [
  ["Calls", "calls", "call", "calls"],
  ["Events", "events", "event", "events"],
  ["Errors", "errors", "error", "errors"],
  ["Storage", "storage", "storage item", "storage items"],
  ["Constants", "constants", "constant", "constants"],
];

const Items = ({ title, pallet, items }: { title: string; pallet: string; items: RuntimeItem[] }) => (
  <section class="x-items" aria-label={`${title} of ${pallet}`}>
    <h3>{title}</h3>
    <dl>
      {items.map((it) => (
        <div key={it.name}>
          <dt>{it.name}</dt>
          {it.docs && <dd>{it.docs}</dd>}
        </div>
      ))}
    </dl>
  </section>
);

/** A pallet folded to its name and what it holds; opened, its items with their docs. */
function PalletView({ pallet }: { pallet: Pallet }) {
  const counts = KINDS.filter(([, key]) => pallet[key].length > 0).map(([, key, one, many]) => `${formatNumber(pallet[key].length)} ${pallet[key].length === 1 ? one : many}`);
  return (
    <details class="x-pallet">
      <summary>
        <span class="x-pallet-name">{pallet.name}</span>
        <span class="x-quiet">{counts.length > 0 ? counts.join(", ") : "Nothing exposed"}</span>
      </summary>
      <div class="x-pallet-body">
        <p class="x-quiet">Index {pallet.index}</p>
        {KINDS.map(([title, key]) => (pallet[key].length > 0 ? <Items key={key} title={title} pallet={pallet.name} items={pallet[key]} /> : null))}
      </div>
    </details>
  );
}

export function Runtime() {
  const { data, error, reload } = useApi<RuntimeData>("/api/runtime");
  return (
    <section class="x-page">
      <h1>Runtime</h1>
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : data === null ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <dl class="fields x-fields">
            <Row label="Spec name">{data.current?.specName ?? <span class="x-quiet">Unknown</span>}</Row>
            <Row label="Spec version">{data.current ? data.current.specVersion : <span class="x-quiet">Unknown</span>}</Row>
          </dl>
          <Section title="Upgrades">
            <Table
              label="Runtime versions"
              rows={[...data.versions].reverse()}
              rowKey={(v) => String(v.specVersion)}
              columns={[
                { label: "Version", cell: (v) => v.specVersion },
                { label: "Spec name", cell: (v) => v.specName },
                { label: "From block", cell: (v) => <BlockLink n={v.fromBlock} />, class: "x-end" },
              ]}
            />
          </Section>
          <Section title={`Pallets (${formatNumber(data.pallets.length)})`} label="Pallets">
            <div class="x-pallets">
              {data.pallets.map((p) => (
                <PalletView key={p.name} pallet={p} />
              ))}
            </div>
          </Section>
        </>
      )}
    </section>
  );
}
