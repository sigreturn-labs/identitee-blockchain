import { CopyButton } from "@web/ui/copy.tsx";
import type { Network as NetworkData } from "../api.ts";
import { useApi } from "../data.ts";
import { formatNumber, shortHash } from "../format.ts";
import { Row } from "../ui/fields.tsx";
import { AccountLink, ErrorCard, Section, Skeleton, Table } from "../ui/table.tsx";

type Validator = { account: string | null; label: string | null; aura: string | null; grandpa: string | null };

/** One row per validator: the Aura and GRANDPA keys owned by the same account are one validator,
 * and, for keys without an owner (a runtime without sessions), those that carry the same label. */
export function validators(v: NetworkData["validators"]): Validator[] {
  const rows: Validator[] = [];
  const byAccount = new Map<string, Validator>();
  const byLabel = new Map<string, Validator>();
  for (const a of v.aura) {
    // `?? null`: an API older than the owners leaves them out
    const row = { account: a.account ?? null, label: a.label, aura: a.key, grandpa: null };
    rows.push(row);
    if (row.account !== null) byAccount.set(row.account, row);
    else if (a.label !== null) byLabel.set(a.label, row);
  }
  for (const g of v.grandpa) {
    const account = g.account ?? null;
    const same = account !== null ? byAccount.get(account) : g.label !== null ? byLabel.get(g.label) : undefined;
    if (same && same.grandpa === null) same.grandpa = g.key;
    else rows.push({ account, label: g.label, aura: null, grandpa: g.key });
  }
  return rows;
}

const Key = ({ k, what }: { k: string | null; what: string }) =>
  k === null ? (
    <span class="x-quiet">None</span>
  ) : (
    <span class="x-key">
      <span title={k}>{shortHash(k)}</span>
      <CopyButton text={k} what={what} />
    </span>
  );

/** `6.01 s` */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;

export function Network() {
  const { data, error, reload } = useApi<NetworkData>("/api/network");
  return (
    <section class="x-page">
      <h1>Network</h1>
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : data === null ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <dl class="fields x-fields">
            <Row label="Peers">{formatNumber(data.health.peers)}</Row>
            <Row label="Sync">{data.health.isSyncing ? "Syncing" : "Up to date"}</Row>
            <Row label="Block time">
              {data.blockTime.recent === null
                ? `Target ${seconds(data.blockTime.target)}`
                : `${seconds(data.blockTime.recent)} on average over the last 100 blocks, target ${seconds(data.blockTime.target)}`}
            </Row>
            <Row label="GRANDPA set">#{data.grandpaSetId}</Row>
          </dl>
          <Section title="Validators">
            <Table
              label="Validators"
              rows={validators(data.validators)}
              rowKey={(v) => `${v.aura ?? ""}${v.grandpa ?? ""}`}
              columns={[
                {
                  label: "Validator",
                  cell: (v) => (v.account !== null ? <AccountLink address={v.account} /> : (v.label ?? <span class="x-quiet">Unknown</span>)),
                },
                { label: "Aura key", cell: (v) => <Key k={v.aura} what="Aura key" /> },
                { label: "GRANDPA key", cell: (v) => <Key k={v.grandpa} what="GRANDPA key" /> },
                { label: "Roles", cell: (v) => [v.aura && "Producing", v.grandpa && "Finalizing"].filter(Boolean).join(", ") },
              ]}
            />
          </Section>
        </>
      )}
    </section>
  );
}
