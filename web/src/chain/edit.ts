// Editing an identity: what the person types becomes the calls the chain takes. Pure, no network:
// the pages keep a draft, this module says what is wrong with it and which changes it makes.
//
// Limits are those of pallets/identitee/src/limits.rs (test/edit.test.ts reads that file). They are
// counted in UTF-8 BYTES, which is what the runtime counts: an accent or an emoji weighs more than
// one. Every value is checked here first so that a refusal comes as a sentence next to the field,
// not as a failed transaction.

import { hexToU8a, stringToU8a, u8aToHex } from "@polkadot/util";
import { privateCommitment } from "./formulas.ts";
import { FIELD_LABELS, type FieldKind, type FieldRef, type Profile, type ProfileField } from "./identity.ts";
import { Refusal } from "./refusal.ts";

export const LIMITS = {
  /** A field value or a link url. */
  value: 256,
  customKey: 32,
  customFields: 16,
  links: 16,
  linkTitle: 64,
  bio: 560,
  /** Changes in one `set_identity`. */
  changes: 32,
  /** The encrypted identity secret, in bytes. */
  secretBlob: 256,
  /** The label a parent gives a sub-account, in bytes. */
  subLabel: 64,
  /** Sub-accounts and proposals of one parent together. */
  subs: 100,
  /** Pending verification requests of one account. */
  pendingRequests: 16,
  /** The note an authority attaches to a refusal or a fact, in bytes. */
  note: 128,
} as const;

export const byteLength = (text: string): number => stringToU8a(text).length;

const tooLong = (text: string, max: number): string | null => {
  const used = byteLength(text);
  return used > max ? `Too long, ${used} of ${max} bytes.` : null;
};

// --- Bio --------------------------------------------------------------------------------------

export const bioProblem = (bio: string): string | null => tooLong(bio, LIMITS.bio);

// --- Fields -----------------------------------------------------------------------------------

/** A field as the form holds it. */
export interface FieldDraft {
  /** `typed:Email`, `custom:mastodon`: the same keys as `ProfileField.id`. */
  id: string;
  ref: FieldRef;
  /** The label of a typed field, the name of a custom one. */
  label: string;
  /** What the person typed (a PGP fingerprint as hexadecimal text). */
  text: string;
  /** The person asked to remove it. */
  removed: boolean;
  /** Only a commitment of the value goes to the chain. Starts as the field is on the chain. */
  private: boolean;
  /** The field on the chain, `null` for one that is new. */
  original: ProfileField | null;
}

/** A PGP fingerprint in groups of four, as GnuPG prints it. */
export const groupHex = (hex: string): string => (hex.match(/.{1,4}/g) ?? []).join(" ");

/** The text of a field's value as the form shows it; a private value is not known here. */
export function textOf(field: ProfileField): string {
  if (field.privacy === "private" || field.value === null) return "";
  return field.id === "typed:Pgp" ? groupHex(field.value) : field.value;
}

function draftOf(field: ProfileField | undefined, ref: FieldRef, label: string): FieldDraft {
  const id = "typed" in ref ? `typed:${ref.typed}` : `custom:${ref.custom}`;
  return { id, ref, label, text: field ? textOf(field) : "", removed: false, private: field?.privacy === "private", original: field ?? null };
}

/** The form for `profile` (`null`: no identity yet): every typed field, in the chain's order,
 * then the custom fields it has. */
export function fieldDrafts(profile: Profile | null): FieldDraft[] {
  const have = new Map((profile?.fields ?? []).map((f) => [f.id, f]));
  const typed = (Object.keys(FIELD_LABELS) as FieldKind[]).map((kind) =>
    draftOf(have.get(`typed:${kind}`), { typed: kind }, FIELD_LABELS[kind]),
  );
  const custom = (profile?.fields ?? []).filter((f) => "custom" in f.ref).map((f) => draftOf(f, f.ref, f.label));
  return [...typed, ...custom];
}

/** What a PGP fingerprint typed by hand stands for: 20 or 32 bytes of hexadecimal, spaces and a
 * `0x` ignored. `null` when it is none. */
export function parsePgp(text: string): Uint8Array | null {
  const hex = text.replace(/\s+/g, "").replace(/^0x/i, "");
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hex) ? hexToU8a(`0x${hex}`) : null;
}

const isPgp = (draft: FieldDraft): boolean => "typed" in draft.ref && draft.ref.typed === "Pgp";
/** A private field already on the chain, kept private: its value is not known here, so it can only
 * be kept, removed, or revealed (`reveal_field`). */
