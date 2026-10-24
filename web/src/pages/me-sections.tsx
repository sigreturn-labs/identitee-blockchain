// The sections of the editor: bio, fields, links, and the bar that saves them. They draw and change
// the drafts of the profile form (me-form.ts) and send nothing: one Save signs one `update_profile`
// for everything that changed. Revealing a private field and making its verification packet are
// the only actions with their own signature, and they wait until the form is saved or cancelled.

import { useEffect, useRef, useState } from "preact/hooks";
import { type FieldDraft, LIMITS, bioProblem, byteLength, fieldProblem, normalizeUrl } from "../chain/edit.ts";
import type { Profile } from "../chain/identity.ts";
import type { Call } from "../chain/calls.ts";
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, IconButton, LockIcon, LockOpenIcon, PencilIcon, PlusIcon, TrashIcon, UndoIcon } from "../ui/icons.tsx";
import type { WalletModule } from "../ui/lazy-wallet.ts";
import type { ProfileForm } from "./me-form.ts";
import { type IdentitySecret, type PanelKind, PrivatePanel, SecretBlock } from "./me-private.tsx";
import { State, describeUrl } from "./profile.tsx";
import { CHANNEL_OF } from "../chain/verify.ts";
import { LiveRegion, NoticeLine, type Verification, VerifyPanel } from "./me-verify.tsx";

/** What a save was for: the profile form, or one of the actions with their own signature. */
export type Section = "profile" | "fields" | "secret";

export interface Status {
  section: Section;
  state: "saving" | "saved" | "error";
  /** The sentence for an error, or what to say instead of "Saved" when there is more to say. */
  message?: string;
}

/** What a section is given by the page: the state of the one save in flight, and how to make one. */
export interface Saving {
  status: Status | null;
  /** A save is in flight: nothing else can be sent. */
  pending: boolean;
  /** Sign and send the call that `build` makes; resolves `true` once it is in a block and the page
   * has read the identity again. */
  save(section: Section, build: () => Promise<Call>): Promise<boolean>;
  /** The person typed in a section: its last result is no longer news. */
  touch(section: Section): void;
}

/** What happened to the last save of a section, as one quiet line. */
export function StatusLine({ saving, section }: { saving: Saving; section: Section }) {
  const { status } = saving;
  if (!status || status.section !== section) return null;
  if (status.state === "error") {
    return (
      <p class="problem" role="alert">
        {status.message}
      </p>
    );
  }
  return (
    <p class="status" role="status">
      {status.state === "saving" ? "Saving. Confirm in your wallet if it asks." : (status.message ?? "Saved")}
    </p>
  );
}

const ROW_HINT = "This field is verified. Changing it removes the verification.";

// --- Bio --------------------------------------------------------------------------------------

export function BioSection({ form, saving }: { form: ProfileForm; saving: Saving }) {
  const problem = bioProblem(form.bio);
  return (
    <section class="block" aria-label="Bio">
      <label class="label" for="bio">
        Bio
      </label>
      <textarea
        id="bio"
        class="input"
        rows={4}
        value={form.bio}
        aria-invalid={problem !== null || undefined}
        onInput={(e) => {
          saving.touch("profile");
          form.setBio(e.currentTarget.value);
        }}
      />
      <div class="meta">
        <span class="count" title="Bytes: an accent or an emoji counts for more than one">
          {byteLength(form.bio)} / {LIMITS.bio} bytes
        </span>
        <span class="problem">{problem}</span>
      </div>
    </section>
  );
}

// --- Fields -----------------------------------------------------------------------------------

function inputMode(draft: FieldDraft): "email" | "url" | "text" {
  if ("typed" in draft.ref) {
    if (draft.ref.typed === "Email") return "email";
    if (draft.ref.typed === "Web") return "url";
  }
  return "text";
}

const PRIVATE_HINT = "Private: only a fingerprint of the value goes on chain.";
/** Making a public field private: the old value is not erased, and a disclosed salt cannot be reused. */
const WAS_PUBLIC_HINT =
  "Its public value stays in the chain's history, and a field once revealed or sent in a packet should not hold a private value again.";

const refId = (ref: FieldDraft["ref"]): string => ("typed" in ref ? `typed:${ref.typed}` : `custom:${ref.custom}`);

