// The profile form of /me: the avatar, the bio, the fields and the links as the person is changing
// them, and the one `update_profile` that saves them all with a single signature. Nothing here is
// sent: the page signs `update` when the person presses Save.
//
// The drafts start from the identity on chain and start again from it each time it is read anew
// (after a save, the chain's version is the one shown).

import { useEffect, useState } from "preact/hooks";
import type { LinkEdit, ProfileUpdate } from "../chain/calls.ts";
import {
  type FieldDraft,
  LIMITS,
  bioProblem,
  needsSecret,
  fieldChanges,
  fieldDrafts,
  firstProblem,
  linkProblem,
  normalizeUrl,
  withCustom,
} from "../chain/edit.ts";
import type { Profile, ProfileLink } from "../chain/identity.ts";

/** A link as the form holds it: an existing one (`original`) or a new one, in the order shown. */
export interface LinkDraft {
  /** Stable while the page is open: the chain id, or a local one for a new link. */
  key: string;
  title: string;
  url: string;
  removed: boolean;
  original: ProfileLink | null;
}

const linkDrafts = (profile: Profile | null): LinkDraft[] =>
  (profile?.links ?? []).map((link) => ({ key: `link:${link.id}`, title: link.title, url: link.url, removed: false, original: link }));

// A link left as read is unchanged even when another client stored it in a form this page would
// not write (" Blog ", "example.com"): only an edited link is normalised and checked.
const sameLink = (draft: LinkDraft, link: ProfileLink): boolean =>
  (draft.title === link.title && draft.url === link.url) || (draft.title.trim() === link.title && normalizeUrl(draft.url) === link.url);

/** The links part of the update: `undefined` when the form shows the links exactly as on chain. */
export function linkEdits(drafts: readonly LinkDraft[], onChain: readonly ProfileLink[]): LinkEdit[] | undefined {
  const kept = drafts.filter((d) => !d.removed);
  const unchanged =
    kept.length === onChain.length && kept.every((d, i) => d.original !== null && d.original.id === onChain[i]!.id && sameLink(d, d.original));
  if (unchanged) return undefined;
  return kept.map((d): LinkEdit => {
    if (d.original === null) return { add: true, title: d.title, url: d.url };
    return sameLink(d, d.original) ? { keep: d.original.id } : { update: d.original.id, title: d.title, url: d.url };
  });
}

/** The first problem of the links as typed, by link key, or `null`. */
export function linkTrouble(drafts: readonly LinkDraft[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const d of drafts) {
    if (d.removed || (d.original && sameLink(d, d.original))) continue;
    const problem = linkProblem(d.title, d.url);
    if (problem) found.set(d.key, problem);
  }
  return found;
}

export interface ProfileForm {
  /** `undefined`: the avatar on chain stays; `null`: removed; bytes: the new one. */
  avatar: Uint8Array | null | undefined;
  setAvatar(avatar: Uint8Array | null | undefined): void;
  bio: string;
  setBio(bio: string): void;
  fields: FieldDraft[];
  setFields(change: (all: FieldDraft[]) => FieldDraft[]): void;
  /** The add row of the fields: a name and a value not yet in the form. */
  newField: { name: string; value: string };
  setNewField(row: { name: string; value: string }): void;
  /** Put the add row into the form; its problem, or `null`. */
  addField(): string | null;
  links: LinkDraft[];
  setLinks(change: (all: LinkDraft[]) => LinkDraft[]): void;
  /** Add a link at the end; its problem, or `null`. */
  addLink(title: string, url: string): string | null;
  /** What is wrong with the link `key` as typed, or `null`. */
  linkProblem(key: string): string | null;
  /** What Save would send, with what stops it: the first problem in a sentence. */
  update: ProfileUpdate;
  /** What Save sends: `update` with the add row of the fields taken in, or why it cannot be. */
  toSave(): { update: ProfileUpdate } | { problem: string };
  problem: string | null;
  /** The form differs from the chain (or the add row of the fields is filled). */
  dirty: boolean;
  /** Back to what the chain holds. */
  reset(): void;
}

