// One account, looked up by address: the facts the authority recorded about the person (identity
// document, fraud), the verifications it gave, and the username. Each action shows only if the
// agent holds the capability for it; the chain judges each call.
//
// Facts outlive an identity (a person found fraudulent cannot erase it by starting over), so they
// are read and can be revoked even when the account has no identity now; recording one needs an
// identity.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { isAddress, sameAccount } from "../chain/address.ts";
import { grantFactCall, type Reason, revokeAttestationCall, revokeFactCall, setUsernameForCall, unbindUsernameCall } from "../chain/calls.ts";
import { LIMITS } from "../chain/edit.ts";
import { type Attestation, FIELD_LABELS, type Profile, refId } from "../chain/identity.ts";
import { type Account, FACT_KINDS, type FactKind, type FactState } from "../chain/inbox.ts";
import { shorten } from "../chain/short.ts";
import { profilePath } from "../routes.ts";
import { ConfirmButton } from "../ui/confirm.tsx";
import { ReasonSelect } from "./authority-inbox.tsx";
import type { Desk } from "./authority-page.tsx";
import { headline } from "./profile.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";
import { nameLine, useNameCheck } from "./requests-name.tsx";

const FACT_LABELS: Record<FactKind, string> = { DocumentChecked: "Identity document", Fraud: "Fraud" };

function factText(fact: FactState | null): string {
  if (fact === null) return "Not recorded";
  return fact.state === "active" ? "Recorded" : fact.state === "revoked" ? "Revoked" : "Expired";
}

/** What the person sees an attestation about: the field's label, the link's title. */
function attestedLabel(profile: Profile, att: Attestation): string {
  const ref = att.ref;
  if ("link" in ref) return profile.links.find((l) => l.id === ref.link)?.title ?? `Link ${ref.link}`;
  return profile.fields.find((f) => f.id === refId(ref))?.label ?? ("typed" in ref ? FIELD_LABELS[ref.typed] : ref.custom);
}

export function AccountSection({
  desk,
  lookedUp,
  lookUp,
  acting,
}: {
  desk: Desk;
  lookedUp: string | null;
  lookUp(account: string | null): Promise<boolean>;
  acting: Acting;
}) {
  const [typed, setTyped] = useState(lookedUp ?? "");
  const [reason, setReason] = useState<Reason>("Unspecified");
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  const trimmed = typed.trim();
  const addressProblem = trimmed !== "" && !isAddress(trimmed) ? "That is not a valid account address." : null;
  // the panel is for the address in the box: retyping it hides the panel until Look up, so nothing is
  // recorded on the account looked up before
  const showing = lookedUp !== null && addressProblem === null && trimmed !== "" && sameAccount(trimmed, lookedUp);
  const account = showing && desk.account !== null && sameAccount(desk.account.address, lookedUp) ? desk.account : null;
  const noteTooLong = new TextEncoder().encode(note.trim()).length > LIMITS.note;

  return (
    <section class="block" aria-label="Accounts" id="accounts">
      <h2 class="section">Accounts</h2>
      <form
        class="claim"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed !== "" && addressProblem === null) {
            setFailed(false);
            void lookUp(trimmed).then((ok) => setFailed(!ok));
          }
        }}
      >
        <input
          class="input"
          type="text"
          aria-label="Account address"
          placeholder="Account address"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={typed}
          aria-invalid={addressProblem !== null || undefined}
          onInput={(e) => {
            acting.touch("account");
            setFailed(false);
            setTyped(e.currentTarget.value);
          }}
        />
        <button class="button" type="submit" disabled={trimmed === "" || addressProblem !== null}>
          Look up
        </button>
      </form>
      {addressProblem && <p class="problem">{addressProblem}</p>}
      {lookedUp !== null && !showing && trimmed !== "" && addressProblem === null && !failed && (
        <p class="hint">Press Look up to see this account.</p>
      )}
      {failed && (
        <p class="problem" role="alert">
          Could not read that account. Check the connection and look it up again.
        </p>
      )}
      {account && (
        <AccountView desk={desk} account={account} acting={acting} reason={reason} note={note.trim()} noteTooLong={noteTooLong}>
          <div class={desk.agent.facts ? "reason-row" : "reason-row single"}>
            <ReasonSelect id="account-reason" value={reason} onChange={setReason} />
            {desk.agent.facts && (
              <input
                class="input"
                type="text"
                aria-label="Note"
                placeholder="Note on a fact (optional)"
                autocomplete="off"
                value={note}
                aria-invalid={noteTooLong || undefined}
                onInput={(e) => setNote(e.currentTarget.value)}
              />
            )}
            <p class="hint note-row">The reason goes with what you record, revoke or take away below.</p>
            {noteTooLong && <p class="problem note-row">A note has at most {LIMITS.note} bytes.</p>}
          </div>
        </AccountView>
      )}
      <StatusLine acting={acting} section="account" />
    </section>
  );
}

