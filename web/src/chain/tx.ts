// Sending a transaction and telling the person, in plain English, what happened.
//
// Identity calls are free for the person, so nothing here computes, asks for or shows a fee. A
// call that cannot be made free (the daily quota is used up) is refused by the transaction pool
// with "Payment", which `describeRejection` turns into the daily limit message.

import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { ISubmittableResult, IKeyringPair, Signer } from "@polkadot/types/types";

/** An account that signs through a wallet extension. */
export interface Signing {
  address: string;
  signer: Signer;
}

/** Who signs: a wallet account, or a keyring pair (dev keys, tests). */
export type SignAs = Signing | IKeyringPair;

export interface ChainEvent {
  section: string;
  method: string;
  data: unknown;
}

export interface SendResult {
  /** The extrinsic was included in a block and succeeded. */
  ok: boolean;
  events: ChainEvent[];
  /** A short English sentence for the person, when `ok` is false. */
  error?: string;
  /** The pallet error (`NameTaken`) or one of `DailyLimit`, `Cancelled`, `Dropped`, `Timeout`...;
   * for an error nobody planned for, the first line of what the node or the wallet said. */
  errorName?: string;
  blockHash?: string;
}

/** Longest wait for a block once the wallet has signed. */
const INCLUSION_TIMEOUT_MS = 90_000;

/** Longest first line of an unplanned error kept as `errorName`. */
const MAX_NAME_LENGTH = 120;

/** What the pallet's errors mean for the person (pallets/identitee/src/lib.rs, `Error`). */
export const ERROR_MESSAGES: Record<string, string> = {
  InvalidUtf8: "That text cannot be stored. Remove unusual characters.",
  InvalidPgp: "A PGP fingerprint must be 20 or 32 bytes.",
  InvalidAvatar: "The avatar must be a 64 by 64 WebP image of at most 8 KB.",
  TooManyCustomFields: "You have reached the limit of custom fields.",
  TooManyLinks: "You have reached the limit of links.",
  UnknownLink: "That link does not exist anymore.",
  InvalidLinkOrder: "The new order does not match your current links.",
  NoIdentity: "This account has no identity yet.",
  NotPrivate: "That field is not private, or it does not exist.",
  RevealMismatch: "The value and secret do not match the field's commitment.",
  LinkKeyNotSettable: "Links are changed with the link actions.",
  UnknownAuthority: "That authority does not exist.",
  TooManyAuthorities: "The maximum number of authorities is reached.",
  NotAnAgent: "This account is not an authority agent.",
  MissingCapability: "This agent is not allowed to do that.",
  AuthorityInactive: "This agent's authority is not active.",
  NoCapabilities: "An agent needs at least one capability.",
  UnknownCapabilities: "Some capabilities do not exist.",
  AgentOfAnotherAuthority: "This account is already an agent of another authority.",
  RequestExists: "You already asked for this check.",
  TooManyRequests: "You have too many pending requests.",
  UnknownRequest: "That request does not exist anymore.",
  FieldNotFound: "That field does not exist.",
  StaleCommitment: "The field changed since it was read. Reload and try again.",
  ExpiryNotInFuture: "The expiry must be in the future.",
  MethodReserved: "That method is reserved for migrations.",
  UnknownAttestation: "There is no verification of that field to revoke.",
  UnknownFact: "There is no such fact to revoke.",
  AlreadyRevoked: "That has already been revoked.",
  NameTooShort: "Names have at least 3 characters.",
  NameTooLong: "Names have at most 32 characters.",
  NameInvalidChar: "Names use only a to z, 0 to 9, hyphens and underscores.",
  NameTaken: "That name is already taken.",
  NameIsReserved: "That name is reserved.",
  NameInQuarantine: "That name was released recently and is not available yet.",
  AlreadyHasName: "You already have a name. Release it first.",
  NoName: "You do not have a name.",
  NoVerifiedField: "Get one field verified before claiming a name.",
  ClaimCooldown: "You released a name recently. Try again tomorrow.",
  AlreadyReserved: "That name is already reserved.",
  NotReserved: "That name is not reserved.",
  SubIsSelf: "An account cannot be its own sub-account.",
  AlreadyProposed: "That account is already your sub-account, or has a proposal from you.",
  ParentIsSub: "A sub-account cannot have sub-accounts.",
  SubIsParent: "An account that has sub-accounts cannot become one.",
  TooManySubs: "You have reached the limit of sub-accounts.",
  NoSuchProposal: "There is no proposal from that account.",
  AlreadyHasParent: "You already belong to a parent. Leave it first.",
  NotYourSub: "That account is not your sub-account.",
  NoParent: "This account is not a sub-account.",
  IdentityExists: "This account already has an identity.",
  MigrationRequestExists: "A migration request is already waiting.",
  NoMigrationRequest: "There is no migration request.",
  MigrationSourceMismatch: "The migration request is for another chain.",
  DuplicateField: "The same field appears twice.",
  DuplicateJudgement: "The same registrar appears twice.",
  DuplicateFieldInBatch: "The same field is changed twice in one save.",
  EmptyUpdate: "There is nothing to save.",
  AlreadyMigrated: "This account has already migrated an identity.",
  FraudFlagged: "A fraud finding blocks this account from claiming a name.",
  EmptySecretBlob: "The identity secret is empty.",
};

/** Other failures of a dispatch, by name. */
const DISPATCH_MESSAGES: Record<string, string> = {
  BadOrigin: "This account is not allowed to make this call.",
  CallFiltered: "This call is not allowed.",
};

