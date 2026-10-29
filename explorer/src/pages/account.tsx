import { useRoute } from "preact-iso";
import { useState } from "preact/hooks";
import { CopyButton } from "@web/ui/copy.tsx";
import { LEVEL_LABELS, LevelBadge } from "@web/ui/level.tsx";
import { shortAddress } from "../address.ts";
import type { Account as AccountData, HistoryItem, Transfer } from "../api.ts";
import { useApi } from "../data.ts";
import { capabilityLabel, formatIdt, formatNumber } from "../format.ts";
import { AccountLink, Age, isTrust, BlockLink, CallName, ErrorCard, PagedTable, Skeleton, useNow } from "../ui/table.tsx";
import { AccountAvatar } from "../ui/account-avatar.tsx";
import { Row } from "../ui/fields.tsx";
import { EventText } from "./events.tsx";


function Roles({ roles }: { roles: NonNullable<AccountData["roles"]> }) {
  const list = [
    ...(roles.sudo ? ["Sudo"] : []),
    ...(roles.validator ? ["Validator"] : []),
    ...roles.agent.map((a) => `Agent of ${a.name ?? `authority #${a.authority}`}${a.capabilityNames.length ? ` (${a.capabilityNames.map(capabilityLabel).join(", ")})` : ""}`),
  ];
  if (list.length === 0) return <span class="x-quiet">None</span>;
  return (
    <ul class="x-roles">
      {list.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

const TABS = ["History", "Transfers"] as const;

export function Account() {
  const { params, query } = useRoute();
  const address = params.address ?? "";
  const fromHash = query.from === "hash";
  const { data, error, reload } = useApi<AccountData>(`/api/account/${encodeURIComponent(address)}`);
  const [tab, setTab] = useState<(typeof TABS)[number]>("History");
  const now = useNow();

  if (error) {
    return (
      <section class="x-page">
        <h1>Account</h1>
        <ErrorCard error={error} notFound="This is not an identitee address." retry={reload} />
      </section>
    );
  }
  if (data === null) {
    return (
      <section class="x-page">
        <h1>Account</h1>
        <Skeleton rows={6} />
      </section>
    );
  }
  const identity = data.identity;
  const trust = identity && isTrust(identity.trust) ? identity.trust : null;
  const base = `/api/account/${encodeURIComponent(data.address)}`;
  return (
    <section class="x-page">
      <div class="x-account-head">
        <AccountAvatar address={data.address} publicKey={data.publicKey} version={identity?.avatar} size={56} />
        <div>
          <div class="title-line">
            <h1>{identity?.display ?? shortAddress(data.address)}</h1>
            {trust && <LevelBadge trust={trust} />}
          </div>
          {trust && <span class="level">{LEVEL_LABELS[trust]}</span>}
          <div class="addr-line">
            <span class="addr">{data.address}</span>
            <CopyButton text={data.address} what="address" />
          </div>
        </div>
      </div>
      {data.node === "down" && <p class="note">The node is not answering: balance, identity and roles are not shown for now.</p>}
      <dl class="fields x-fields">
        {identity?.username && <Row label="Username">@{identity.username}</Row>}
        {data.balance && (
          <>
            <Row label="Free">{formatIdt(data.balance.free)}</Row>
            <Row label="Reserved">{formatIdt(data.balance.reserved)}</Row>
            <Row label="Frozen">{formatIdt(data.balance.frozen)}</Row>
          </>
        )}
        {data.nonce !== null && <Row label="Nonce">{formatNumber(data.nonce)}</Row>}
        {data.roles && (
          <Row label="Roles">
            <Roles roles={data.roles} />
          </Row>
        )}
        <Row label="Public key">
          <span class="x-hash">{data.publicKey}</span>
        </Row>
      </dl>
      <div class="x-profile">
        <a class="button" href={data.profileUrl}>
          View profile on identit.ee
        </a>
        <p class="hint">identit.ee is in restricted access</p>
      </div>
      <div class="x-tabs" role="tablist" aria-label="Activity">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === "History" ? (
          <PagedTable<HistoryItem>
            key={`h${base}`}
            path={`${base}/history`}
            label="History of the account"
            empty={fromHash ? "No activity yet. If this is a block or extrinsic hash, it may not be indexed yet." : "No activity for this account yet."}
            rowKey={(h) => `${h.kind}-${h.item.id}`}
            columns={[
              { label: "Block", cell: (h) => <BlockLink n={h.block} /> },
              { label: "Age", cell: (h) => <Age ms={h.timestamp} now={now} /> },
              {
                label: "What",
                class: "x-wide",
                cell: (h) =>
                  h.kind === "extrinsic" ? (
                    <a href={`/extrinsic/${h.item.id}`}>
                      <CallName pallet={h.item.pallet} method={h.item.method} inner={h.item.inner} />
                      {!h.item.success && <span class="x-failed"> Failed</span>}
                    </a>
                  ) : (
                    <EventText e={h.item} />
                  ),
              },
            ]}
          />
        ) : (
          <PagedTable<Transfer>
            key={`t${base}`}
            path={`${base}/transfers`}
            label="Transfers of the account"
            empty="No transfers for this account yet."
            rowKey={(t) => t.eventId}
            columns={[
              { label: "Block", cell: (t) => <BlockLink n={t.block} /> },
              { label: "Age", cell: (t) => <Age ms={t.timestamp} now={now} /> },
              { label: "From", cell: (t) => <AccountLink address={t.from} /> },
              { label: "To", cell: (t) => <AccountLink address={t.to} /> },
              { label: "Amount", cell: (t) => formatIdt(t.amount), class: "x-end" },
            ]}
          />
        )}
      </div>
    </section>
  );
}
