// What an authority agent works on: the requests waiting for its authority, an account looked up by
// address (its facts, the verifications the authority gave it, its username), the reserved names,
// and the check of a verification packet. The decoders and decisions are pure and tested; the
// readers at the bottom fetch.
//
// There is no index of requests by authority: the inbox walks the whole `pendingRequests` table
// and keeps its authority's rows (at most 16 per account, few accounts on a young chain). Rows and
// the identities they point at are read at one block, so a row never shows a value of another moment.
//
// A verdict is tied to the value it was made for: `provide_judgement` takes the commitment the
// agent expects and the runtime refuses it if the field holds another one. The page reads that
// commitment from the chain just before each verdict (`commitmentNow`), never from what it showed.

import { hexToU8a } from "@polkadot/util";
import { connect } from "./api.ts";
import { publicKeyHex, sameAccount, toIdentitee } from "./address.ts";
import { groupHex } from "./edit.ts";
import { type Hex, linkCommitment, privateCommitment } from "./formulas.ts";
import { type AttestationRef, type Fact, FIELD_LABELS, type FieldRef, type Profile, readProfile, refId } from "./identity.ts";
import { readPacket } from "./packet.ts";
import { type Reader, reader, snapshot } from "./reader.ts";
import { decodeTarget, type RequestTarget, targetId } from "./requests.ts";

type Json = any;

// --- Requests ----------------------------------------------------------------------------------

export interface InboxRequest {
  /** Prefix 2426. */
  who: string;
  target: RequestTarget;
  /** The block the request was made at. */
  since: number;
}

/** What the agent can do with a request, from what the identity holds now:
 * `public` and `link`: verify at once; `private`: verify once a packet checks out;
 * `document`: record the identity document; `fraud`: only reject (a fraud finding is recorded from
 * the Accounts section, never as an answer to a request); `gone`: the field left the identity, so
 * there is nothing to verify, only the request to reject. */
export type InboxKind = "public" | "private" | "link" | "document" | "fraud" | "gone";

export interface InboxItem extends InboxRequest {
  /** `who` and `targetId`, unique in the inbox. */
  id: string;
  kind: InboxKind;
  label: string;
  /** The public value, or the address of a link; `null` otherwise. */
  value: string | null;
  /** What the field or link holds, as read with the inbox: a verdict is for this value only.
   * `null` for a fact or a field that is gone. */
  commitment: Hex | null;
  /** The requester's identity at the block the inbox was read, `null` if it has none. */
  profile: Profile | null;
}

/**
 * The rows of `pendingRequests`, each `{ who, key: [authority, target], since }` as polkadot.js gives
 * them in JSON, reduced to the requests made to `authority`, oldest first.
 */
export function decodeInbox(rows: readonly { who: string; key: Json; since: Json }[], authority: number): InboxRequest[] {
  return rows
    .map((row) => {
      const [id, target] = Array.isArray(row.key) ? row.key : [];
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(row.since)) throw new Error("Unexpected answer from the chain: request.");
      return { authority: id as number, request: { who: toIdentitee(row.who), target: decodeTarget(target), since: row.since as number } };
    })
    .filter((r) => r.authority === authority)
    .map((r) => r.request)
    .sort((a, b) => a.since - b.since);
}

const fieldLabel = (ref: FieldRef): string => ("typed" in ref ? FIELD_LABELS[ref.typed] : ref.custom);

/** A request with what the identity holds for it. */
export function inboxItem(request: InboxRequest, profile: Profile | null): InboxItem {
  const { target } = request;
  const commitment = "field" in target ? (commitmentIn(profile, target.field)?.commitment ?? null) : null;
  const base = { ...request, id: `${request.who}|${targetId(target)}`, profile, commitment };
  if ("fact" in target) {
    return target.fact === "DocumentChecked"
      ? { ...base, kind: "document", label: "Identity document", value: null }
      : { ...base, kind: "fraud", label: "Fraud", value: null };
  }
  const ref = target.field;
  if ("link" in ref) {
    const link = profile?.links.find((l) => l.id === ref.link);
    return link ? { ...base, kind: "link", label: link.title, value: link.url } : { ...base, kind: "gone", label: `Link ${ref.link}`, value: null };
  }
  const field = profile?.fields.find((f) => f.id === refId(ref));
  if (!field) return { ...base, kind: "gone", label: fieldLabel(ref), value: null };
  if (field.privacy === "private") return { ...base, kind: "private", label: field.label, value: null };
  return { ...base, kind: "public", label: field.label, value: field.id === "typed:Pgp" && field.value ? groupHex(field.value) : field.value };
}

/** The commitment field or link `ref` of `profile` holds, and whether it is private; `null` if the
 * identity does not have it. */
export function commitmentIn(profile: Profile | null, ref: AttestationRef): { commitment: Hex; private: boolean } | null {
  if (profile === null) return null;
  if ("link" in ref) {
    const link = profile.links.find((l) => l.id === ref.link);
    return link ? { commitment: linkCommitment(link.title, link.url), private: false } : null;
  }
  const field = profile.fields.find((f) => f.id === refId(ref));
  return field ? { commitment: field.commitment, private: field.privacy === "private" } : null;
}

// --- An account ----------------------------------------------------------------------------------

export type FactKind = Fact["kind"];
export const FACT_KINDS: readonly FactKind[] = ["DocumentChecked", "Fraud"];

