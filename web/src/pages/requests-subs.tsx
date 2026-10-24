// Sub-accounts: accounts linked to an identity with the consent of both. A parent proposes, the
// other account accepts or declines from its own wallet; either side can end the link, and the
// parent can rename it. One level only: a sub-account has no sub-accounts of its own.
//
// Everything listed is read from the chain. A proposal that cannot be accepted any more is still
// listed (the parent or the other account withdraws it), and the chain says why in a sentence if an
// accept fails.

import type { ComponentProps } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { acceptSubCall, addSubCall, declineSubCall, quitSubCall, removeSubCall, renameSubCall } from "../chain/calls.ts";
import { LIMITS } from "../chain/edit.ts";
import type { Member } from "../chain/identity.ts";
import type { Overview } from "../chain/overview.ts";
import { shorten } from "../chain/short.ts";
import { subAddressProblem, subLabelProblem } from "../chain/subs.ts";
import { profilePath } from "../routes.ts";
import { ConfirmButton } from "../ui/confirm.tsx";
import { IconButton, PencilIcon, TrashIcon, XIcon } from "../ui/icons.tsx";
import { useProfileLinks } from "./profile.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";

const titleOf = (member: Member): string => member.label || shorten(member.address);

/** Put focus back on a row's button once the row is drawn again (after a rename is closed). */
const focusLater = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
const renameId = (address: string) => `rename-${address}`;

/** An input that takes focus when it appears (the label being renamed), and only then. */
function FocusedInput(props: ComponentProps<"input">) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return <input ref={input} {...props} />;
}

