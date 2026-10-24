// What the chain says about an identity, read through the IdentiteeApi runtime API and decoded
// into plain objects the pages can render. The decoders are pure (they take the JSON polkadot.js
// gives) and are tested on answers captured from a real node; the readers at the bottom fetch.

import { compactFromU8a, hexToString, hexToU8a, isHex, stringToHex, u8aToHex, u8aToString } from "@polkadot/util";
import { publicKeyHex, toIdentitee } from "./address.ts";
import { connect } from "./api.ts";
import { type Hex, publicCommitment } from "./formulas.ts";
import { type Reader, reader } from "./reader.ts";

// --- Types -------------------------------------------------------------------------------------

export type TrustLevel = "Fraudulent" | "Declared" | "PartiallyVerified" | "FullyVerified" | "Certified";

const TRUST_LEVELS: readonly string[] = ["Fraudulent", "Declared", "PartiallyVerified", "FullyVerified", "Certified"];

/** The typed fields, in the chain's order, with the label shown for each. */
export const FIELD_LABELS = {
  DisplayName: "Display name",
  LegalName: "Legal name",
  Web: "Website",
  Email: "Email",
  Matrix: "Matrix",
  X: "X",
  Discord: "Discord",
  GitHub: "GitHub",
  Telegram: "Telegram",
  Pgp: "PGP",
} as const;

export type FieldKind = keyof typeof FIELD_LABELS;

const KIND_ORDER = Object.keys(FIELD_LABELS);

/** A typed field or a custom field, by key. */
export type FieldRef = { typed: FieldKind } | { custom: string };

/** What an attestation points at: a field or a link. */
export type AttestationRef = FieldRef | { link: number };

export interface ProfileField {
  ref: FieldRef;
  /** Stable key: `typed:Email`, `custom:mastodon`. */
  id: string;
  label: string;
  privacy: "public" | "private";
  /** The text of a public value (capital hex for a PGP fingerprint); null for a private one. */
  value: string | null;
  /** The raw bytes of a public value; null for a private one. */
  bytes: Uint8Array | null;
  /** The commitment the chain holds for this field: what an authority attests. */
  commitment: Hex;
  /** An authority has a valid `Verified` attestation of this value and none rejects it. */
  verified: boolean;
  /** An authority has a valid `Rejected` attestation of this value. */
  rejected: boolean;
}

export interface ProfileLink {
  id: number;
  title: string;
  url: string;
  verified: boolean;
  rejected: boolean;
}

export interface Attestation {
  ref: AttestationRef;
  authority: number;
  commitment: Hex;
  verdict: "Verified" | "Rejected";
  /** `EmailCode`, `Manual`, `MigratedFromPeopleChain`... */
  method: string;
  /** The People Chain registrar behind a migrated attestation. */
  migrated?: { source: string; registrar: number; block: number };
  issuedAt: number;
  expiresAt: number | null;
  revoked: { block: number; reason: string } | null;
  /** Valid now: not revoked, not expired, and the field still has the attested value. */
  valid: boolean;
}

export interface Fact {
  kind: "DocumentChecked" | "Fraud";
  authority: number;
  issuedAt: number;
  expiresAt: number | null;
  reason: string;
  note: string;
  revoked: { block: number; reason: string } | null;
  active: boolean;
}

/** A sub-account (or the parent of one) with the label the parent gave it. */
export interface Member {
  address: string;
  label: string;
}

export interface Imported {
  source: string;
  block: number;
  blockHash: Hex;
  judgements: { registrar: number; judgement: string }[];
}

export interface Profile {
  /** Prefix 2426. */
  address: string;
  name: string | null;
  trust: TrustLevel;
  bio: string;
  /** WebP bytes, null without an avatar on chain. */
  avatar: Uint8Array | null;
  fields: ProfileField[];
  links: ProfileLink[];
  attestations: Attestation[];
  facts: Fact[];
  parent: Member | null;
  /** Accepted sub-accounts only; pending proposals come from `pendingSubsOf`. */
  subs: Member[];
  imported: Imported | null;
  createdAt: number;
  updatedAt: number;
}

export type NameStatus =
  | { state: "invalid" }
  | { state: "taken"; owner: string }
  | { state: "reserved" }
  | { state: "quarantined"; until: number }
  | { state: "available" };

// --- Decoders ----------------------------------------------------------------------------------

/** polkadot.js gives untyped JSON; the decoders check what they rely on. */
type Json = any;