/** `children`: the reason (and note) to go with an action, shown before the actions. */
function AccountView({
  desk,
  account,
  acting,
  reason,
  note,
  noteTooLong,
  children,
}: {
  desk: Desk;
  account: Account;
  acting: Acting;
  reason: Reason;
  note: string;
  noteTooLong: boolean;
  children: ComponentChildren;
}) {
  const { agent } = desk;
  const { profile, address } = account;
  const title = profile ? headline(profile).title : shorten(address);
  const mine = (profile?.attestations ?? []).filter((a) => a.authority === agent.authority.id && a.revoked === null);

  return (
    <>
      <p class="member">
        <a href={profilePath(profile?.name ?? null, address)} title={address}>
          {title}
        </a>
        {profile === null && ": no identity."}
      </p>
      {children}

      {agent.facts && (
        <ul class="asks" aria-label="Facts">
          {FACT_KINDS.map((kind) => {
            const fact = account.facts[kind];
            const active = fact?.state === "active";
            return (
              <li class="ask" key={kind}>
                <div class="ask-text">
                  <span class="ask-label">{FACT_LABELS[kind]}</span>
                  <span class="ask-value">{factText(fact)}</span>
                </div>
                <div class="ask-side">
                  {active ? (
                    <ConfirmButton
                      quiet
                      label="Revoke"
                      describe={`Revoke ${FACT_LABELS[kind]} of ${title}`}
                      ask={`Revoke the ${FACT_LABELS[kind].toLowerCase()} recorded about ${title}? ${kind === "Fraud" ? "The finding stops counting against them." : "Their level no longer counts it."}`}
                      confirm="Revoke"
                      disabled={acting.pending}
                      onOpen={() => acting.touch("account")}
                      onConfirm={() => void acting.run("account", () => revokeFactCall(address, kind, reason), `${FACT_LABELS[kind]} revoked.`)}
                    />
                  ) : kind === "DocumentChecked" ? (
                    <button
                      class="button small"
                      type="button"
                      aria-label={`Record the identity document of ${title}`}
                      disabled={acting.pending || profile === null || noteTooLong}
                      onClick={() => void acting.run("account", () => grantFactCall(address, kind, reason, note), "Identity document recorded.")}
                    >
                      Document checked
                    </button>
                  ) : (
                    <ConfirmButton
                      label="Record fraud"
                      describe={`Record fraud for ${title}`}
                      ask={`Record a fraud finding about ${title}? Their level becomes Fraudulent, and they cannot claim a username while it stands.`}
                      confirm="Record fraud"
                      disabled={acting.pending || profile === null || noteTooLong}
                      onOpen={() => acting.touch("account")}
                      onConfirm={() => void acting.run("account", () => grantFactCall(address, kind, reason, note), "Fraud recorded.")}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {agent.attest && profile !== null && (
        <>
          {mine.length === 0 && <p class="hint">Nothing on this identity was verified by {agent.authority.name}.</p>}
          {mine.length > 0 && (
            <ul class="asks" aria-label="Verifications">
              {mine.map((att) => {
                const label = attestedLabel(profile, att);
                return (
                  <li class="ask" key={refId(att.ref)}>
                    <div class="ask-text">
                      <span class="ask-label">{label}</span>
                      <span class="ask-value">
                        {att.verdict} by {agent.authority.name}
                        {att.valid ? "" : ", no longer valid"}
                      </span>
                    </div>
                    <div class="ask-side">
                      <ConfirmButton
                        quiet
                        label="Revoke"
                        describe={`Revoke the ${att.verdict === "Verified" ? "verification" : "rejection"} of ${label}`}
                        ask={`Revoke the ${att.verdict === "Verified" ? "verification" : "rejection"} of ${label}? It stops counting, and only a new verdict restores it.`}
                        confirm="Revoke"
                        disabled={acting.pending}
                        onOpen={() => acting.touch("account")}
                        onConfirm={() => void acting.run("account", () => revokeAttestationCall(address, att.ref, reason), att.verdict === "Verified" ? "Verification revoked." : "Rejection revoked.")}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {agent.names && profile !== null && <UsernameRow desk={desk} profile={profile} address={address} title={title} acting={acting} reason={reason} />}
    </>
  );
}

/** The account's username: take it away, or give it one. */
function UsernameRow({ desk, profile, address, title, acting, reason }: { desk: Desk; profile: Profile; address: string; title: string; acting: Acting; reason: Reason }) {
  const [typed, setTyped] = useState("");
  const name = typed.trim().toLowerCase();
  const check = useNameCheck(name, acting.epoch);
  const line = nameLine(check, name, desk.clock);
  // a reserved name can be given (that is what a reservation is for), a taken or quarantined one cannot
  const known = check.state === "known" ? check.status.state : null;
  const givable = known === "available" || known === "reserved";

  if (profile.name) {
    const current = profile.name;
    return (
      <div class="actions">
        <p class="member">
          Username <a href={profilePath(current, address)}>{current}</a>
        </p>
        <ConfirmButton
          label="Take away"
          describe={`Take the username ${current} away`}
          ask={`Take ${current} away from ${title}? The name goes into quarantine and nobody can claim it for a while.`}
          confirm="Take away"
          disabled={acting.pending}
          onOpen={() => acting.touch("account")}
          onConfirm={() => void acting.run("account", () => unbindUsernameCall(address, reason), "Username taken away.")}
        />
      </div>
    );
  }
  return (
    <>
      <form
        class="claim"
        onSubmit={(e) => {
          e.preventDefault();
          if (givable && !acting.pending) void acting.run("account", () => setUsernameForCall(address, name), `${name} given.`).then((ok) => ok && setTyped(""));
        }}
      >
        <input
          class="input"
          type="text"
          aria-label="Username to give"
          placeholder="Give a username"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={typed}
          aria-invalid={(line?.kind === "problem" && known !== "reserved") || undefined}
          onInput={(e) => {
            acting.touch("account");
            setTyped(e.currentTarget.value);
          }}
        />
        <button class="button" type="submit" disabled={acting.pending || !givable}>
          Give
        </button>
      </form>
      {line && (
        <p class={known === "reserved" ? "status" : line.kind} aria-live="polite">
          {known === "reserved" ? `${name} is reserved: you can give it.` : line.text}
        </p>
      )}
    </>
  );
}