export function SubsSection({ overview, acting, address }: { overview: Overview; acting: Acting; address: string }) {
  const { profile, parent, subs, proposed, received } = overview;
  const [renaming, setRenaming] = useState<{ address: string; label: string } | null>(null);
  const [proposal, setProposal] = useState({ address: "", label: "" });

  const listed = [...subs, ...proposed];
  const full = listed.length >= LIMITS.subs;
  const addressProblem = subAddressProblem(proposal.address, address, listed.map((m) => m.address));
  const labelProblem = subLabelProblem(proposal.label);
  const canPropose = proposal.address.trim() !== "" && addressProblem === null && labelProblem === null && !full;
  // the chain refuses an accept from an account that has a parent or sub-accounts of its own
  const canAccept = parent === null && subs.length === 0;

  const touch = () => acting.touch("subs");
  const named = useProfileLinks([...(parent ? [parent.address] : []), ...received.map((m) => m.address), ...subs.map((m) => m.address), ...proposed.map((m) => m.address)]);
  const closeRename = (sub: string) => {
    setRenaming(null);
    focusLater(renameId(sub));
  };

  async function propose() {
    if (!canPropose) return;
    if (await acting.run("subs", () => addSubCall(proposal.address, proposal.label), "Proposal sent.")) {
      setProposal({ address: "", label: "" });
    }
  }

  async function rename() {
    if (!renaming) return;
    const problem = subLabelProblem(renaming.label);
    if (problem !== null) return;
    if (await acting.run("subs", () => renameSubCall(renaming.address, renaming.label), "Label changed.")) closeRename(renaming.address);
  }

  return (
    <section class="block" aria-label="Sub-accounts">
      <h2 class="section">Sub-accounts</h2>

      {parent && (
        <>
          <p class="member">
            Sub-account of <a href={named.get(parent.address)?.path ?? profilePath(null, parent.address)}>{named.get(parent.address)?.title ?? shorten(parent.address)}</a>
            {parent.label ? `, listed as ${parent.label}` : ""}.
          </p>
          <div class="actions">
            <ConfirmButton
              label="Leave"
              describe="Leave your parent account"
              ask={`Leave ${named.get(parent.address)?.title ?? shorten(parent.address)}? It would have to propose you again.`}
              confirm="Leave"
              disabled={acting.pending}
              onOpen={touch}
              onConfirm={() => void acting.run("subs", quitSubCall, "You left the account.")}
            />
          </div>
        </>
      )}

      {received.length > 0 && (
        <>
          <span class="label">Proposals to you</span>
          {!canAccept && (
            <p class="hint">
              {parent ? "You already belong to a parent. Leave it to accept another proposal." : "An account with sub-accounts cannot become one."}
            </p>
          )}
          <ul class="items" aria-label="Proposals to you">
            {received.map((from) => {
              const who = named.get(from.address);
              const proposer = who?.title ?? shorten(from.address);
              return (
                <li class="item" key={from.address}>
                  <div class="item-text">
                    <span class="link-title">
                      From <a href={who?.path ?? profilePath(null, from.address)} title={from.address}>{proposer}</a>
                    </span>
                    <span class="link-url">
                      {who ? `${shorten(from.address)}, ` : ""}
                      {from.label ? `would list you as ${from.label}` : "a proposal to join as a sub-account"}
                    </span>
                  </div>
                  <div class="item-actions">
                    <button
                      class="button small"
                      type="button"
                      aria-label={`Accept the proposal from ${proposer}`}
                      disabled={acting.pending || !canAccept}
                      onClick={() => void acting.run("subs", () => acceptSubCall(from.address), "Proposal accepted.")}
                    >
                      Accept
                    </button>
                    <button
                      class="quiet"
                      type="button"
                      aria-label={`Decline the proposal from ${proposer}`}
                      disabled={acting.pending}
                      onClick={() => void acting.run("subs", () => declineSubCall(from.address), "Proposal declined.")}
                    >
                      Decline
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {listed.length > 0 && (
        <>
          <ul class="items" aria-label="Your sub-accounts">
            {listed.map((sub) => {
              const accepted = subs.includes(sub);
              const editing = renaming?.address === sub.address;
              return (
                <li class="item" key={sub.address}>
                  {editing ? (
                    <div class="item-edit">
                      <FocusedInput
                        class="input"
                        type="text"
                        aria-label={`Label of ${titleOf(sub)}`}
                        placeholder="Label"
                        autocomplete="off"
                        value={renaming.label}
                        aria-invalid={subLabelProblem(renaming.label) !== null || undefined}
                        onInput={(e) => {
                          touch();
                          setRenaming({ address: sub.address, label: e.currentTarget.value });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void rename();
                          if (e.key === "Escape") closeRename(sub.address);
                        }}
                      />
                      {subLabelProblem(renaming.label) && <p class="problem note-row">{subLabelProblem(renaming.label)}</p>}
                      <div class="actions note-row">
                        <button
                          class="button primary"
                          type="button"
                          disabled={acting.pending || subLabelProblem(renaming.label) !== null || renaming.label.trim() === sub.label}
                          onClick={() => void rename()}
                        >
                          Save
                        </button>
                        <button class="button" type="button" disabled={acting.pending} onClick={() => closeRename(sub.address)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div class="item-text">
                        {sub.label || named.get(sub.address) ? (
                          <span class="link-title">{sub.label || named.get(sub.address)!.title}</span>
                        ) : (
                          // nothing but the address to show: it is the title, and the link
                          <span class="link-title">
                            <a href={profilePath(null, sub.address)} title={sub.address}>
                              {shorten(sub.address)}
                            </a>
                          </span>
                        )}
                        <span class="item-meta">
                          {(sub.label || named.get(sub.address)) && (
                            <a class="link-url" href={named.get(sub.address)?.path ?? profilePath(null, sub.address)} title={sub.address}>
                              {sub.label && named.get(sub.address) ? named.get(sub.address)!.title : shorten(sub.address)}
                            </a>
                          )}
                          <span class={accepted ? "state" : "state off"}>{accepted ? "Accepted" : "Waiting"}</span>
                        </span>
                      </div>
                      <div class="item-actions">
                        <IconButton
                          id={renameId(sub.address)}
                          label={`Rename ${titleOf(sub)}`}
                          disabled={acting.pending}
                          onClick={() => {
                            touch();
                            setRenaming({ address: sub.address, label: sub.label });
                          }}
                        >
                          <PencilIcon />
                        </IconButton>
                        {accepted ? (
                          // ending an accepted link takes the other account's consent again to undo: ask first
                          <ConfirmButton
                            icon={<TrashIcon />}
                            label="Remove"
                            describe={`Remove ${titleOf(sub)}`}
                            ask={`Remove ${titleOf(sub)}? It stops being your sub-account, and joining again needs a new proposal it accepts.`}
                            confirm="Remove"
                            disabled={acting.pending}
                            onOpen={touch}
                            onConfirm={() => void acting.run("subs", () => removeSubCall(sub.address), "Sub-account removed.")}
                          />
                        ) : (
                          <IconButton
                            label={`Withdraw the proposal to ${titleOf(sub)}`}
                            disabled={acting.pending}
                            onClick={() => void acting.run("subs", () => removeSubCall(sub.address), "Proposal withdrawn.")}
                          >
                            <XIcon />
                          </IconButton>
                        )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {profile === null && parent === null && received.length === 0 && <p class="hint">Nobody has asked this account to join them.</p>}
      {profile !== null && parent !== null && <p class="hint">A sub-account cannot have sub-accounts.</p>}
      {profile !== null && parent === null && full && <p class="hint">You have reached the limit of {LIMITS.subs} sub-accounts.</p>}
      {profile !== null && parent === null && !full && (
        <form
          class="add propose"
          onSubmit={(e) => {
            e.preventDefault();
            void propose();
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
            value={proposal.address}
            aria-invalid={addressProblem !== null || undefined}
            onInput={(e) => {
              touch();
              setProposal({ ...proposal, address: e.currentTarget.value });
            }}
          />
          <input
            class="input"
            type="text"
            aria-label="Label"
            placeholder="Label (optional)"
            autocomplete="off"
            value={proposal.label}
            aria-invalid={labelProblem !== null || undefined}
            onInput={(e) => {
              touch();
              setProposal({ ...proposal, label: e.currentTarget.value });
            }}
          />
          <button class="button" type="submit" disabled={acting.pending || !canPropose}>
            Propose
          </button>
          {addressProblem && <p class="problem note-row">{addressProblem}</p>}
          {labelProblem && <p class="problem note-row">{labelProblem}</p>}
          <p class="hint note-row">The other account accepts from its own Requests page. It needs no identity.</p>
        </form>
      )}
      <StatusLine acting={acting} section="subs" />
    </section>
  );
}