/** The chain answered with a shape this app does not know. */
export class DecodeError extends Error {
  constructor(what: string) {
    super(`Unexpected answer from the chain: ${what}.`);
    this.name = "DecodeError";
  }
}

const fail = (what: string): never => {
  throw new DecodeError(what);
};

function hexBytes(value: Json, what: string): Uint8Array {
  return typeof value === "string" && isHex(value) ? hexToU8a(value) : fail(what);
}

const hexText = (value: Json, what: string): string => {
  hexBytes(value, what);
  return hexToString(value);
};

const hash = (value: Json, what: string): Hex => {
  const bytes = hexBytes(value, what);
  return bytes.length === 32 ? (u8aToHex(bytes) as Hex) : fail(what);
};

const num = (value: Json, what: string): number => (Number.isSafeInteger(value) ? value : fail(what));

const orNull = <T>(value: Json, read: (v: Json) => T): T | null => (value === null || value === undefined ? null : read(value));

const key = (ref: AttestationRef): string =>
  "typed" in ref ? `typed:${ref.typed}` : "custom" in ref ? `custom:${ref.custom}` : `link:${ref.link}`;

/** The stable key of a field, custom field or link: `typed:Email`, `custom:mastodon`, `link:3`. */
export const refId = key;

/** `Option<TrustLevel>` as the runtime API gives it. */
export function decodeTrustLevel(raw: Json): TrustLevel | null {
  if (raw === null || raw === undefined) return null;
  return TRUST_LEVELS.includes(raw) ? (raw as TrustLevel) : fail("trust level");
}

/** `Vec<(AccountId, Vec<u8>)>`: sub-accounts, proposals. */
export function decodeMembers(raw: Json): Member[] {
  if (!Array.isArray(raw)) return fail("list of accounts");
  return raw.map((entry) => decodeMember(entry));
}

function decodeMember(entry: Json): Member {
  if (!Array.isArray(entry) || entry.length !== 2) return fail("account with label");
  return { address: toIdentitee(entry[0]), label: hexText(entry[1], "label") };
}

/** `Option<(AccountId, Vec<u8>)>`: the parent of an account and the label it gave, or nothing. */
export function decodeParent(raw: Json): Member | null {
  return orNull(raw, decodeMember);
}

/** A field key as the chain's JSON gives it: `{ typed: "Email" }`, `{ custom: "0x…" }`, `{ link: 3 }`. */
export function decodeRef(raw: Json): AttestationRef {
  if (raw && typeof raw === "object") {
    if (typeof raw.typed === "string" && raw.typed in FIELD_LABELS) return { typed: raw.typed as FieldKind };
    if (typeof raw.custom === "string") return { custom: hexText(raw.custom, "field key") };
    if ("link" in raw) return { link: num(raw.link, "link id") };
  }
  return fail("field key");
}

function decodeRevoked(raw: Json): { block: number; reason: string } | null {
  return orNull(raw, (r) =>
    Array.isArray(r) && typeof r[1] === "string" ? { block: num(r[0], "revocation block"), reason: r[1] } : fail("revocation"),
  );
}

/** `Method`: a bare name, or `{ name: null }`, or `{ name: {…} }` for the migrated one. */
function decodeMethod(raw: Json): { method: string; migrated?: Attestation["migrated"] } {
  const name = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  if (typeof raw === "string") return { method: name(raw) };
  const [k, data] = raw && typeof raw === "object" ? Object.entries(raw)[0] ?? [] : [];
  if (typeof k !== "string") return fail("method");
  if (data && typeof data === "object") {
    const d = data as Json;
    return { method: name(k), migrated: { source: String(d.source), registrar: num(d.registrar, "registrar"), block: num(d.block, "source block") } };
  }
  return { method: name(k) };
}

function decodeAttestation(entry: Json): Attestation {
  if (!Array.isArray(entry) || entry.length !== 4) return fail("attestation");
  const [ref, authority, att, valid] = entry;
  const verdict = att?.verdict;
  if (verdict !== "Verified" && verdict !== "Rejected") return fail("verdict");
  const { method, migrated } = decodeMethod(att.method);
  return {
    ref: decodeRef(ref),
    authority: num(authority, "authority"),
    commitment: hash(att.commitment, "commitment"),
    verdict,
    method,
    ...(migrated ? { migrated } : {}),
    issuedAt: num(att.issuedAt, "issue block"),
    expiresAt: orNull(att.expiresAt, (v) => num(v, "expiry block")),
    revoked: decodeRevoked(att.revoked),
    valid: valid === true,
  };
}