/** Calls only an authority agent (or Root) can make, which are never limited by the daily quota:
 * the calls `Call::counts_against_quota` (pallets/identitee/src/quota.rs) answers `false` for.
 * test/tx.test.ts compares the two. */
export const AGENT_CALLS: ReadonlySet<string> = new Set([
  "provideJudgement",
  "revokeAttestation",
  "rejectRequest",
  "grantFact",
  "revokeFact",
  "reserveUsername",
  "unreserveUsername",
  "setUsernameFor",
  "unbindUsername",
  "fulfilMigration",
  "rejectMigration",
  "killIdentity",
  "addAuthority",
  "setAgent",
  "removeAgent",
  "setAuthorityActive",
]);

interface Named {
  method: { section: string; method: string };
}

export interface Rejection {
  name: string;
  message: string;
}

/** An error thrown while signing or submitting, as a name and a sentence for the person. */
export function describeRejection(error: unknown, call: Named): Rejection {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = (error as { code?: unknown } | null)?.code;
  const detail = `${text} ${String((error as { data?: unknown } | null)?.data ?? "")}`;
  const pool = code === 1010 || /^1010:/.test(text);

  if (pool && /Inability to pay|Payment/i.test(detail)) {
    if (call.method.section !== "identitee") {
      return { name: "CannotPay", message: "This account cannot pay for this transaction." };
    }
    return AGENT_CALLS.has(call.method.method)
      ? { name: "NotAllowed", message: "This account is not allowed to make this call." }
      : { name: "DailyLimit", message: "Daily limit reached. Try again tomorrow." };
  }
  if (pool && /stale|outdated/i.test(detail)) {
    return { name: "Outdated", message: "This transaction is outdated. Try again." };
  }
  if (code === 1012 || code === 1013 || code === 1014 || /^101[234]:/.test(text)) {
    return { name: "Duplicate", message: "A similar transaction is already waiting. Try again in a moment." };
  }
  if (/not connected|disconnected|connection/i.test(text)) {
    return { name: "Offline", message: "The connection to the network was lost. Try again." };
  }
  if (/^(cancel|reject)|rejected by user|user (rejected|denied|declined)/i.test(text)) {
    return { name: "Cancelled", message: "Signing was cancelled." };
  }
  // The person gets a plain sentence; the technical first line stays in the name, for the logs.
  const first = text.split("\n")[0]?.trim().slice(0, MAX_NAME_LENGTH);
  return { name: first || "Rejected", message: "The transaction could not be sent." };
}

/** The sentence for a dispatch error of an included extrinsic. */
function describeDispatch(call: SubmittableExtrinsic<"promise">, error: ISubmittableResult["dispatchError"]): Rejection {
  if (!error) return { name: "Failed", message: "The transaction failed." };
  if (error.isModule) {
    const { section, name } = call.registry.findMetaError(error.asModule);
    return { name, message: (section === "identitee" ? ERROR_MESSAGES[name] : undefined) ?? name };
  }
  const name = String(error.type ?? error.toString());
  return { name, message: DISPATCH_MESSAGES[name] ?? name };
}

const eventsOf = (result: ISubmittableResult): ChainEvent[] =>
  result.events.map(({ event }) => ({ section: event.section, method: event.method, data: event.data.toJSON() }));

const isSigning = (as: SignAs): as is Signing => "signer" in as;

export interface SendOptions {
  /** Sign with this nonce instead of the next one the node reports. For sending several
   * transactions of one account at once. */
  nonce?: number;
}

/**
 * Sign `call` and send it; resolve once it is in a block. Never rejects: whatever goes wrong
 * (the person closes the wallet, the daily limit, the network, a pallet error) comes back as
 * `ok: false` with a sentence in `error` and a stable `errorName`.
 */
export function send(call: SubmittableExtrinsic<"promise">, as: SignAs, options: SendOptions = {}): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const finish = (result: SendResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };
    const refuse = ({ name, message }: Rejection, events: ChainEvent[] = []): void =>
      finish({ ok: false, events, error: message, errorName: name });

    const onUpdate = (result: ISubmittableResult): void => {
      // The wallet has signed: from here the wait is the network's, not the person's.
      timer ??= setTimeout(
        () => refuse({ name: "Timeout", message: "The transaction was not confirmed in time. Check again in a moment." }),
        INCLUSION_TIMEOUT_MS,
      );
      if (result.isError) {
        return refuse({ name: result.status.type, message: "The network dropped the transaction. Try again." });
      }
      if (!result.status.isInBlock) return;

      const events = eventsOf(result);
      const succeeded = events.some((e) => e.section === "system" && e.method === "ExtrinsicSuccess");
      const failed = events.some((e) => e.section === "system" && e.method === "ExtrinsicFailed");
      if (succeeded === failed) {
        return refuse({ name: "Unknown", message: "The result of the transaction could not be read." }, events);
      }
      if (failed) return refuse(describeDispatch(call, result.dispatchError), events);
      finish({ ok: true, events, blockHash: result.status.asInBlock.toHex() });
    };

    const started = isSigning(as)
      ? call.signAndSend(as.address, { ...options, signer: as.signer }, onUpdate)
      : call.signAndSend(as, options, onUpdate);
    started
      .then((unsub) => {
        unsubscribe = unsub;
        if (done) unsub();
      })
      .catch((error: unknown) => refuse(describeRejection(error, call)));
  });
}
