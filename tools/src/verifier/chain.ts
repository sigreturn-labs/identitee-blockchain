// The verifier's view of the chain: a typed field of an account as the chain holds it now
// (`identiteeApi.profile`), and the two writes of the agent, `provide_judgement` and
// `grant_fact(DocumentChecked)`, sent one at a time so that the agent's nonce is never contended.
// The commitment a proof started with goes as `expected_commitment`: a field changed meanwhile
// makes the runtime refuse (`StaleCommitment`), which comes back as `stale`.

import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a, isHex, u8aConcat, u8aToHex, u8aToString, stringToU8a } from '@polkadot/util';
import { blake2AsHex, decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { messageOf, submitAndWait } from '../migrator.ts';
import type { Logger } from './log.ts';

export const SS58_PREFIX = 2426;

/** The typed fields a channel can verify. */
export const FIELD_KINDS = ['Email', 'X', 'Discord', 'Matrix', 'Telegram', 'GitHub', 'Web', 'Pgp'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export type FieldKey = { Typed: FieldKind };
export type Method = 'EmailCode' | 'OAuth' | 'MatrixChallenge' | 'PgpSignature' | 'Dns' | 'WebFile' | 'BotChallenge';

/** How the front names each field (web/src/chain/identity.ts). */
export const FIELD_LABELS: Record<FieldKind, string> = {
  Email: 'Email',
  X: 'X',
  Discord: 'Discord',
  Matrix: 'Matrix',
  Telegram: 'Telegram',
  GitHub: 'GitHub',
  Web: 'Website',
  Pgp: 'PGP',
};

export const isFieldKind = (value: unknown): value is FieldKind => typeof value === 'string' && (FIELD_KINDS as readonly string[]).includes(value);

export type AttestResult = { ok: true } | { ok: false; reason: 'stale' | 'gone' | 'failed'; detail?: string };

export interface FieldOnChain {
  /** The public value as text (a PGP fingerprint as lowercase hex without 0x); `null` when private. */
  value: string | null;
  private: boolean;
  /** What the chain holds for the field: the commitment to send as `expected_commitment`. */
  commitment: string;
}

export interface Chain {
  /** Genesis hash, 0x hex. */
  readonly genesis: string;
  /** The 32 bytes of an address of any SS58 prefix (or 0x hex). Throws on anything else. */
  decodeAddress(address: string): Uint8Array;
  /** Field `key` of `address` now, `null` if the account has no identity or no such field. */
  field(address: string, key: FieldKey): Promise<FieldOnChain | null>;
  /** `provide_judgement(who, key, commitment, Verified, method, None)`. */
  attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult>;
  /** `grant_fact(who, DocumentChecked, None, Unspecified, "")`. */
  grantDocument(address: string): Promise<AttestResult>;
  /** Whether `address` has an active `DocumentChecked` fact (any authority); `null` if it has no identity. */
  documentChecked(address: string): Promise<boolean | null>;
}

// --- Formulas (pallets/identitee/src/types.rs, web/src/chain/formulas.ts) -------------------------

const PUBLIC_TAG = stringToU8a('identitee:field:public:v1');
const PRIVATE_TAG = stringToU8a('identitee:field:private:v1');
export const SALT_LENGTH = 32;

export const publicCommitment = (value: Uint8Array): string => blake2AsHex(u8aConcat(PUBLIC_TAG, value), 256);

export function privateCommitment(salt: Uint8Array, value: Uint8Array): string {
  if (salt.length !== SALT_LENGTH) throw new Error(`The salt must be ${SALT_LENGTH} bytes, got ${salt.length}.`);
  return blake2AsHex(u8aConcat(PRIVATE_TAG, salt, value), 256);
}

// --- Addresses ---------------------------------------------------------------------------------

/** The 32 bytes of an address of any SS58 prefix, or of a 0x public key. Throws otherwise. */
export function publicKeyOf(address: string): Uint8Array {
  const text = address.trim();
  let key: Uint8Array;
  try {
    key = isHex(text) ? hexToU8a(text) : decodeAddress(text);
  } catch {
    throw new Error('not an account address');
  }
  if (key.length !== 32) throw new Error('not an account address');
  return key;
}

/** The address with the identitee prefix (2426), `null` if `address` is not one. */
export function canonicalAddress(address: string): string | null {
  try {
    return encodeAddress(publicKeyOf(address), SS58_PREFIX);
  } catch {
    return null;
  }
}

// --- What a refusal means for the person ------------------------------------------------------

/** One sentence for a failed attestation, for the front. */
export function explain(key: FieldKey, result: Exclude<AttestResult, { ok: true }>): string {
  const label = FIELD_LABELS[key.Typed];
  if (result.reason === 'stale') return `Your ${label} changed. Verify it again.`;
  if (result.reason === 'gone') return `Your ${label} is no longer on your identity.`;
  return 'The verification could not be recorded. Try again in a moment.';
}

const STALE = ['identitee.StaleCommitment'];
const GONE = ['identitee.FieldNotFound', 'identitee.NoIdentity'];

/** `Capabilities::ATTEST_FIELDS | PERSON_FACTS` (pallets/identitee/src/types.rs). */
const NEEDED_CAPS = 1 | 2;
const INCLUSION_TIMEOUT_MS = 90_000;

type Json = any;

export class LiveChain implements Chain {
  readonly genesis: string;
  /** The tail of the submission queue: each submission starts when the one before has ended. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: ApiPromise,
    private readonly agent: KeyringPair,
    private readonly log: Logger,
    private readonly options: { inclusionTimeoutMs?: number } = {},
  ) {
    this.genesis = api.genesisHash.toHex();
  }

  /** Fail fast on a node that is not identitee or an agent that cannot attest and record facts. */
  async check(): Promise<void> {
    const spec = this.api.runtimeVersion.specName.toString();
    if (spec !== 'identitee') throw new Error(`the node runs ${spec}, not identitee`);
    const entry = (await (this.api.query as Json).identitee.agents(this.agent.address)).toJSON() as [number, number] | null;
    if (entry === null) throw new Error(`${this.agent.address} is not an agent of any authority`);
    if ((entry[1] & NEEDED_CAPS) !== NEEDED_CAPS) {
      throw new Error(`${this.agent.address} is an agent of authority ${entry[0]} without the capabilities to attest fields and record facts`);
    }
    this.log('info', 'agent', { agent: this.agent.address, authority: entry[0], capabilities: entry[1] });
  }

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    const profile = (await (this.api.call as Json).identiteeApi.profile(u8aToHex(publicKeyOf(address)))).toJSON() as Json;
    const raw = profile?.identity?.typed?.[key.Typed];
    if (raw === undefined || raw === null) return null;
    if (typeof raw.private === 'string') return { value: null, private: true, commitment: raw.private.toLowerCase() };
    if (typeof raw.public !== 'string' || !isHex(raw.public)) throw new Error(`unexpected value of ${key.Typed} on chain`);
    const bytes = hexToU8a(raw.public);
    const value = key.Typed === 'Pgp' ? u8aToHex(bytes).slice(2) : u8aToString(bytes);
    return { value, private: false, commitment: publicCommitment(bytes) };
  }

  async documentChecked(address: string): Promise<boolean | null> {
    const profile = (await (this.api.call as Json).identiteeApi.profile(u8aToHex(publicKeyOf(address)))).toJSON() as Json;
    if (profile === null || profile === undefined) return null;
    const facts: Json[] = Array.isArray(profile.facts) ? profile.facts : [];
    return facts.some((f) => Array.isArray(f) && f[0] === 'DocumentChecked' && f[3] === true);
  }

  attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
    const who = u8aToHex(publicKeyOf(address));
    return this.enqueue(
      () => (this.api.tx as Json).identitee.provideJudgement(who, { Typed: key.Typed }, commitment, 'Verified', method, null),
      { who: encodeAddress(who, SS58_PREFIX), field: key.Typed, method },
    );
  }

  grantDocument(address: string): Promise<AttestResult> {
    const who = u8aToHex(publicKeyOf(address));
    return this.enqueue(() => (this.api.tx as Json).identitee.grantFact(who, 'DocumentChecked', null, 'Unspecified', '0x'), {
      who: encodeAddress(who, SS58_PREFIX),
      fact: 'DocumentChecked',
    });
  }

  /** Wait until every submission queued so far has ended. */
  async idle(): Promise<void> {
    let before: Promise<unknown>;
    do {
      before = this.tail;
      await before.catch(() => undefined);
    } while (before !== this.tail);
  }

  private enqueue(build: () => Json, what: Record<string, unknown>): Promise<AttestResult> {
    const run = async (): Promise<AttestResult> => {
      let error: string | undefined;
      try {
        const out = await submitAndWait(this.api, this.agent, build(), this.options.inclusionTimeoutMs ?? INCLUSION_TIMEOUT_MS);
        error = out.error;
        if (error === undefined) {
          this.log('info', 'attested', { ...what, blockHash: out.blockHash });
          return { ok: true };
        }
      } catch (e) {
        error = messageOf(e);
      }
      const reason = STALE.includes(error) ? 'stale' : GONE.includes(error) ? 'gone' : 'failed';
      this.log(reason === 'failed' ? 'error' : 'info', 'attest-refused', { ...what, reason, error });
      return reason === 'failed' ? { ok: false, reason, detail: error } : { ok: false, reason };
    };
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }
}
