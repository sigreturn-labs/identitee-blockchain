// The calls of the pages, built from what the person typed or chose. Each returns an extrinsic for
// `tx.send` to sign: nothing is sent here. Identity calls are free, so none of them asks the node
// for a fee.
//
// Text goes to the chain as the hexadecimal of its UTF-8 bytes. Bio and titles are trimmed, an
// address gets `https://` when it has no scheme (the same `normalizeUrl` the form checked with).

import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { compactToU8a, stringToHex, u8aConcat, u8aToHex } from "@polkadot/util";
import { fieldSalt } from "../crypto/secret.ts";
import { checkAvatar } from "../media/webp.ts";
import { connect } from "./api.ts";
import { isAddress, publicKeyHex } from "./address.ts";
import { byteLength, chainChange, fieldKey, type FieldChange, LIMITS, needsSecret, normalizeUrl } from "./edit.ts";
import { type Hex, SALT_LENGTH } from "./formulas.ts";
import type { AttestationRef, Fact, FieldRef } from "./identity.ts";
import { SOURCES, type Source } from "./markers.ts";
import { nameProblem, ruleProblem } from "./name.ts";
import { Refusal } from "./refusal.ts";
import type { RequestTarget } from "./requests.ts";
import { subLabelProblem } from "./subs.ts";

export type Call = SubmittableExtrinsic<"promise">;

/** `api.tx.identitee`, which polkadot.js has no static types for. */
const identitee = async (): Promise<any> => (await connect()).tx.identitee;

/** Every field change in one call, so one signature. A private value goes as its commitment under
 * the salt derived from `secret` for its field. */
export async function setIdentityCall(changes: readonly FieldChange[], secret?: Uint8Array | null): Promise<Call> {
  if (changes.length === 0) throw new Refusal("There is nothing to save.");
  if (changes.length > LIMITS.changes) throw new Refusal("Too many changes at once. Save fewer fields.");
  if (needsSecret(changes) && !secret) throw new Refusal("Unlock your identity secret first.");
  const saltOf = secret ? (ref: FieldRef) => fieldSalt(secret, ref) : undefined;
  return (await identitee()).setIdentity(changes.map((change) => chainChange(change, saltOf)));
}

/** A link as the profile form ends up with it: an existing one (`id`), kept or changed, or a new one. */
export type LinkEdit = { keep: number } | { update: number; title: string; url: string } | { add: true; title: string; url: string };

/** Everything the profile form changes, in one `update_profile`: `undefined` keeps that part as it is. */
export interface ProfileUpdate {
  bio?: string;
  /** `null` removes the avatar. */
  avatar?: Uint8Array | null;
  fields: readonly FieldChange[];
  /** The links exactly as they must be, in order. */
  links?: readonly LinkEdit[];
  /** A new identity secret, encrypted, stored in the same call as the private fields it salts. */
  secretBlob?: Uint8Array;
}

/** The number of things a profile update changes, for the Save button. */
export const updateSize = (update: ProfileUpdate): number =>
  (update.bio !== undefined ? 1 : 0) + (update.avatar !== undefined ? 1 : 0) + update.fields.length + (update.links !== undefined ? 1 : 0) + (update.secretBlob ? 1 : 0);

/** The avatar part of `update_profile`, `Option<Option<Bytes>>`, as its SCALE bytes: polkadot.js
 * reads an object or a nested `Option` given for it as the outer one, which would turn "remove the
 * avatar" into "keep it", and a set into an invalid image. Raw bytes are taken as they are. */
export function avatarChange(avatar: Uint8Array | null): Uint8Array {
  return avatar === null ? new Uint8Array([1, 0]) : u8aConcat([1, 1], compactToU8a(avatar.length), avatar);
}

/** One signature for the bio, the avatar, the fields, the links and a new identity secret. A private
 * value goes as its commitment under the salt derived from `secret` for its field. */
export async function updateProfileCall(update: ProfileUpdate, secret?: Uint8Array | null): Promise<Call> {
  const { bio, avatar, fields, links, secretBlob } = update;
  if (bio === undefined && avatar === undefined && fields.length === 0 && links === undefined && !secretBlob) throw new Refusal("There is nothing to save.");
  if (fields.length > LIMITS.changes) throw new Refusal("Too many changes at once. Save fewer fields.");
  if (needsSecret(fields) && !secret) throw new Refusal("Unlock your identity secret first.");
  if (links && links.length > LIMITS.links) throw new Refusal("You have reached the limit of links.");
  if (avatar) checkAvatar(avatar);
  if (secretBlob && (secretBlob.length === 0 || secretBlob.length > LIMITS.secretBlob)) throw new Refusal("The encrypted secret has the wrong size.");
  const saltOf = secret ? (ref: FieldRef) => fieldSalt(secret, ref) : undefined;
  const text = (title: string, url: string) => ({ title: stringToHex(title.trim()), url: stringToHex(normalizeUrl(url)) });
  return (await identitee()).updateProfile({
    bio: bio === undefined ? null : stringToHex(bio.trim()),
    avatar: avatar === undefined ? null : avatarChange(avatar),
    fields: fields.map((change) => chainChange(change, saltOf)),
    links:
      links === undefined
        ? null
        : links.map((link) =>
            "keep" in link ? { Keep: link.keep } : "update" in link ? { Update: { id: link.update, ...text(link.title, link.url) } } : { Add: text(link.title, link.url) },
          ),
    secret: secretBlob ? u8aToHex(secretBlob) : null,
  });
}

