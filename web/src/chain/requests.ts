// Asking an authority to check something: the requests an account has pending, and what the page
// offers to ask for. The decoders are pure (they take the JSON polkadot.js gives) and tested on
// answers captured from a real node; the readers at the bottom fetch.
//
// A request is a row of the chain's `pendingRequests` table, keyed by (authority, target), where
// the target is a field, a link, or a fact about the person. The chain does not check that the
// field exists when the request is made, nor when the field is removed later, so a request can
// outlive its field: those are listed too, because only the person can cancel them and they count
// against the limit of 16.

import { publicKeyHex } from "./address.ts";
import { DecodeError, type Fact, FIELD_LABELS, type FieldKind, type Profile, decodeRef, refId, type AttestationRef } from "./identity.ts";
import { hexToString, isHex } from "@polkadot/util";
import { type Reader, reader } from "./reader.ts";

/** The authority the page asks. Authority 0 is identitee itself. */
export const REQUEST_AUTHORITY = 0;

/** What a request asks for: a field (typed, custom or link) or a fact about the person. */
export type RequestTarget = { field: AttestationRef } | { fact: Fact["kind"] };

export interface PendingRequest {
  authority: number;
  target: RequestTarget;
  /** The block it was made at. */
  since: number;
}

export interface AuthorityInfo {
  id: number;
  name: string;
  /** An inactive authority takes no requests. */
  active: boolean;
}

/** Typed fields no authority can attest: names are declarative only (`FieldKind::is_verifiable`
 * in pallets/identitee/src/types.rs, which a test compares). */
export const UNVERIFIABLE: readonly FieldKind[] = ["DisplayName", "LegalName"];

type Json = any;

const bad = (what: string): never => {
  throw new DecodeError(what);
};

/** A stable key per target: `typed:Email`, `custom:mastodon`, `link:3`, `fact:DocumentChecked`. */
export function targetId(target: RequestTarget): string {
  return "fact" in target ? `fact:${target.fact}` : refId(target.field);
}

/** A request target as the chain's JSON gives it: `{ field: { typed: "Email" } }`, `{ fact: "Fraud" }`. */
export function decodeTarget(raw: Json): RequestTarget {
  if (raw && typeof raw === "object") {
    if ("field" in raw) return { field: decodeRef(raw.field) };
    if (raw.fact === "DocumentChecked" || raw.fact === "Fraud") return { fact: raw.fact };
  }
  return bad("request target");
}

/**
 * The rows of the `pendingRequests` table under one account: each `[[authority, target], block]`,
 * the key and the value as polkadot.js gives them in JSON. Oldest first.
 */
export function decodePendingRequests(entries: Json): PendingRequest[] {
  if (!Array.isArray(entries)) return bad("list of requests");
  return entries
    .map((entry): PendingRequest => {
      const [key, block] = Array.isArray(entry) ? entry : [];
      if (!Array.isArray(key) || key.length !== 2 || !Number.isSafeInteger(key[0]) || !Number.isSafeInteger(block)) {
        return bad("request");
      }
      return { authority: key[0], target: decodeTarget(key[1]), since: block };
    })
    .sort((a, b) => a.since - b.since);
}

/** An authority row, `null` if there is none with that id. */
export function decodeAuthority(id: number, raw: Json): AuthorityInfo | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw.active !== "boolean" || typeof raw.name !== "string" || !isHex(raw.name)) return bad("authority");
  return { id, name: hexToString(raw.name), active: raw.active };
}

// --- What to offer -----------------------------------------------------------------------------

export type Standing = "Verified" | "Pending" | "Rejected";

/** The targets of the requests waiting for an authority, by `targetId`. */
export function requestedIds(pending: readonly PendingRequest[]): Set<string> {
  return new Set(pending.map((r) => targetId(r.target)));
}

/**
 * What the chain says of one field, link or fact now. The one ranking, used by the profile and by
 * /requests alike, so a field never reads differently on the two pages:
 * Verified (a valid attestation) first; then Pending (a request is waiting for a verdict); then
 * Rejected (a verdict that still stands); otherwise `null`, nothing asked and nothing attested.
 * A rejected value that is asked about again therefore reads Pending on both pages until the new
 * verdict, and a value nobody asked about is never called Pending.
 */