/** A fact the authority recorded about a person, as it stands at `block`. */
export interface FactState {
  state: "active" | "revoked" | "expired";
  issuedAt: number;
}

/** A row of `facts`, `{ issuedAt, expiresAt, reason, note, revoked }`, at block `block`. */
export function decodeFactState(raw: Json, block: number): FactState | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isSafeInteger(raw.issuedAt)) throw new Error("Unexpected answer from the chain: fact.");
  // valid up to and including `expiresAt` (`has_expired` in attestations.rs)
  const state = raw.revoked !== null && raw.revoked !== undefined ? "revoked" : raw.expiresAt !== null && raw.expiresAt !== undefined && block > raw.expiresAt ? "expired" : "active";
  return { state, issuedAt: raw.issuedAt };
}

export interface Account {
  address: string;
  /** `null` if it has no identity (facts outlive an identity, so they are read all the same). */
  profile: Profile | null;
  facts: Record<FactKind, FactState | null>;
}

// --- The verification packet of a private field --------------------------------------------------

export interface CheckedPacket {
  /** The value, as the agent reads it (a PGP fingerprint in groups of four). */
  value: string;
  /** The commitment on chain that the value and salt give. */
  commitment: Hex;
}

/**
 * Whether a pasted packet proves field `ref` of `who` as the chain holds it now: signed by the
 * account it names (`readPacket`), that account is the requester, the field is the one requested,
 * the chain is this one, the field is still private, and its value and salt give the commitment
 * the chain holds now. `profile` is the requester's identity read just now; `genesis` this
 * chain's genesis hash. Neither the packet nor what it holds is kept or sent anywhere.
 */
export async function checkPacket(text: string, who: string, ref: FieldRef, genesis: Hex, profile: Profile | null): Promise<CheckedPacket | { problem: string }> {
  const read = await readPacket(text);
  if ("problem" in read) return read;
  const { packet, value } = read;
  if (!sameAccount(packet.address, who)) return { problem: "This packet is signed by another account than the one that asked." };
  if (refId(packet.field) !== refId(ref)) return { problem: `This packet is for ${fieldLabel(packet.field)}, not ${fieldLabel(ref)}.` };
  if (packet.chain.toLowerCase() !== genesis.toLowerCase()) return { problem: "This packet was made for another chain." };
  const now = commitmentIn(profile, ref);
  if (now === null) return { problem: "That field is no longer on the identity." };
  if (!now.private) return { problem: "That field is public now: verify it without a packet." };
  if (privateCommitment(hexToU8a(packet.salt), value) !== now.commitment) {
    return { problem: "The packet does not match the field on chain. The person may have changed it since." };
  }
  return { value: "typed" in ref && ref.typed === "Pgp" ? groupHex(packet.value.slice(2).toUpperCase()) : packet.value, commitment: now.commitment };
}

// --- Readers -------------------------------------------------------------------------------------

/** The requests waiting for `authority`, oldest first, each with the requester's identity, all read
 * at one block. */
export async function readInbox(authority: number): Promise<InboxItem[]> {
  const at = await snapshot();
  const entries = await (at.query as Json).identitee.pendingRequests.entries();
  const requests = decodeInbox(
    entries.map(([key, block]: [Json, Json]) => ({ who: key.args[0].toString(), key: key.args[1].toJSON(), since: block.toJSON() })),
    authority,
  );
  const people = [...new Set(requests.map((r) => r.who))];
  const profiles = new Map(await Promise.all(people.map(async (who) => [who, await readProfile(who, at)] as const)));
  return requests.map((r) => inboxItem(r, profiles.get(r.who) ?? null));
}

/** The commitment field or link `ref` of `who` holds now, read from the chain at this moment. */
export async function commitmentNow(who: string, ref: AttestationRef): Promise<{ commitment: Hex; private: boolean } | null> {
  return commitmentIn(await readProfile(who), ref);
}

/** The identity of `who` now, `null` if it has none. */
export const profileNow = (who: string): Promise<Profile | null> => readProfile(who);

/** This chain's genesis hash, which a packet names. */
export async function genesisHash(): Promise<Hex> {
  return (await connect()).genesisHash.toHex() as Hex;
}

/** An account as the authority sees it: its identity, and the facts `authority` recorded, at one block. */
export async function readAccount(address: string, authority: number): Promise<Account> {
  const at = await snapshot();
  const query = (at.query as Json).identitee;
  const key = publicKeyHex(address);
  const [profile, block, document, fraud] = await Promise.all([
    readProfile(address, at),
    (at.query as Json).system.number(),
    query.facts(key, ["DocumentChecked", authority]),
    query.facts(key, ["Fraud", authority]),
  ]);
  const now = block.toJSON() as number;
  return {
    address: toIdentitee(address),
    profile,
    facts: { DocumentChecked: decodeFactState(document.toJSON(), now), Fraud: decodeFactState(fraud.toJSON(), now) },
  };
}

/** The names only an authority can give, in alphabetical order. */
export async function readReserved(at?: Reader): Promise<string[]> {
  const api = await reader(at);
  const entries = await (api.query as Json).identitee.reserved.entries();
  return entries.map(([key]: [Json]) => new TextDecoder().decode(key.args[0].toU8a(true))).sort();
}