/** Store the encrypted identity secret (opaque to the chain), replacing the one there was. */
export async function setIdentitySecretCall(blob: Uint8Array): Promise<Call> {
  if (blob.length === 0 || blob.length > LIMITS.secretBlob) throw new Refusal("The encrypted secret has the wrong size.");
  return (await identitee()).setIdentitySecret(u8aToHex(blob));
}

/** Make a private field public: the chain checks that `value` and `salt` give its commitment. */
export async function revealFieldCall(ref: FieldRef, value: Uint8Array, salt: Uint8Array): Promise<Call> {
  if (salt.length !== SALT_LENGTH) throw new Refusal(`The salt must be ${SALT_LENGTH} bytes.`);
  return (await identitee()).revealField(fieldKey(ref), u8aToHex(value), u8aToHex(salt));
}

export async function setBioCall(bio: string): Promise<Call> {
  return (await identitee()).setBio(stringToHex(bio.trim()));
}

export async function addLinkCall(title: string, url: string): Promise<Call> {
  return (await identitee()).addLink(stringToHex(title.trim()), stringToHex(normalizeUrl(url)));
}

export async function updateLinkCall(id: number, title: string, url: string): Promise<Call> {
  return (await identitee()).updateLink(id, stringToHex(title.trim()), stringToHex(normalizeUrl(url)));
}

export async function removeLinkCall(id: number): Promise<Call> {
  return (await identitee()).removeLink(id);
}

/** `ids` lists every link of the identity once, in the order wanted. */
export async function reorderLinksCall(ids: readonly number[]): Promise<Call> {
  return (await identitee()).reorderLinks([...ids]);
}

/** Throws an `AvatarError` (with a sentence for the person) for anything the runtime would refuse:
 * what leaves here is a 64 by 64 WebP of at most 8 192 bytes, whoever calls. */
export async function setAvatarCall(webp: Uint8Array): Promise<Call> {
  checkAvatar(webp);
  return (await identitee()).setAvatar(u8aToHex(webp));
}

export async function clearAvatarCall(): Promise<Call> {
  return (await identitee()).clearAvatar();
}

// --- Requests, username, sub-accounts, migration -------------------------------------------------

/** `Target` as the chain takes it: `Field(FieldKey)` or `Fact(kind)`. */
function chainTarget(target: RequestTarget): object {
  if ("fact" in target) return { Fact: target.fact };
  const ref = target.field;
  return { Field: "link" in ref ? { Link: ref.link } : fieldKey(ref) };
}

/** Ask `authority` to check a field, a link or a fact about the person. */
export async function requestJudgementCall(authority: number, target: RequestTarget): Promise<Call> {
  return (await identitee()).requestJudgement(authority, chainTarget(target));
}

/** Withdraw a request, to the authority it was made to. */
export async function cancelRequestCall(authority: number, target: RequestTarget): Promise<Call> {
  return (await identitee()).cancelRequest(authority, chainTarget(target));
}

/** Throws the sentence for a name that cannot be claimed (the alphabet, the length, the pages of the app). */
export async function claimUsernameCall(name: string): Promise<Call> {
  const problem = nameProblem(name);
  if (problem !== null) throw new Refusal(problem);
  return (await identitee()).claimUsername(stringToHex(name));
}

export async function releaseUsernameCall(): Promise<Call> {
  return (await identitee()).releaseUsername();
}

/** An account is named by its public key, whatever the prefix of the address typed. */
function accountKey(address: string): string {
  if (!isAddress(address)) throw new Refusal("That is not a valid account address.");
  return publicKeyHex(address);
}

function labelHex(label: string): string {
  const problem = subLabelProblem(label);
  if (problem !== null) throw new Refusal(problem);
  return stringToHex(label.trim());
}

/** Propose `address` as a sub-account, under a label. It joins once it accepts. */
export async function addSubCall(address: string, label: string): Promise<Call> {
  return (await identitee()).addSub(accountKey(address), labelHex(label));
}

/** Accept the proposal `parent` made to the caller. */
export async function acceptSubCall(parent: string): Promise<Call> {
  return (await identitee()).acceptSub(accountKey(parent));
}

/** Refuse the proposal `parent` made to the caller. */
export async function declineSubCall(parent: string): Promise<Call> {
  return (await identitee()).declineSub(accountKey(parent));
}

/** Withdraw a proposal to `sub`, or end its accepted link. */
export async function removeSubCall(sub: string): Promise<Call> {
  return (await identitee()).removeSub(accountKey(sub));
}

