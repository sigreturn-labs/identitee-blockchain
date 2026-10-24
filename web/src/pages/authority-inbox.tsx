// The requests waiting for the agent's authority. A field or a link gets a verdict, recorded on the
// identity: Verify, or Reject the value (checked and refused: it counts as not verified while the
// person keeps it). A private field gets its verdict once its verification packet checks out. An
// identity document is recorded. Any request can also be dismissed with a reason (`reject_request`):
// nothing is recorded on the identity and the person can ask again, which is what a fact request, a
// request whose field is gone, or spam calls for.
//
// A verdict is for the value the row showed: just before signing, the commitment is read from the
// chain again, and if the field changed since, nothing is signed (the runtime would refuse it as
// stale anyway). A private field is verified only once a pasted packet checks out against the
// chain (chain/inbox.ts, `checkPacket`). The packet holds the person's value and salt: it is kept
// in this component's state only while it is used, never stored, logged or sent, and dropped as
// soon as it has been checked or the verdict sent.

import { useState } from "preact/hooks";
import { grantFactCall, provideJudgementCall, REASONS, type Reason, rejectRequestCall, type Verdict } from "../chain/calls.ts";
import { LIMITS } from "../chain/edit.ts";
import type { FieldRef } from "../chain/identity.ts";
import { type CheckedPacket, checkPacket, commitmentNow, genesisHash, type InboxItem, profileNow } from "../chain/inbox.ts";
import { Refusal } from "../chain/refusal.ts";
import { shorten } from "../chain/short.ts";
import { profilePath } from "../routes.ts";
import type { Desk } from "./authority-page.tsx";
import { headline } from "./profile.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";

type Panel = { id: string; kind: "packet" | "refuse" | "dismiss" };

/** What each verdict is called, and what the page says once it is in a block. */
const VERDICT_DONE: Record<Verdict, string> = { Verified: "verified", Rejected: "rejected" };

/** Who asked, as a link to their profile: the name, and the shortened address, since two people can
 * give themselves the same name. */
function Requester({ item, count }: { item: InboxItem; count: number }) {
  const head = item.profile ? headline(item.profile) : null;
  const short = shorten(item.who);
  return (
    <h3 class="inbox-who">
      <a href={profilePath(item.profile?.name ?? null, item.who)} title={item.who}>
        {head && !head.titleIsAddress ? head.title : short}
      </a>
      {head && !head.titleIsAddress && <span class="addr">{short}</span>}
      <span class="addr">{count === 1 ? "1 request" : `${count} requests`}</span>
    </h3>
  );
}

/** The person, as the buttons name them: the name and the short address, since two people can give
 * themselves the same name. */
const personOf = (item: InboxItem): string => {
  const head = item.profile ? headline(item.profile) : null;
  return head && !head.titleIsAddress ? `${head.title} (${shorten(item.who)})` : shorten(item.who);
};

/** The requests, one group per person, the groups in the order of their oldest request. */
function groupsOf(items: readonly InboxItem[]): InboxItem[][] {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) groups.set(item.who, [...(groups.get(item.who) ?? []), item]);
  return [...groups.values()];
}

/** The question before a value is rejected: what it records, unlike a dismissal. */
const REFUSE_ASK = (label: string): string =>
  `Record on the identity that this ${label} was checked and refused? It counts as not verified while the person keeps this value.`;

/** The one question before a value is rejected, the same for a field, a link and a checked packet:
 * what the verdict records, then Reject the value or Cancel. */