const storedPrivate = (draft: FieldDraft): boolean => draft.original?.privacy === "private" && draft.private;

/** The person has not touched the field: what is in the form is what the chain's value looks like,
 * with the same visibility. */
const untouched = (draft: FieldDraft): boolean =>
  draft.original !== null && !draft.removed && draft.private === (draft.original.privacy === "private") && draft.text === textOf(draft.original);

/** The bytes a draft would put on the chain, `null` when it would remove the field, `"keep"` when
 * it leaves the field as it is. A field left as it was shown is kept before anything is trimmed, so
 * a value stored with spaces around it is never rewritten behind the person's back. */
function target(draft: FieldDraft): Uint8Array | null | "keep" {
  if (draft.removed) return null;
  if (storedPrivate(draft) || untouched(draft)) return "keep";
  const text = draft.text.trim();
  if (text === "") return null;
  // a website is stored as a link is: with its scheme
  if (isWeb(draft)) return stringToU8a(normalizeUrl(text));
  return isPgp(draft) ? parsePgp(text) : stringToU8a(text);
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const isWeb = (draft: FieldDraft): boolean => "typed" in draft.ref && draft.ref.typed === "Web";
const isEmail = (draft: FieldDraft): boolean => "typed" in draft.ref && draft.ref.typed === "Email";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A custom field named like a built-in one ("Email") would pass for it on the profile. */
const TYPED_LABELS = new Set(Object.values(FIELD_LABELS).map((label) => label.toLowerCase()));
const takenByTyped = (key: string): boolean => TYPED_LABELS.has(key.trim().toLowerCase());
const TYPED_NAME = "That name belongs to a built-in field. Use the built-in field, or another name.";

/** What is wrong with a field as typed, in a sentence, or `null`. */
export function fieldProblem(draft: FieldDraft, all: readonly FieldDraft[]): string | null {
  if ("custom" in draft.ref) {
    const key = draft.ref.custom;
    if (key.trim() === "") return "Give the field a name.";
    if (byteLength(key) > LIMITS.customKey) return `The name is too long, ${byteLength(key)} of ${LIMITS.customKey} bytes.`;
    if (all.some((other) => other !== draft && other.id === draft.id)) return "Two fields have that name.";
    if (draft.original === null && takenByTyped(key)) return TYPED_NAME;
  }
  // a private value is checked like a public one: it must be accepted when it is revealed
  if (draft.removed || storedPrivate(draft) || untouched(draft)) return null;
  const text = draft.text.trim();
  if (text === "") return null;
  if (isPgp(draft)) return parsePgp(text) === null ? "A PGP fingerprint has 40 or 64 hexadecimal characters." : null;
  if (isWeb(draft)) return webAddressProblem(text);
  if (isEmail(draft) && !EMAIL.test(text)) return "That is not an email address.";
  return tooLong(text, LIMITS.value);
}

/** The first problem of the form, or `null`. */
export function firstProblem(drafts: readonly FieldDraft[]): string | null {
  for (const draft of drafts) {
    const problem = fieldProblem(draft, drafts);
    if (problem) return `${draft.label}: ${problem}`;
  }
  return null;
}

export interface FieldChange {
  ref: FieldRef;
  /** The new value, `null` to remove the field. */
  value: Uint8Array | null;
  /** The value is private: only its commitment goes to the chain. */
  private?: true;
}

/** Saving these changes needs the identity secret (the salt of a private field comes from it). */
export const needsSecret = (changes: readonly FieldChange[]): boolean => changes.some((c) => c.private === true);

/**
 * The changes that turn the chain's fields into the form's, and only those: a field left as it is
 * is not sent, an empty or removed one is removed if it exists, and a private field stays as it
 * is unless removed. A value made private is always sent (as a private change): its commitment
 * cannot be compared here. Throws if the form has a problem (check `firstProblem` first).
 */
export function fieldChanges(drafts: readonly FieldDraft[]): FieldChange[] {
  const problem = firstProblem(drafts);
  if (problem) throw new Refusal(problem);
  const changes: FieldChange[] = [];
  for (const draft of drafts) {
    const wanted = target(draft);
    if (wanted === "keep") continue;
    const { original } = draft;
    if (wanted === null) {
      if (original) changes.push({ ref: draft.ref, value: null });
    } else if (draft.private) {
      changes.push({ ref: draft.ref, value: wanted, private: true });
    } else if (!(original?.privacy === "public" && original.bytes && same(original.bytes, wanted))) {
      changes.push({ ref: draft.ref, value: wanted });
    }
  }
  if (changes.length > LIMITS.changes) throw new Refusal("Too many changes at once. Save fewer fields.");
  return changes;
}

/** Add a custom field to the form; `null` and a sentence if its name is not acceptable. */
export function withCustom(drafts: readonly FieldDraft[], name: string, text: string): { drafts: FieldDraft[]; problem: null } | { problem: string } {
  const key = name.trim();
  if (key === "") return { problem: "Give the field a name." };
  if (byteLength(key) > LIMITS.customKey) return { problem: `The name is too long, ${byteLength(key)} of ${LIMITS.customKey} bytes.` };
  if (drafts.some((d) => d.id === `custom:${key}`)) return { problem: "You already have a field with that name." };
  if (takenByTyped(key)) return { problem: TYPED_NAME };
  if (drafts.filter((d) => "custom" in d.ref).length >= LIMITS.customFields) return { problem: "You have reached the limit of custom fields." };
  const value = text.trim();
  if (value === "") return { problem: "Give the field a value." };
  const long = tooLong(value, LIMITS.value);
  if (long) return { problem: long };
  return {
    drafts: [...drafts, { id: `custom:${key}`, ref: { custom: key }, label: key, text: value, removed: false, private: false, original: null }],
    problem: null,
  };
}

// --- Links ------------------------------------------------------------------------------------

/** `localhost:3000`, `example.com:8080/path`: a host and a port, which looks like a scheme. */
const HOST_AND_PORT = /^[^/:@\s]+:\d+(?:[/?#]|$)/;

/** An address as it will be stored: `https://` is added when no scheme is given. Something that
 * starts like `javascript:` or `mailto:` has one and is left as typed, to be refused; a host and a
 * port is not a scheme. */
export function normalizeUrl(url: string): string {
  const text = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !HOST_AND_PORT.test(text);
  return hasScheme ? text : `https://${text}`;
}

/** What is wrong with a link as typed, or `null`. Only web addresses are accepted: the profile
 * follows no other kind. */
export function linkProblem(title: string, url: string): string | null {
  if (title.trim() === "") return "Give the link a title.";
  if (byteLength(title.trim()) > LIMITS.linkTitle) return `The title is too long, ${byteLength(title.trim())} of ${LIMITS.linkTitle} bytes.`;
  if (url.trim() === "") return "Give the link an address.";
  return webAddressProblem(url);
}

/** What is wrong with a web address as typed (a link, the Website field), or `null`. Browsers
 * parse more than an address (Chrome takes `https://not a url`): the host must be a name with a
 * dot or an IP address. */
export function webAddressProblem(url: string): string | null {
  const text = url.trim();
  if (/\s/.test(text)) return "That is not a web address.";
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrl(text));
  } catch {
    return "That is not a web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Links start with http:// or https://.";
  const host = parsed.hostname;
  // a public profile links to public places: a name with a dot, or an IP address
  const named = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host);
  if (!named) return "That is not a web address.";
  return tooLong(normalizeUrl(text), LIMITS.value);
}

/** The order the form shows: the person's order for the links that still exist, new ones last. */
export function mergeOrder(wanted: readonly number[], onChain: readonly number[]): number[] {
  const kept = wanted.filter((id) => onChain.includes(id));
  return [...kept, ...onChain.filter((id) => !kept.includes(id))];
}

/** Move the item `id` one place up (`-1`) or down (`1`). */
export function moved(order: readonly number[], id: number, by: -1 | 1): number[] {
  const from = order.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

// --- The calls' arguments ---------------------------------------------------------------------

/** A field's key as the calls take it (`FieldKey`). */
export const fieldKey = (ref: FieldRef): object => ("typed" in ref ? { Typed: ref.typed } : { Custom: u8aToHex(stringToU8a(ref.custom)) });

/** One change as `set_identity` takes it: `[FieldKey, Option<FieldValue>]`. A private value becomes
 * `Private(commitment)` under the salt `saltOf` gives for its field; the value itself is not in it. */
export function chainChange(change: FieldChange, saltOf?: (ref: FieldRef) => Uint8Array): [object, object | null] {
  const { ref, value } = change;
  if (value === null) return [fieldKey(ref), null];
  if (!change.private) return [fieldKey(ref), { Public: u8aToHex(value) }];
  if (!saltOf) throw new Refusal("A private field needs the identity secret.");
  return [fieldKey(ref), { Private: privateCommitment(saltOf(ref), value) }];
}