export function standingOf(id: string, flags: { verified: boolean; rejected: boolean } | null, requested: ReadonlySet<string>): Standing | null {
  return flags?.verified ? "Verified" : requested.has(id) ? "Pending" : flags?.rejected ? "Rejected" : null;
}

export interface VerifyItem {
  /** `targetId` of the target. */
  id: string;
  /** `gone`: a request whose field is no longer on the identity. */
  kind: "field" | "link" | "fact" | "gone";
  label: string;
  /** A public value or a link address; `null` for a private value (not known here) and for a fact. */
  detail: string | null;
  private: boolean;
  target: RequestTarget;
  /** What the chain says now; `null` when nothing has been asked and nothing is attested. */
  standing: Standing | null;
  request: PendingRequest | null;
}

function labelOf(target: RequestTarget): string {
  if ("fact" in target) return target.fact === "DocumentChecked" ? "Identity document" : "Fraud";
  const ref = target.field;
  if ("typed" in ref) return FIELD_LABELS[ref.typed];
  return "custom" in ref ? ref.custom : `Link ${ref.link}`;
}

/**
 * What the person can ask to have checked, with where each stands: the typed fields an authority
 * can attest, the custom fields, the links, and the identity document; then the requests that no
 * longer match anything on the identity. "Verified" is the chain's reading of the profile; "Pending"
 * is a request waiting; "Rejected" a verdict that still stands.
 */
export function verifyItems(profile: Profile | null, pending: readonly PendingRequest[]): VerifyItem[] {
  if (profile === null && pending.length === 0) return [];
  const requests = new Map(pending.map((r) => [targetId(r.target), r]));
  const items: VerifyItem[] = [];
  const requested = requestedIds(pending);
  const add = (item: Omit<VerifyItem, "request">): void => void items.push({ ...item, request: requests.get(item.id) ?? null });

  for (const field of profile?.fields ?? []) {
    if ("typed" in field.ref && UNVERIFIABLE.includes(field.ref.typed)) continue;
    add({
      id: field.id,
      kind: "field",
      label: field.label,
      detail: field.value,
      private: field.privacy === "private",
      target: { field: field.ref },
      standing: standingOf(field.id, field, requested),
    });
  }
  for (const link of profile?.links ?? []) {
    const id = `link:${link.id}`;
    add({ id, kind: "link", label: link.title, detail: link.url, private: false, target: { field: { link: link.id } }, standing: standingOf(id, link, requested) });
  }
  if (profile !== null) {
    const id = "fact:DocumentChecked";
    const checked = profile.facts.some((f) => f.kind === "DocumentChecked" && f.active);
    add({ id, kind: "fact", label: labelOf({ fact: "DocumentChecked" }), detail: null, private: false, target: { fact: "DocumentChecked" }, standing: standingOf(id, { verified: checked, rejected: false }, requested) });
  }
  const shown = new Set(items.map((i) => i.id));
  for (const request of pending) {
    const id = targetId(request.target);
    if (shown.has(id)) continue;
    shown.add(id);
    add({ id, kind: "gone", label: labelOf(request.target), detail: null, private: false, target: request.target, standing: "Pending" });
  }
  return items;
}

// --- Readers -----------------------------------------------------------------------------------

/** The pending requests of `address`, oldest first. */
export async function pendingRequestsOf(address: string | Uint8Array, at?: Reader): Promise<PendingRequest[]> {
  const api = await reader(at);
  const entries = await (api.query as Json).identitee.pendingRequests.entries(publicKeyHex(address));
  return decodePendingRequests(entries.map(([key, block]: [Json, Json]) => [key.args[1].toJSON(), block.toJSON()]));
}

/** An authority by id, `null` if there is none. */
export async function readAuthority(id: number = REQUEST_AUTHORITY, at?: Reader): Promise<AuthorityInfo | null> {
  const api = await reader(at);
  return decodeAuthority(id, (await (api.query as Json).identitee.authorities(id)).toJSON());
}