export function FieldsSection({
  profile,
  form,
  saving,
  secret,
  wallet,
  address,
  verification,
}: {
  profile: Profile | null;
  form: ProfileForm;
  saving: Saving;
  secret: IdentitySecret;
  wallet: WalletModule;
  address: string;
  verification: Verification;
}) {
  const live = form.fields;
  const [addProblem, setAddProblem] = useState<string | null>(null);
  // the one private field whose Reveal or Packet is open
  const [panel, setPanel] = useState<{ id: string; kind: PanelKind } | null>(null);
  // the one saved field whose Verify panel is open (never at the same time as Reveal or Packet)
  const [verifying, setVerifying] = useState<string | null>(null);
  // where the focus goes back once the Verify panel closes: its row (when the focus was in the panel)
  const focusBack = useRef<string | null>(null);
  const closeVerify = () => {
    const active = document.activeElement;
    const inPanel = active === null || active === document.body || active.closest(".panel.verify") !== null;
    if (verifying !== null && inPanel) focusBack.current = verifying;
    setVerifying(null);
  };
  useEffect(() => {
    if (verifying !== null || focusBack.current === null) return;
    const id = focusBack.current;
    focusBack.current = null;
    // its Verify button, else (verified, or waiting for a save) the field's label or input
    const target = [document.getElementById(`verify-${id}`), document.getElementById(`label-${id}`)].find(
      (el): el is HTMLElement => el !== null && !(el as HTMLButtonElement).disabled,
    );
    (target ?? document.querySelector<HTMLElement>(`[data-field="${CSS.escape(id)}"] .input`))?.focus();
  }, [verifying]);
  // a Reveal or Packet sent now would read the identity again and wipe the unsaved changes; a
  // verification is for the value on chain, not the one being typed
  useEffect(() => {
    if (form.dirty) {
      setPanel(null);
      closeVerify();
    }
  }, [form.dirty]);
  const enabled = verification.channels?.enabled;
  /** A saved field the service can verify, not verified yet, whose channel is on. */
  const verifiable = (draft: FieldDraft): boolean => {
    if (!("typed" in draft.ref) || draft.original === null || draft.original.verified || draft.removed) return false;
    const channel = CHANNEL_OF[draft.ref.typed];
    return channel !== undefined && (enabled?.has(channel) ?? false);
  };

  const touch = () => saving.touch("profile");
  const patch = (id: string, change: Partial<FieldDraft>) => {
    touch();
    form.setFields((all) => all.map((d) => (d.id === id ? { ...d, ...change } : d)));
  };
  const changes = form.update.fields;
  // a value made private needs the secret before it can be saved; the block that asks for it shows
  // under the open panel if there is one, here otherwise
  const wantsPrivate = live.some((d) => d.private && !d.removed && d.original?.privacy !== "private");
  const locked = secret.secret === null;
  const hasPrivate = wantsPrivate || live.some((d) => d.original?.privacy === "private" && !d.removed);
  const openPanel = panel && live.find((d) => d.id === panel.id && d.original?.privacy === "private" && d.private && !d.removed);
  const openVerify = verifying === null ? undefined : live.find((d) => d.id === verifying && verifiable(d));
  // a Verify panel of a private field asks for the secret itself, as Reveal and Packet do
  const panelAsksSecret = openPanel || (openVerify && openVerify.original?.privacy === "private");
  // locked, with nothing new to make private: a short line and an Unlock, not the whole prompt
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    if (!locked) setUnlocking(false);
  }, [locked]);
  const showSecret = !panelAsksSecret && (locked ? wantsPrivate || unlocking : hasPrivate);
  const showLocked = !panelAsksSecret && locked && !showSecret && hasPrivate && secret.state.phase === "locked";
  const storedPrivate = live.some((d) => d.original?.privacy === "private" && d.private && !d.removed);

  return (
    <section class="block" aria-label="Details">
      <div class="fields-edit">
        {live.map((draft, index) => {
          const id = `field-${index}`;
          const isPrivate = draft.original?.privacy === "private" && draft.private;
          const trouble = fieldProblem(draft, live);
          const verified = draft.original?.verified === true;
          // a field that can be removed carries its button inside the right end of the input
          const removable = draft.original !== null || "custom" in draft.ref;
          const edited = draft.original !== null && changes.some((c) => refId(c.ref) === draft.id);
          const input = !draft.removed && !isPrivate;
          // an empty new row offers no switch until something is typed in it
          const switchable = input && (draft.private || draft.original !== null || draft.text.trim() !== "");
          const actions = (switchable ? 1 : 0) + (removable ? 1 : 0);
          const open = (kind: PanelKind) => {
            touch();
            closeVerify();
            setPanel(panel?.id === draft.id && panel.kind === kind ? null : { id: draft.id, kind });
          };
          const canVerify = verifiable(draft);
          const name = "custom" in draft.ref ? draft.label.charAt(0).toUpperCase() + draft.label.slice(1) : draft.label;
          return (
            <div class="field" key={draft.id} data-field={draft.id}>
              {canVerify ? (
                // where a verified field shows its check, one that can be verified offers Verify
                <div class="label">
                  <label for={id}>{name}</label>
                  <button
                    id={`verify-${draft.id}`}
                    class="quiet verify"
                    type="button"
                    aria-label={`Verify ${draft.label}`}
                    aria-expanded={verifying === draft.id}
                    aria-describedby={form.dirty ? "verify-wait" : undefined}
                    title={form.dirty ? "Save first." : undefined}
                    disabled={form.dirty || saving.pending}
                    onClick={() => {
                      setPanel(null);
                      verification.say(null);
                      if (verifying === draft.id) closeVerify();
                      else setVerifying(draft.id);
                    }}
                  >
                    Verify
                  </button>
                </div>
              ) : (
                <label class="label" for={id} id={`label-${draft.id}`} tabIndex={verified ? -1 : undefined}>
                  {/* a custom field is named as typed: its first letter is raised, as on the profile */}
                  {name}
                  {verified && !edited && <State standing="Verified" />}
                </label>
              )}
              <div class={actions === 2 ? "control has-actions" : actions === 1 ? "control has-action" : "control"}>
                {draft.removed ? (
                  <p class="removed" id={id}>
                    Removed
                  </p>
                ) : isPrivate ? (
                  <p class="private" id={id}>
                    Private
                  </p>
                ) : (
                  <input
                    id={id}
                    class="input"
                    type="text"
                    inputMode={inputMode(draft)}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    value={draft.text}
                    aria-invalid={trouble !== null || undefined}
                    onInput={(e) => patch(draft.id, { text: e.currentTarget.value })}
                  />
                )}
              </div>
              <span class="row-actions">
                {switchable && (
                  <IconButton label={`Make ${draft.label} ${draft.private ? "public" : "private"}`} onClick={() => patch(draft.id, { private: !draft.private })}>
                    {/* the icon shows what the press does: a padlock closes, an open one opens */}
                    {draft.private ? <LockOpenIcon /> : <LockIcon />}
                  </IconButton>
                )}
                {isPrivate && !draft.removed && (
                  <>
                    <IconButton
                      label={`Reveal ${draft.label}`}
                      aria-expanded={panel?.id === draft.id && panel.kind === "reveal"}
                      disabled={form.dirty}
                      onClick={() => open("reveal")}
                    >
                      <EyeIcon />
                    </IconButton>
                    <button
                      class="quiet"
                      type="button"
                      aria-label={`Verification packet for ${draft.label}`}
                      aria-expanded={panel?.id === draft.id && panel.kind === "packet"}
                      disabled={form.dirty}
                      onClick={() => open("packet")}
                    >
                      Packet
                    </button>
                  </>
                )}
                {removable && (
                  <IconButton
                    label={`${draft.removed ? "Undo" : "Remove"} ${draft.label}`}
                    onClick={() => {
                      if (draft.original === null) {
                        touch();
                        form.setFields((all) => all.filter((d) => d.id !== draft.id));
                      } else patch(draft.id, { removed: !draft.removed });
                    }}
                  >
                    {draft.removed ? <UndoIcon /> : <TrashIcon />}
                  </IconButton>
                )}
              </span>
              {trouble && <p class="problem note-row">{trouble}</p>}
              {verified && edited && <p class="hint note-row">{ROW_HINT}</p>}
              {input && draft.private && <p class="hint note-row">{PRIVATE_HINT}</p>}
              {input && draft.private && draft.original?.privacy === "public" && <p class="hint note-row">{WAS_PUBLIC_HINT}</p>}
              {openVerify && openVerify.id === draft.id && (
                <div class="note-row">
                  <VerifyPanel
                    key={`verify-${draft.id}`}
                    draft={openVerify}
                    address={address}
                    wallet={wallet}
                    secret={secret}
                    saving={saving}
                    verification={verification}
                    onVerified={(kind) => {
                      closeVerify();
                      verification.verified(kind);
                    }}
                    onClose={closeVerify}
                  />
                </div>
              )}
              {openPanel && openPanel.id === draft.id && (
                <div class="note-row">
                  <PrivatePanel
                    key={`${panel!.kind}-${draft.id}`}
                    kind={panel!.kind}
                    draft={openPanel}
                    secret={secret}
                    saving={saving}
                    wallet={wallet}
                    address={address}
                    onClose={() => setPanel(null)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {form.dirty && (storedPrivate || live.some(verifiable)) && (
        <p class="hint" id="verify-wait">
          {!live.some(verifiable)
            ? "Reveal and Packet wait until your changes are saved or cancelled."
            : storedPrivate
              ? "Reveal, Packet and Verify wait until your changes are saved or cancelled."
              : "Save first to verify a field."}
        </p>
      )}
      <NoticeLine verification={verification} where="fields" />
      <LiveRegion verification={verification} />

      <form
        class="add"
        onSubmit={(e) => {
          e.preventDefault();
          touch();
          setAddProblem(form.addField());
        }}
      >
        <input
          class="input"
          type="text"
          aria-label="Name of a new field"
          placeholder="Name"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={form.newField.name}
          onInput={(e) => {
            touch();
            form.setNewField({ ...form.newField, name: e.currentTarget.value });
            setAddProblem(null);
          }}
        />
        <input
          class="input"
          type="text"
          aria-label="Value of a new field"
          placeholder="Value"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={form.newField.value}
          onInput={(e) => {
            touch();
            form.setNewField({ ...form.newField, value: e.currentTarget.value });
            setAddProblem(null);
          }}
        />
        <button class="icon-button add-button" type="submit" aria-label="Add field" title="Add field" disabled={saving.pending}>
          <PlusIcon />
        </button>
        {addProblem && <p class="problem note-row">{addProblem}</p>}
      </form>

      {showLocked && (
        <div class="secret" role="group" aria-label="Identity secret">
          <div class="actions">
            <p class="status">Identity secret locked</p>
            <button class="quiet" type="button" onClick={() => setUnlocking(true)}>
              Unlock
            </button>
          </div>
        </div>
      )}
      {showSecret && <SecretBlock secret={secret} saving={saving} stranded={(profile?.fields ?? []).some((f) => f.privacy === "private")} />}
    </section>
  );
}

// --- Links ------------------------------------------------------------------------------------

function LinkInputs({ title, url, onTitle, onUrl, label }: { title: string; url: string; onTitle(v: string): void; onUrl(v: string): void; label: string }) {
  return (
    <>
      <input class="input" type="text" aria-label={`${label} title`} placeholder="Title" autocomplete="off" value={title} onInput={(e) => onTitle(e.currentTarget.value)} />
      <input
        class="input"
        type="text"
        inputMode="url"
        aria-label={`${label} address`}
        placeholder="Address"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={url}
        onInput={(e) => onUrl(e.currentTarget.value)}
      />
    </>
  );
}

export function LinksSection({ form, saving }: { form: ProfileForm; saving: Saving }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState({ title: "", url: "" });
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const shown = form.links;
  const kept = shown.filter((d) => !d.removed);
  const touch = () => saving.touch("profile");
  const change = (key: string, patch: { title?: string; url?: string; removed?: boolean }) => {
    touch();
    form.setLinks((all) => all.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };
  const move = (key: string, by: -1 | 1) => {
    touch();
    form.setLinks((all) => {
      const from = all.findIndex((d) => d.key === key);
      // step over removed rows: the order that counts is the order of the links kept
      let to = from + by;
      while (to >= 0 && to < all.length && all[to]!.removed) to += by;
      if (from < 0 || to < 0 || to >= all.length) return all;
      const next = [...all];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
  };

  return (
    <section class="block" aria-label="Links">
      <span class="label">Links</span>
      {shown.length > 0 && (
        <ul class="items">
          {shown.map((link) => {
            const position = kept.indexOf(link);
            const isNew = link.original === null;
            const changed = !isNew && (link.title.trim() !== link.original!.title || normalizeUrl(link.url) !== link.original!.url);
            const problem = link.removed ? null : form.linkProblem(link.key);
            return (
              <li class="item" key={link.key}>
                {editing === link.key && !link.removed ? (
                  <div class="item-edit">
                    <LinkInputs label="Link" title={link.title} url={link.url} onTitle={(v) => change(link.key, { title: v })} onUrl={(v) => change(link.key, { url: v })} />
                    {link.original?.verified && changed && <p class="hint note-row">This link is verified. Changing it removes the verification.</p>}
                    {problem && <p class="problem note-row">{problem}</p>}
                    <div class="actions note-row">
                      <button class="button" type="button" onClick={() => setEditing(null)}>
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div class="item-text">
                      <span class={link.removed ? "link-title gone" : "link-title"}>{link.title}</span>
                      <span class="link-url">{link.removed ? "Removed" : describeUrl(link.url).text}</span>
                      {problem && <span class="problem">{problem}</span>}
                    </div>
                    <div class="item-actions">
                      {!link.removed && (
                        <>
                          <IconButton label={`Move ${link.title} up`} disabled={position === 0} onClick={() => move(link.key, -1)}>
                            <ChevronUpIcon />
                          </IconButton>
                          <IconButton label={`Move ${link.title} down`} disabled={position === kept.length - 1} onClick={() => move(link.key, 1)}>
                            <ChevronDownIcon />
                          </IconButton>
                          <IconButton
                            label={`Edit ${link.title}`}
                            onClick={() => {
                              touch();
                              setEditing(link.key);
                            }}
                          >
                            <PencilIcon />
                          </IconButton>
                        </>
                      )}
                      <IconButton
                        label={`${link.removed ? "Undo" : "Remove"} ${link.title}`}
                        onClick={() => {
                          if (isNew) {
                            touch();
                            form.setLinks((all) => all.filter((d) => d.key !== link.key));
                          } else change(link.key, { removed: !link.removed });
                        }}
                      >
                        {link.removed ? <UndoIcon /> : <TrashIcon />}
                      </IconButton>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {kept.length < LIMITS.links ? (
        <form
          class="add"
          onSubmit={(e) => {
            e.preventDefault();
            touch();
            const problem = form.addLink(adding.title, adding.url);
            setAddProblem(problem);
            if (problem === null) setAdding({ title: "", url: "" });
          }}
        >
          <LinkInputs
            label="New link"
            title={adding.title}
            url={adding.url}
            onTitle={(v) => {
              setAddProblem(null);
              setAdding({ ...adding, title: v });
            }}
            onUrl={(v) => {
              setAddProblem(null);
              setAdding({ ...adding, url: v });
            }}
          />
          <button class="icon-button add-button" type="submit" aria-label="Add link" title="Add link" disabled={saving.pending}>
            <PlusIcon />
          </button>
          {addProblem && <p class="problem note-row">{addProblem}</p>}
        </form>
      ) : (
        <p class="hint">You have reached the limit of links.</p>
      )}
    </section>
  );
}

// --- Save -------------------------------------------------------------------------------------

/** The one Save of the form, at the bottom of the card, kept in view while there are changes. */
export function SaveBar({ form, saving, count, onSave, onCancel }: { form: ProfileForm; saving: Saving; count: number; onSave(): void; onCancel(): void }) {
  const reporting = saving.status?.section === "profile";
  if (!form.dirty && !reporting) return null;
  return (
    <div class={form.dirty ? "savebar dirty" : "savebar"} role="group" aria-label="Save">
      <div class="savebar-text">
        {reporting ? (
          <StatusLine saving={saving} section="profile" />
        ) : form.problem ? (
          <p class="problem">{form.problem}</p>
        ) : (
          <p class="status">{count === 1 ? "1 change" : count > 1 ? `${count} changes` : "Unsaved changes"}</p>
        )}
      </div>
      {form.dirty && (
        <div class="actions">
          <button class="button" type="button" disabled={saving.pending} onClick={onCancel}>
            Cancel
          </button>
          <button class="button primary" type="button" disabled={saving.pending || form.problem !== null} onClick={onSave}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