function decodeFact(entry: Json): Fact {
  if (!Array.isArray(entry) || entry.length !== 4) return fail("fact");
  const [kind, authority, fact, active] = entry;
  if (kind !== "DocumentChecked" && kind !== "Fraud") return fail("fact kind");
  return {
    kind,
    authority: num(authority, "authority"),
    issuedAt: num(fact?.issuedAt, "issue block"),
    expiresAt: orNull(fact.expiresAt, (v) => num(v, "expiry block")),
    reason: String(fact.reason),
    note: hexText(fact.note, "note"),
    revoked: decodeRevoked(fact.revoked),
    active: active === true,
  };
}

function decodeImported(raw: Json): Imported {
  if (!Array.isArray(raw?.judgements)) return fail("migration history");
  return {
    source: String(raw.source),
    block: num(raw.block, "source block"),
    blockHash: hash(raw.blockHash, "source block hash"),
    judgements: raw.judgements.map((j: Json) => ({ registrar: num(j?.[0], "registrar"), judgement: String(j?.[1]) })),
  };
}

function decodeField(ref: FieldRef, raw: Json, kind: FieldKind | null): Omit<ProfileField, "verified" | "rejected"> {
  const id = key(ref);
  const label = kind ? FIELD_LABELS[kind] : (ref as { custom: string }).custom;
  if (raw && typeof raw === "object" && "private" in raw) {
    return { ref, id, label, privacy: "private", value: null, bytes: null, commitment: hash(raw.private, "private commitment") };
  }
  const bytes = hexBytes(raw?.public, "field value");
  // a PGP fingerprint is raw bytes, never text
  const value = kind === "Pgp" ? u8aToHex(bytes).slice(2).toUpperCase() : hexToString(raw.public);
  return { ref, id, label, privacy: "public", value, bytes, commitment: publicCommitment(bytes) };
}

/** The `ProfileView` the runtime API returns, for the account `address`. */
export function decodeProfile(address: string, raw: Json): Profile {
  const identity = raw?.identity;
  if (!identity || typeof identity !== "object") return fail("profile");
  const trust = TRUST_LEVELS.includes(raw.trustLevel) ? (raw.trustLevel as TrustLevel) : fail("trust level");
  if (!Array.isArray(raw.attestations) || !Array.isArray(raw.facts) || !Array.isArray(raw.subs)) return fail("profile lists");

  const attestations = raw.attestations.map(decodeAttestation);
  // The runtime already folded expiry, revocation and value changes into `valid`.
  const flags = (id: string) => {
    const valid = attestations.filter((a: Attestation) => a.valid && key(a.ref) === id);
    const rejected = valid.some((a: Attestation) => a.verdict === "Rejected");
    return { verified: !rejected && valid.some((a: Attestation) => a.verdict === "Verified"), rejected };
  };

  const typed = Object.entries<Json>(identity.typed ?? {})
    .map(([kind, value]) => {
      if (!(kind in FIELD_LABELS)) return fail("field kind");
      return decodeField({ typed: kind as FieldKind }, value, kind as FieldKind);
    })
    .sort((a, b) => KIND_ORDER.indexOf((a.ref as { typed: string }).typed) - KIND_ORDER.indexOf((b.ref as { typed: string }).typed));
  const custom = Object.entries<Json>(identity.custom ?? {}).map(([hexKey, value]) =>
    decodeField({ custom: hexText(hexKey, "field key") }, value, null),
  );
  const fields = [...typed, ...custom].map((f) => ({ ...f, ...flags(f.id) }));

  const links = (identity.links ?? []).map((l: Json) => {
    const id = num(l?.id, "link id");
    return { id, title: hexText(l.title, "link title"), url: hexText(l.url, "link url"), ...flags(`link:${id}`) };
  });

  return {
    address: toIdentitee(address),
    name: orNull(raw.name, (v) => hexText(v, "name")),
    trust,
    bio: hexText(identity.bio, "bio"),
    avatar: orNull(identity.avatar, (v) => hexBytes(v, "avatar")),
    fields,
    links,
    attestations,
    facts: raw.facts.map(decodeFact),
    parent: orNull(raw.parent, decodeMember),
    subs: decodeMembers(raw.subs),
    imported: orNull(raw.imported, decodeImported),
    createdAt: num(identity.createdAt, "creation block"),
    updatedAt: num(identity.updatedAt, "update block"),
  };
}

