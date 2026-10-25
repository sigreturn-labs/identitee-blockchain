// Decoded call arguments and event data, as the indexer stores them: addresses become account
// links, amounts read in IDT, nested calls (sudo, batch) are drawn as calls inside the call.
import { isAddress } from "../address.ts";
import { formatIdt, formatNumber } from "../format.ts";
import { AccountLink } from "./table.tsx";

// argument names that hold a planck amount
const AMOUNT = /^(value|amount|balance|free|reserved|new_free|new_reserved|deposit|tip|fee|[a-z_]+_(amount|balance|value|deposit))$/;

type CallLike = { pallet: string; method: string; args?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCall = (v: unknown): v is CallLike =>
  isRecord(v) && typeof v.pallet === "string" && typeof v.method === "string" && Object.keys(v).every((k) => k === "pallet" || k === "method" || k === "args");

/** A call: its name, then its arguments one per line. */
export function CallView({ pallet, method, args }: CallLike) {
  const entries = isRecord(args) ? Object.entries(args) : [];
  return (
    <div class="x-call">
      <p class="x-call-name">
        {pallet}.{method}
      </p>
      {entries.length > 0 ? <Fields value={args as Record<string, unknown>} /> : <p class="x-quiet">No arguments</p>}
    </div>
  );
}

function Fields({ value }: { value: Record<string, unknown> }) {
  return (
    <dl class="x-args">
      {Object.entries(value).map(([key, v]) => (
        <div class="x-arg" key={key}>
          <dt>{key}</dt>
          <dd>
            <Value value={v} name={key} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One decoded value; `name` is the field it sits in, which tells an amount from a plain number. */
export function Value({ value, name }: { value: unknown; name?: string }) {
  if (value === null || value === undefined) return <span class="x-quiet">None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span class="x-num">{name !== undefined && AMOUNT.test(name) ? formatIdt(String(value)) : formatNumber(value)}</span>;
  if (typeof value === "string") {
    if (isAddress(value)) return <AccountLink address={value} />;
    if (name !== undefined && AMOUNT.test(name) && /^\d+$/.test(value)) return <span class="x-num">{formatIdt(value)}</span>;
    return <span class="x-text">{value === "" ? <span class="x-quiet">Empty</span> : value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span class="x-quiet">Empty list</span>;
    return (
      <ol class="x-list">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} name={name} />
          </li>
        ))}
      </ol>
    );
  }
  if (isCall(value)) return <CallView {...value} />;
  if (isRecord(value)) return Object.keys(value).length === 0 ? <span class="x-quiet">Empty</span> : <Fields value={value} />;
  return <span class="x-text">{String(value)}</span>;
}