function RefuseQuestion({ item, pending, onReject, onCancel }: { item: InboxItem; pending: boolean; onReject(): void; onCancel(): void }) {
  return (
    <div class="confirm" role="group" aria-label={`Reject the value of ${item.label}`}>
      <p class="hint">{REFUSE_ASK(item.label)}</p>
      <div class="actions">
        <button class="button primary" type="button" disabled={pending} onClick={onReject}>
          Reject the value
        </button>
        <button class="button" type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Whether the agent can act on this request at all: fields need the attest capability, facts the
 * person facts one. */
const canAct = (item: InboxItem, desk: Desk): boolean => ("fact" in item.target ? desk.agent.facts : desk.agent.attest);

/** `reload`: read the page again, when a verdict was not signed because the field changed: the row
 * then shows what the field holds now. */
export function InboxSection({ desk, items, acting, reload }: { desk: Desk; items: InboxItem[]; acting: Acting; reload(): Promise<boolean> }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const shown = items.filter((item) => canAct(item, desk));
  // the row of the last action, once it is no longer listed (verified, rejected, dismissed)
  const lastRow = acting.status?.section === "inbox" ? acting.status.row : undefined;
  const answered = lastRow !== undefined && !shown.some((item) => item.id === lastRow) ? lastRow : null;
  // the button pressed goes away with the panel it opens: focus moves into the panel, and back to
  // the row's first button when it closes, so the keyboard (and Escape) stays on the row
  const inRow = (id: string, selector: string) => () =>
    (document.querySelector(`li[data-row="${CSS.escape(id)}"] ${selector}`) as HTMLElement | null)?.focus();
  const open = (id: string, kind: Panel["kind"]) => {
    acting.touch("inbox");
    setPanel({ id, kind });
    requestAnimationFrame(inRow(id, ".panel :is(select, textarea, input, button)"));
  };
  const close = () => {
    const was = panel;
    setPanel(null);
    if (was) requestAnimationFrame(inRow(was.id, ".ask-side button"));
  };

  /** Record `verdict` on the value the row showed, read again from the chain at this moment. */
  async function judge(item: InboxItem, ref: FieldRef | { link: number }, verdict: Verdict): Promise<boolean> {
    let changed = false;
    const done = await acting.run(
      "inbox",
      async () => {
        const now = await commitmentNow(item.who, ref);
        if (now === null) throw new Refusal("That field is no longer on the identity.");
        if (now.commitment !== item.commitment) {
          changed = true;
          throw new Refusal("The field changed since the page was read. Look at it again.");
        }
        return provideJudgementCall(item.who, ref, now.commitment, verdict);
      },
      `${item.label} ${VERDICT_DONE[verdict]}.`,
      undefined,
      item.id,
    );
    if (changed) await reload();
    return done;
  }

  return (
    <section class="block" aria-label="Requests" id="requests">
      <h2 class="section">Requests</h2>
      {shown.length === 0 && <p class="hint">No request is waiting.</p>}
      {shown.length > 0 && (
        <p class="hint">
          {shown.length === 1 ? "1 request" : `${shown.length} requests`} from {groupsOf(shown).length === 1 ? "1 person" : `${groupsOf(shown).length} people`}
        </p>
      )}
      {/* a request just answered is gone from its group: its result shows under the group's name, or
          here at the top when the person has nothing left waiting */}
      {(answered === null || !groupsOf(shown).some((group) => answered.startsWith(`${group[0]!.who}|`))) && (
        <StatusLine acting={acting} section="inbox" rows={shown.map((item) => item.id)} />
      )}
      {groupsOf(shown).map((group) => (
        <div class="inbox-group" key={group[0]!.who}>
          <Requester item={group[0]!} count={group.length} />
          {answered?.startsWith(`${group[0]!.who}|`) && <StatusLine acting={acting} section="inbox" row={answered} />}
          <ul class="asks inbox" aria-label={`Requests from ${personOf(group[0]!)}`}>
            {group.map((item) => {
              const person = personOf(item);
              const label = `${item.label} of ${person}`;
              const ref = "field" in item.target ? item.target.field : null;
              const opened = panel?.id === item.id ? panel.kind : null;
              return (
                <li
                  class="ask"
                  key={item.id}
                  data-row={item.id}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && opened !== null && !acting.pending) {
                      e.stopPropagation();
                      close();
                    }
                  }}
                >
                  <div class="ask-text">
                    <span class="ask-label">{item.label}</span>
                    {item.kind === "private" && <span class="ask-value private">Private</span>}
                    {item.value !== null && <span class="ask-value">{item.value}</span>}
                    {item.kind === "gone" && <span class="ask-value">No longer on the identity.</span>}
                  </div>
                  {opened === null && (
                    <div class="ask-side">
                      {ref !== null && (item.kind === "public" || item.kind === "link") && (
                        <>
                          <button class="button small" type="button" aria-label={`Verify ${label}`} disabled={acting.pending} onClick={() => void judge(item, ref, "Verified")}>
                            Verify
                          </button>
                          <button class="quiet" type="button" aria-label={`Reject the value of ${label}`} disabled={acting.pending} onClick={() => open(item.id, "refuse")}>
                            Reject the value
                          </button>
                        </>
                      )}
                      {item.kind === "private" && (
                        <button class="button small" type="button" aria-label={`Check the packet for ${label}`} disabled={acting.pending} onClick={() => open(item.id, "packet")}>
                          Check packet
                        </button>
                      )}
                      {item.kind === "document" && (
                        <button
                          class="button small"
                          type="button"
                          aria-label={`Record the identity document of ${person}`}
                          disabled={acting.pending}
                          onClick={() => void acting.run("inbox", () => grantFactCall(item.who, "DocumentChecked", "Unspecified", ""), "Identity document recorded.", undefined, item.id)}
                        >
                          Document checked
                        </button>
                      )}
                      <button class="quiet" type="button" aria-label={`Dismiss the request for ${label}`} disabled={acting.pending} onClick={() => open(item.id, "dismiss")}>
                        Dismiss request
                      </button>
                    </div>
                  )}
                  {opened === "packet" && ref !== null && !("link" in ref) && <PacketPanel item={item} fieldRef={ref} acting={acting} onClose={close} />}
                  {opened === "refuse" && ref !== null && (
                    <div class="panel ask-note">
                      <RefuseQuestion item={item} pending={acting.pending} onReject={() => void judge(item, ref, "Rejected").then((ok) => ok && close())} onCancel={close} />
                    </div>
                  )}
                  {opened === "dismiss" && <DismissPanel item={item} acting={acting} onClose={close} />}
                  <div class="ask-note">
                    <StatusLine acting={acting} section="inbox" row={item.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Paste the packet, check it against the chain, then verify. */
function PacketPanel({ item, fieldRef, acting, onClose }: { item: InboxItem; fieldRef: FieldRef; acting: Acting; onClose(): void }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedPacket | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = `packet-${item.id}`;

  async function check() {
    const pasted = text;
    // the pasted text is not kept: what is needed of it is the outcome of the check
    setText("");
    setBusy(true);
    try {
      const [profile, genesis] = await Promise.all([profileNow(item.who), genesisHash()]);
      const result = await checkPacket(pasted, item.who, fieldRef, genesis, profile);
      if ("problem" in result) setProblem(result.problem);
      else setChecked(result);
    } catch {
      setProblem("Cannot reach the identit.ee network.");
    } finally {
      setBusy(false);
    }
  }

  async function judge(verdict: Verdict) {
    if (!checked) return;
    const expected = checked.commitment;
    // the value is dropped before anything is sent: the call carries the commitment alone
    setChecked(null);
    setRefusing(false);
    const done = await acting.run(
      "inbox",
      async () => {
        const now = await commitmentNow(item.who, fieldRef);
        if (now?.commitment !== expected) throw new Refusal("The field changed since the packet was checked.");
        return provideJudgementCall(item.who, fieldRef, expected, verdict);
      },
      `${item.label} ${VERDICT_DONE[verdict]}.`,
      undefined,
      item.id,
    );
    if (done) onClose();
    // the packet is gone with nothing recorded (cancelled in the wallet, refused): it must come again
    else setProblem("Nothing was recorded. Paste the packet again to give a verdict.");
  }

  if (checked) {
    return (
      <div class="panel ask-note" role="group" aria-label={`Packet for ${item.label}`}>
        <p class="member">
          {item.label}: <span class="packet-value">{checked.value}</span>
        </p>
        {refusing ? (
          <RefuseQuestion item={item} pending={acting.pending} onReject={() => void judge("Rejected")} onCancel={() => setRefusing(false)} />
        ) : (
          <>
            <p class="hint">The packet is signed by the account that asked, and gives the commitment the chain holds for this field now. Check the value itself, then give a verdict.</p>
            <div class="actions">
              <button class="button primary" type="button" disabled={acting.pending} onClick={() => void judge("Verified")}>
                Verify
              </button>
              <button class="button" type="button" aria-label={`Reject the value of ${item.label}`} disabled={acting.pending} onClick={() => setRefusing(true)}>
                Reject the value
              </button>
              <button class="button" type="button" disabled={acting.pending} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div class="panel ask-note" role="group" aria-label={`Packet for ${item.label}`}>
      <label class="label" for={id}>
        Verification packet
      </label>
      <textarea
        id={id}
        class="input packet"
        rows={6}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={text}
        aria-invalid={problem !== null || undefined}
        onInput={(e) => {
          setProblem(null);
          setText(e.currentTarget.value);
        }}
      />
      <p class="hint">Paste the packet the person sent. It is checked here and kept nowhere.</p>
      {problem && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="actions">
        <button class="button primary" type="button" disabled={busy || acting.pending || text.trim() === ""} onClick={() => void check()}>
          Check
        </button>
        <button class="button" type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A reason and a short note, then the request is dismissed: nothing is recorded on the identity. */
function DismissPanel({ item, acting, onClose }: { item: InboxItem; acting: Acting; onClose(): void }) {
  const [reason, setReason] = useState<Reason>("Unspecified");
  const [note, setNote] = useState("");
  const tooLong = new TextEncoder().encode(note.trim()).length > LIMITS.note;
  const id = `dismiss-${item.id}`;

  async function dismiss() {
    if (tooLong) return;
    if (await acting.run("inbox", () => rejectRequestCall(item.who, item.target, reason, note), "Request dismissed.", undefined, item.id)) onClose();
  }

  return (
    <div class="panel ask-note" role="group" aria-label={`Dismiss the request for ${item.label}`}>
      <p class="hint">Dismissing records nothing on the identity, and the person can ask again. The reason and the note stay in the chain's history; this site does not show them to the person.</p>
      <ReasonSelect id={`${id}-reason`} value={reason} onChange={setReason} />
      <input
        id={`${id}-note`}
        class="input"
        type="text"
        aria-label="Note"
        placeholder="Note (optional)"
        autocomplete="off"
        value={note}
        aria-invalid={tooLong || undefined}
        onInput={(e) => setNote(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing && !acting.pending) {
            e.preventDefault();
            void dismiss();
          }
        }}
      />
      {tooLong && <p class="problem">A note has at most {LIMITS.note} bytes.</p>}
      <div class="actions">
        <button class="button primary" type="button" disabled={acting.pending || tooLong} onClick={() => void dismiss()}>
          Dismiss request
        </button>
        <button class="button" type="button" disabled={acting.pending} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The reason of a refusal, a revocation or a fact. */
export function ReasonSelect({ id, value, onChange, label = "Reason" }: { id: string; value: Reason; onChange(reason: Reason): void; label?: string }) {
  return (
    <select id={id} class="input" aria-label={label} value={value} onChange={(e) => onChange(e.currentTarget.value as Reason)}>
      {(Object.keys(REASONS) as Reason[]).map((reason) => (
        <option key={reason} value={reason}>
          {REASONS[reason]}
        </option>
      ))}
    </select>
  );
}