/** Leave the parent the caller is a sub-account of. */
export async function quitSubCall(): Promise<Call> {
  return (await identitee()).quitSub();
}

export async function renameSubCall(sub: string, label: string): Promise<Call> {
  return (await identitee()).renameSub(accountKey(sub), labelHex(label));
}

/** Ask the migration service to import the identity this account holds on a People Chain. */
export async function requestMigrationCall(source: Source): Promise<Call> {
  if (!SOURCES.includes(source)) throw new Refusal("Choose Polkadot or Kusama.");
  return (await identitee()).requestMigration(source);
}

export async function cancelMigrationCall(): Promise<Call> {
  return (await identitee()).cancelMigration();
}

// --- Authority agents ------------------------------------------------------------------------------
// Only an agent of an active authority holding the capability can make these, and they are free for
// it; the chain judges each call.

/** Why a refusal, a revocation or a fact is recorded (`ReasonCode`, pallets/identitee/src/types.rs). */
export const REASONS = {
  Unspecified: "No reason given",
  ValueMismatch: "The value does not match",
  Disposable: "Disposable or unreliable",
  Impersonation: "Impersonation",
  DocumentInvalid: "Invalid document",
  UserRequest: "Asked by the person",
  Abuse: "Abuse",
  Other: "Other",
} as const;

export type Reason = keyof typeof REASONS;

/** A field, a custom field or a link, as `FieldKey`. */
function chainKey(ref: AttestationRef): object {
  return "link" in ref ? { Link: ref.link } : fieldKey(ref);
}

function reasonOf(reason: Reason): Reason {
  if (!Object.hasOwn(REASONS, reason)) throw new Refusal("Choose a reason.");
  return reason;
}

function noteHex(note: string): string {
  if (byteLength(note.trim()) > LIMITS.note) throw new Refusal(`A note has at most ${LIMITS.note} bytes.`);
  return stringToHex(note.trim());
}

export type Verdict = "Verified" | "Rejected";

/** Record the authority's verdict on field or link `ref` of `who`, checked by hand, for good:
 * `Verified`, or `Rejected` (the value was checked and refused; it counts as not verified while the
 * field keeps it). The verdict holds while the field keeps the commitment `expected`, which the
 * caller read from the chain just before. */
export async function provideJudgementCall(who: string, ref: AttestationRef, expected: Hex, verdict: Verdict = "Verified"): Promise<Call> {
  if (!/^0x[0-9a-f]{64}$/i.test(expected)) throw new Refusal("The commitment of the field could not be read.");
  if (verdict !== "Verified" && verdict !== "Rejected") throw new Refusal("Choose a verdict.");
  return (await identitee()).provideJudgement(accountKey(who), chainKey(ref), expected, verdict, "Manual", null);
}

/** Refuse the request of `who` for `target`, with a reason and a short note carried by the event. */
export async function rejectRequestCall(who: string, target: RequestTarget, reason: Reason, note: string): Promise<Call> {
  return (await identitee()).rejectRequest(accountKey(who), chainTarget(target), reasonOf(reason), noteHex(note));
}

/** Withdraw the authority's verification (or refusal) of field or link `ref` of `who`. */
export async function revokeAttestationCall(who: string, ref: AttestationRef, reason: Reason): Promise<Call> {
  return (await identitee()).revokeAttestation(accountKey(who), chainKey(ref), reasonOf(reason));
}

/** Record a fact about the person behind `who`, with no end date. */
export async function grantFactCall(who: string, kind: Fact["kind"], reason: Reason, note: string): Promise<Call> {
  return (await identitee()).grantFact(accountKey(who), kind, null, reasonOf(reason), noteHex(note));
}

export async function revokeFactCall(who: string, kind: Fact["kind"], reason: Reason): Promise<Call> {
  return (await identitee()).revokeFact(accountKey(who), kind, reasonOf(reason));
}

/** An authority may reserve or free any name the runtime accepts, the pages of the app included. */
function ruleNameHex(name: string): string {
  const problem = ruleProblem(name);
  if (problem !== null) throw new Refusal(problem);
  return stringToHex(name);
}

export async function reserveUsernameCall(name: string): Promise<Call> {
  return (await identitee()).reserveUsername(ruleNameHex(name));
}

export async function unreserveUsernameCall(name: string): Promise<Call> {
  return (await identitee()).unreserveUsername(ruleNameHex(name));
}

/** Give `name` to `who`. A page name is refused: its profile would never show at `/name`. */
export async function setUsernameForCall(who: string, name: string): Promise<Call> {
  const problem = nameProblem(name);
  if (problem !== null) throw new Refusal(problem);
  return (await identitee()).setUsernameFor(accountKey(who), stringToHex(name));
}

/** Take the username of `who` away; it goes into quarantine. */
export async function unbindUsernameCall(who: string, reason: Reason): Promise<Call> {
  return (await identitee()).unbindUsername(accountKey(who), reasonOf(reason));
}