let localIds = 0;
const LINK_LIMIT = "You have reached the limit of links.";

/** The form for `profile`, started again whenever `profile` is read anew. `secretBlob`: a new
 * identity secret waiting for the Save. */
export function useProfileForm(profile: Profile | null, secretBlob: Uint8Array | null, secretOpen: boolean): ProfileForm {
  const [avatar, setAvatar] = useState<Uint8Array | null | undefined>(undefined);
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [fields, setFieldList] = useState(() => fieldDrafts(profile));
  const [newField, setNewField] = useState({ name: "", value: "" });
  const [links, setLinkList] = useState(() => linkDrafts(profile));

  const reset = () => {
    setAvatar(undefined);
    setBio(profile?.bio ?? "");
    setFieldList(fieldDrafts(profile));
    setNewField({ name: "", value: "" });
    setLinkList(linkDrafts(profile));
  };
  useEffect(reset, [profile]);

  // the originals are read again from the profile, so their Verified marks stay current
  const byId = new Map((profile?.fields ?? []).map((f) => [f.id, f]));
  const live = fields.map((d) => (d.original ? { ...d, original: byId.get(d.id) ?? d.original } : d));

  const fieldProblem = firstProblem(live);
  const linkProblems = linkTrouble(links);
  const changes = fieldProblem ? [] : fieldChanges(live);
  const locked = needsSecret(changes) && !secretOpen ? "Unlock or create your identity secret to save a private field." : null;
  // an Undo of a removal can bring the links back over the limit
  const tooManyLinks = links.filter((d) => !d.removed).length > LIMITS.links ? LINK_LIMIT : null;
  const problem = bioProblem(bio) ?? fieldProblem ?? (linkProblems.size > 0 ? [...linkProblems.values()][0]! : null) ?? tooManyLinks ?? locked;
  const update: ProfileUpdate = {
    bio: bio.trim() !== (profile?.bio ?? "").trim() ? bio : undefined,
    avatar: avatar === null && !profile?.avatar ? undefined : avatar,
    fields: changes,
    links: linkEdits(links, profile?.links ?? []),
    secretBlob: secretBlob ?? undefined,
  };
  const adding = newField.name.trim() !== "" || newField.value.trim() !== "";
  // a problem only comes from something typed: a form with one has changes, even if none can be sent
  const dirty =
    problem !== null ||
    update.bio !== undefined || update.avatar !== undefined || update.fields.length > 0 || update.links !== undefined || update.secretBlob !== undefined || adding;

  return {
    avatar,
    setAvatar,
    bio,
    setBio,
    fields: live,
    setFields: (change) => setFieldList((all) => change(all)),
    newField,
    setNewField,
    addField() {
      const result = withCustom(live, newField.name, newField.value);
      if (result.problem !== null) return result.problem;
      setFieldList(result.drafts);
      setNewField({ name: "", value: "" });
      return null;
    },
    links,
    setLinks: (change) => setLinkList((all) => change(all)),
    addLink(title, url) {
      if (links.filter((d) => !d.removed).length >= LIMITS.links) return LINK_LIMIT;
      const trouble = linkProblem(title, url);
      if (trouble) return trouble;
      setLinkList((all) => [...all, { key: `new:${++localIds}`, title: title.trim(), url: normalizeUrl(url), removed: false, original: null }]);
      return null;
    },
    linkProblem: (key) => linkProblems.get(key) ?? null,
    update,
    toSave() {
      if (problem) return { problem };
      if (!adding) return { update };
      const result = withCustom(live, newField.name, newField.value);
      if (result.problem !== null) return { problem: result.problem };
      const withRow = firstProblem(result.drafts);
      return withRow ? { problem: withRow } : { update: { ...update, fields: fieldChanges(result.drafts) } };
    },
    problem,
    dirty,
    reset,
  };
}