/** `NameStatus`: `{ available: null }`, `{ taken: address }`, `{ quarantined: { until } }`... */
export function decodeNameStatus(raw: Json): NameStatus {
  const [state, data] = raw && typeof raw === "object" ? Object.entries(raw)[0] ?? [] : [];
  switch (state) {
    case "invalid":
    case "reserved":
    case "available":
      return { state };
    case "taken":
      return { state, owner: toIdentitee(data as string) };
    case "quarantined":
      return { state, until: num((data as Json)?.until, "quarantine block") };
    default:
      return fail("name status");
  }
}

/** SCALE `Option<Vec<u8>>`: `0x00`, or `0x01` then a compact length and the bytes. */
export function decodeOptionBytes(raw: Uint8Array): Uint8Array | null {
  if (raw.length === 1 && raw[0] === 0) return null;
  if (raw[0] !== 1) return fail("optional bytes");
  const [prefix, length] = compactFromU8a(raw.subarray(1));
  const body = raw.subarray(1 + prefix);
  return body.length === Number(length) ? Uint8Array.from(body) : fail("optional bytes length");
}

// --- Readers -----------------------------------------------------------------------------------

/** `api.call.identiteeApi`, which polkadot.js has no static types for. */
const runtime = (api: Reader): Json => (api.call as Json).identiteeApi;

const toJson = (value: { toJSON(): unknown }): Json => JSON.parse(JSON.stringify(value.toJSON()));

/** The profile of any account (any address format), `null` if it has no identity. `at`: read at
 * that block (`snapshot`) rather than now; the same for the readers below that take it. */
export async function readProfile(address: string | Uint8Array, at?: Reader): Promise<Profile | null> {
  const api = await reader(at);
  const raw = toJson(await runtime(api).profile(publicKeyHex(address)));
  return raw === null ? null : decodeProfile(toIdentitee(address), raw);
}

/** Its trust level, `null` if it has no identity. */
export async function trustLevel(address: string | Uint8Array): Promise<TrustLevel | null> {
  const api = await connect();
  return decodeTrustLevel(toJson(await runtime(api).trustLevel(publicKeyHex(address))));
}

/** Whether a name can be claimed now, and why not. */
export async function nameStatus(name: string): Promise<NameStatus> {
  const api = await connect();
  return decodeNameStatus(toJson(await runtime(api).nameStatus(stringToHex(name))));
}

/** The account owning `name`, `null` if nobody does. */
export async function resolveName(name: string): Promise<string | null> {
  const api = await connect();
  const owner = toJson(await runtime(api).resolveName(stringToHex(name)));
  return owner === null ? null : toIdentitee(owner);
}

/** The accepted sub-accounts of `parent`, with their labels. */
export async function subsOf(parent: string | Uint8Array, at?: Reader): Promise<Member[]> {
  const api = await reader(at);
  return decodeMembers(toJson(await runtime(api).subsOf(publicKeyHex(parent))));
}

/** The proposals of `parent` that nobody accepted yet. */
export async function pendingSubsOf(parent: string | Uint8Array, at?: Reader): Promise<Member[]> {
  const api = await reader(at);
  return decodeMembers(toJson(await runtime(api).pendingSubsOf(publicKeyHex(parent))));
}

/** The parent `address` is an accepted member of, `null` if it has none. An account needs no
 * identity to be a sub-account, so this is not read from the profile. */
export async function parentOf(address: string | Uint8Array, at?: Reader): Promise<Member | null> {
  const api = await reader(at);
  return decodeParent(toJson(await runtime(api).parentOf(publicKeyHex(address))));
}

/** The proposals `sub` has received: the parents that asked it to join, with their labels. */
export async function proposalsTo(sub: string | Uint8Array, at?: Reader): Promise<Member[]> {
  const api = await reader(at);
  const entries = await (api.query as Json).identitee.subProposals.entries(publicKeyHex(sub));
  return entries.map(([storageKey, label]: [Json, Json]) => ({
    address: toIdentitee(storageKey.args[1]!.toString()),
    label: u8aToString(label.toU8a(true)),
  }));
}

/**
 * The encrypted identity secret `address` stored, `null` if it has none. Read through `state_call`
 * and decoded here: `api.call` decodes the runtime's `Option<Vec<u8>>` answer into polkadot.js's
 * text class (`Type`), so a stored blob comes back as other bytes (seen on a dev node) and `None`
 * as text. `state_call` returns the raw SCALE, as `Bytes` whose bare bytes are the `Option`.
 */
export async function identitySecret(address: string | Uint8Array): Promise<Uint8Array | null> {
  const api = await connect();
  const answer = await api.rpc.state.call("IdentiteeApi_identity_secret", publicKeyHex(address));
  return decodeOptionBytes(answer.toU8a(true));
}
