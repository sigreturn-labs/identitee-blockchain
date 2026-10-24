// End-to-end scenario against an identitee node.
//
//   npm run e2e -- --ws ws://127.0.0.1:9944             full scenario against a `--dev` node
//   npm run e2e -- --ws ws://127.0.0.1:9944 --readonly  reads only, no keys needed
//
// Prints `OK <step>` or `FAIL <step>: <reason>` per step; exit code 0 only if every step passed.
// See tools/README.md.

import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { findUnknownExtensions } from '@polkadot/types/extrinsic/signedExtensions';
import {
  hexToString,
  hexToU8a,
  stringToHex,
  stringToU8a,
  u8aConcat,
  u8aEq,
  u8aToHex,
} from '@polkadot/util';
import {
  blake2AsU8a,
  cryptoWaitReady,
  decodeAddress,
  encodeAddress,
  mnemonicGenerate,
  randomAsU8a,
} from '@polkadot/util-crypto';

// --- Protocol constants (pallets/identitee/src/types.rs, limits.rs) --------------------------

/** SS58 prefix, symbol and decimals of the chain (global constraints). */
const SS58_PREFIX = 2426;
const TOKEN_SYMBOL = 'IDT';
const TOKEN_DECIMALS = 12;

/** Domain tags of the field commitments (`PUBLIC_COMMITMENT_TAG`, `PRIVATE_COMMITMENT_TAG`). */
const PUBLIC_TAG = stringToU8a('identitee:field:public:v1');
const PRIVATE_TAG = stringToU8a('identitee:field:private:v1');

/** The commitment of a public value: `blake2_256(tag ‖ value)`. */
const publicCommitment = (value: Uint8Array): Uint8Array =>
  blake2AsU8a(u8aConcat(PUBLIC_TAG, value), 256);

/** The commitment of a private value, computed by the client: `blake2_256(tag ‖ salt ‖ value)`. */
const privateCommitment = (salt: Uint8Array, value: Uint8Array): Uint8Array =>
  blake2AsU8a(u8aConcat(PRIVATE_TAG, salt, value), 256);

/** Pallet limits as exposed in the metadata (`#[pallet::extra_constants]`). */
const LIMITS: Record<string, number> = {
  maxValueLen: 256,
  maxCustomKeyLen: 32,
  maxCustomFields: 16,
  maxFieldChanges: 32,
  maxLinks: 16,
  maxLinkTitleLen: 64,
  maxBioLen: 560,
  maxAvatarLen: 8192,
  maxSecretBlobLen: 256,
  maxSubs: 100,
  maxSubLabelLen: 64,
  nameMin: 3,
  nameMax: 32,
  maxPendingRequests: 16,
  maxNoteLen: 128,
  maxAuthorities: 16,
  maxAuthorityNameLen: 64,
  maxImportedJudgements: 32,
  quotaPerWindow: 50,
  globalFeelessPerBlock: 20,
};

/** dotID's registrar on the Polkadot People Chain: the only judgement a migration maps. */
const DOTID_POLKADOT_REGISTRAR = 5;

const FIXTURES = new URL('../../pallets/identitee/tests/fixtures/', import.meta.url);

/** Longest wait for a transaction to be included in a block. */
const INCLUSION_TIMEOUT_MS = 90_000;

// --- Reporting -------------------------------------------------------------------------------

class StepFailed extends Error {}

const stats = { ok: 0, failed: 0 };
let notes: string[] = [];

/** Attach a detail line to the step being run (printed under its OK/FAIL line). */
function info(line: string): void {
  notes.push(line);
}

function flushNotes(): void {
  for (const line of notes) console.log(`     ${line}`);
  notes = [];
}

/** Run one step: prints `OK <name>` or `FAIL <name>: <reason>`; a failure aborts the scenario. */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  notes = [];
  try {
    await fn();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`FAIL ${name}: ${reason}`);
    flushNotes();
    stats.failed++;
    throw new StepFailed(name);
  }
  console.log(`OK ${name}`);
  flushNotes();
  stats.ok++;
}

/** A group of steps that depend on each other: the first failure skips the rest of it. */
async function scenario(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`--- ${name}`);
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof StepFailed) {
      console.log(`ABORT ${name}: the steps after "${e.message}" were not run`);
    } else {
      console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
      stats.failed++;
    }
    return false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Deep strict equality, independent of object key order (arrays stay ordered). Throws one line
 * naming `what` with both values, keys sorted so that two renderings can be compared by eye.
 */
function same(actual: unknown, expected: unknown, what: string): void {
  try {
    deepStrictEqual(actual, expected);
  } catch {
    const show = (value: unknown): string =>
      inspect(value, { depth: null, breakLength: Infinity, sorted: true });
    throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

// --- Command line ----------------------------------------------------------------------------

interface Options {
  ws: string;
  readonly: boolean;
}

const USAGE = `usage: npm run e2e -- [--ws <url>] [--readonly]

  --ws <url>   node RPC endpoint (default ws://127.0.0.1:9944)
  --readonly   only read: properties, block production, runtime API, limits.
               Needs no key, for a node where the agent keys are not held.`;

function parseArgs(argv: string[]): Options {
  const options: Options = { ws: 'ws://127.0.0.1:9944', readonly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--readonly') {
      options.readonly = true;
    } else if (arg === '--ws') {
      const value = argv[++i];
      if (!value) throw new Error('--ws needs a url');
      options.ws = value;
    } else if (arg !== undefined && arg.startsWith('--ws=')) {
      options.ws = arg.slice('--ws='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  return options;
}

// --- Chain access ----------------------------------------------------------------------------

/** Untyped view of a decoded value: the pallet types are not in polkadot.js's static types. */
type Json = any;

/**
 * The JSON form of a decoded value as plain data: `toJSON()` of some composites (the chain
 * properties for one) still holds codec objects inside, which strict equality tells apart from
 * the plain arrays and objects it is compared to.
 */
const json = (value: { toJSON(): unknown }): Json => JSON.parse(JSON.stringify(value.toJSON()));

interface Account {
  label: string;
  pair: KeyringPair;
  address: string;
  /** Never funded: its calls must be feeless and its free balance must stay 0. */
  unfunded: boolean;
  /** Extrinsics sent, to compare with the per-window quota. */
  sent: number;
}

interface ChainEvent {
  section: string;
  method: string;
}

interface Outcome {
  events: ChainEvent[];
  /** `section.Name` of the dispatch error, if the extrinsic failed. */
  error?: string;
}

const eventName = (e: ChainEvent): string => `${e.section}.${e.method}`;
const hasEvent = (out: Outcome, name: string): boolean => out.events.some((e) => eventName(e) === name);

class Chain {
  constructor(
    readonly api: ApiPromise,
    private readonly keyring: Keyring,
  ) {}

  account(label: string, uri?: string, unfunded = false): Account {
    const pair = uri ? this.keyring.addFromUri(uri) : this.keyring.addFromMnemonic(mnemonicGenerate());
    return { label, pair, address: pair.address, unfunded, sent: 0 };
  }

  /** A key that was never funded and never used. */
  freshAccount(label: string): Account {
    return this.account(label, undefined, true);
  }

  async free(address: string): Promise<bigint> {
    const account = json(await this.api.query.system.account(address));
    return BigInt(account.data.free);
  }

  async nonce(address: string): Promise<number> {
    return Number(json(await this.api.query.system.account(address)).nonce);
  }

  /** Sign, submit, and wait for the extrinsic to be in a block; never throws on a dispatch error. */
  async send(signer: Account, tx: SubmittableExtrinsic<'promise'>): Promise<Outcome> {
    const { api } = this;
    signer.sent++;
    return new Promise<Outcome>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub?.();
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`not in a block after ${INCLUSION_TIMEOUT_MS / 1000} s`))),
        INCLUSION_TIMEOUT_MS,
      );
      tx.signAndSend(signer.pair, (result) => {
        if (result.isError) {
          settle(() => reject(new Error(`extrinsic ${result.status.type}`)));
          return;
        }
        if (!result.status.isInBlock) return;
        const events: ChainEvent[] = result.events.map(({ event }) => ({
          section: event.section,
          method: event.method,
        }));
        let error: string | undefined;
        if (result.dispatchError) {
          const d = result.dispatchError;
          if (d.isModule) {
            const meta = api.registry.findMetaError(d.asModule);
            error = `${meta.section}.${meta.name}`;
          } else {
            error = d.toString();
          }
        }
        const succeeded = events.some((e) => eventName(e) === 'system.ExtrinsicSuccess');
        const failed = events.some((e) => eventName(e) === 'system.ExtrinsicFailed');
        if (succeeded === failed) {
          settle(() => reject(new Error('the block holds neither ExtrinsicSuccess nor ExtrinsicFailed')));
        } else if (failed && !error) {
          settle(() => reject(new Error('ExtrinsicFailed without a decodable dispatch error')));
        } else {
          settle(() => resolve({ events, error }));
        }
      })
        .then((u) => {
          unsub = u;
          if (settled) u();
        })
        .catch((e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  /** Send and require `ExtrinsicSuccess` and every event of `expected` (`section.Name`). */
  async ok(signer: Account, tx: SubmittableExtrinsic<'promise'>, expected: string[]): Promise<Outcome> {
    const out = await this.send(signer, tx);
    if (out.error) throw new Error(`${signer.label}'s extrinsic failed with ${out.error}`);
    for (const name of expected) {
      assert(hasEvent(out, name), `missing event ${name}, got [${out.events.map(eventName).join(', ')}]`);
    }
    if (signer.unfunded) {
      assert(
        hasEvent(out, 'skipFeelessPayment.FeeSkipped'),
        `${signer.label} is unfunded but the call was not feeless: got [${out.events.map(eventName).join(', ')}]`,
      );
    }
    return out;
  }

  /** Send and require the specific module error `section.Name`. */
  async fails(signer: Account, tx: SubmittableExtrinsic<'promise'>, expectedError: string): Promise<void> {
    const out = await this.send(signer, tx);
    assert(out.error !== undefined, `expected ${expectedError}, but the extrinsic succeeded`);
    same(out.error, expectedError, 'dispatch error');
  }

  // --- IdentiteeApi, through api.call (metadata exposes it; no custom types) ---

  async profile(address: string): Promise<Json | null> {
    return json(await this.api.call.identiteeApi.profile(address));
  }

  async profileOf(account: Account): Promise<Json> {
    const profile = await this.profile(account.address);
    assert(profile !== null, `${account.label} has no profile`);
    return profile;
  }

  async trustLevel(address: string): Promise<string | null> {
    return json(await this.api.call.identiteeApi.trustLevel(address));
  }

  /** The trust level, required to be the same through `trustLevel` and through `profile`. */
  async expectTrust(account: Account, expected: string): Promise<void> {
    const viaApi = await this.trustLevel(account.address);
    const viaProfile = (await this.profileOf(account)).trustLevel;
    same(viaApi, expected, `trustLevel(${account.label})`);
    same(viaProfile, expected, `profile(${account.label}).trustLevel`);
  }

  async resolveName(name: string): Promise<string | null> {
    return json(await this.api.call.identiteeApi.resolveName(stringToHex(name)));
  }

  async nameStatus(name: string): Promise<Json> {
    return json(await this.api.call.identiteeApi.nameStatus(stringToHex(name)));
  }

  async subsOf(address: string): Promise<Json[]> {
    return json(await this.api.call.identiteeApi.subsOf(address));
  }

  async pendingSubsOf(address: string): Promise<Json[]> {
    return json(await this.api.call.identiteeApi.pendingSubsOf(address));
  }

  async parentOf(address: string): Promise<Json | null> {
    return json(await this.api.call.identiteeApi.parentOf(address));
  }

  /**
   * The commitment a field has on chain, read from the stored identity: a public value is
   * committed under the public tag, a private one is already a commitment.
   */
  async fieldCommitment(address: string, kind: string): Promise<Uint8Array> {
    const identity = json(await this.api.query.identitee.identities(address));
    assert(identity !== null, 'no identity on chain');
    const value = identity.typed[kind];
    assert(value !== undefined, `no ${kind} field on chain`);
    if (value.public !== undefined) return publicCommitment(hexToU8a(value.public));
    return hexToU8a(value.private);
  }
}

const sameAccount = (actual: unknown, expected: string): boolean =>
  typeof actual === 'string' && u8aEq(decodeAddress(actual), decodeAddress(expected));

/** The attestation entries of a typed field in a profile: `[key, authority, attestation, valid]`. */
const attestationsOf = (profile: Json, kind: string): Json[] =>
  (profile.attestations as Json[]).filter(([key]) => key.typed === kind);

const randomHex = (bytes: number): string => u8aToHex(randomAsU8a(bytes)).slice(2);

// --- Read-only checks ------------------------------------------------------------------------

async function readChecks(chain: Chain, ws: string): Promise<void> {
  const { api } = chain;

  await step('node reachable and runtime is identitee', async () => {
    const specName = api.runtimeVersion.specName.toString();
    same(specName, 'identitee', 'runtime spec name');
    info(`${api.runtimeChain.toString()} at ${ws}, spec_version ${api.runtimeVersion.specVersion.toString()}`);
  });

  await step('system properties (ss58 2426, IDT, 12 decimals)', async () => {
    const properties = json(await api.rpc.system.properties());
    same(Number(properties.ss58Format), SS58_PREFIX, 'ss58Format');
    same(properties.tokenSymbol, [TOKEN_SYMBOL], 'tokenSymbol');
    same(properties.tokenDecimals, [TOKEN_DECIMALS], 'tokenDecimals');
  });

  await step('blocks advance', async () => {
    const heights = await new Promise<number[]>((resolve, reject) => {
      const seen: number[] = [];
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsub?.();
        reject(new Error(`no two new blocks within 60 s, saw heights [${seen.join(', ')}]`));
      }, 60_000);
      api.rpc.chain
        .subscribeNewHeads((header) => {
          seen.push(header.number.toNumber());
          const first = seen[0] ?? 0;
          if (header.number.toNumber() - first >= 2) {
            clearTimeout(timer);
            unsub?.();
            resolve(seen);
          }
        })
        .then((u) => {
          unsub = u;
        })
        .catch(reject);
    });
    info(`heights seen: ${heights.join(', ')}`);
  });

  await step('identiteeApi is exposed and answers None for an unknown account', async () => {
    const methods = ['profile', 'trustLevel', 'resolveName', 'nameStatus', 'subsOf', 'pendingSubsOf', 'parentOf', 'identitySecret'];
    const exposed = Object.keys(api.call.identiteeApi ?? {});
    for (const method of methods) assert(exposed.includes(method), `api.call.identiteeApi.${method} is not in the metadata`);
    const unknown = encodeAddress(randomAsU8a(32), SS58_PREFIX);
    same(await chain.profile(unknown), null, 'profile(unknown)');
    same(await chain.trustLevel(unknown), null, 'trustLevel(unknown)');
    same(await chain.parentOf(unknown), null, 'parentOf(unknown)');
    same(await chain.subsOf(unknown), [], 'subsOf(unknown)');
    same(await chain.pendingSubsOf(unknown), [], 'pendingSubsOf(unknown)');
    same(await chain.resolveName(`e2e-${randomHex(6)}`), null, 'resolveName(unknown name)');
    same(await chain.nameStatus('ab'), { invalid: null }, 'nameStatus of a too short name');
    same(await chain.nameStatus(`e2e-${randomHex(6)}`), { available: null }, 'nameStatus of a free name');
  });

  await step('limit constants match the design', async () => {
    const consts = api.consts.identitee;
    assert(consts !== undefined, 'the identitee pallet has no constants in the metadata');
    for (const [name, expected] of Object.entries(LIMITS)) {
      const constant = consts[name];
      assert(constant !== undefined, `constant ${name} is missing from the metadata`);
      same(json(constant), expected, name);
    }
    same(json(consts.avatarSizes!), [[64, 64]], 'avatarSizes');
    // Durations are derived from the block time: 1 day and 30 days.
    const slotMs = Number(json(api.consts.aura!.slotDuration!));
    const day = Math.round(86_400_000 / slotMs);
    same(json(consts.quotaWindow!), day, 'quotaWindow (1 day in blocks)');
    same(json(consts.nameQuarantine!), 30 * day, 'nameQuarantine (30 days in blocks)');
    info(`block time ${slotMs} ms, 1 day = ${day} blocks`);
  });
}

// --- Main scenario ---------------------------------------------------------------------------

async function mainScenario(chain: Chain, alice: Account): Promise<void> {
  const { api } = chain;
  const avatarWebp = new Uint8Array(readFileSync(new URL('avatar-64-lossy.webp', FIXTURES)));
  const avatarPng = new Uint8Array(readFileSync(new URL('avatar-64.png', FIXTURES)));
  const avatarWebpHex = u8aToHex(avatarWebp);

  const parent = chain.freshAccount('parent');
  const sub = chain.freshAccount('sub');
  const run = randomHex(4);
  const bio = `End-to-end ${run}: éèà, identity on a feeless chain.`;
  const email = `e2e-${run}@example.org`;
  const changedEmail = `e2e-${run}-changed@example.org`;
  const telegram = `@e2e_${run}`;
  const salt = randomAsU8a(32);
  const telegramCommitment = privateCommitment(salt, stringToU8a(telegram));
  const name = `e2e-${run}${randomHex(2)}`;
  const emailKey = { Typed: 'Email' };
  const telegramKey = { Typed: 'Telegram' };

  await step('fresh account is unfunded, unused and has no identity', async () => {
    same(await chain.free(parent.address), 0n, 'free balance before');
    same(await chain.nonce(parent.address), 0, 'nonce before');
    same(await chain.profile(parent.address), null, 'profile before');
    same(await chain.free(sub.address), 0n, 'sub free balance before');
    info(`parent ${parent.address}`);
    info(`sub    ${sub.address}`);
  });

  await step('set_bio (feeless from a zero-balance account)', async () => {
    await chain.ok(parent, api.tx.identitee.setBio(stringToHex(bio)), ['identitee.BioSet']);
    const profile = await chain.profileOf(parent);
    same(hexToString(profile.identity.bio), bio, 'bio');
    same(profile.trustLevel, 'Declared', 'trust level of a new identity');
  });

  await step('set_field Email (public)', async () => {
    await chain.ok(parent, api.tx.identitee.setField(emailKey, { Public: stringToHex(email) }), ['identitee.FieldSet']);
    const profile = await chain.profileOf(parent);
    same(hexToString(profile.identity.typed.Email.public), email, 'email on chain');
  });

  await step('set_field Telegram (private, commitment computed client-side)', async () => {
    await chain.ok(
      parent,
      api.tx.identitee.setField(telegramKey, { Private: u8aToHex(telegramCommitment) }),
      ['identitee.FieldSet'],
    );
    const profile = await chain.profileOf(parent);
    same(profile.identity.typed.Telegram, { private: u8aToHex(telegramCommitment) }, 'telegram on chain');
    assert(
      !JSON.stringify(profile).includes(stringToHex(telegram).slice(2)),
      'the private value appears in the profile',
    );
  });

  await step('add_link x2', async () => {
    await chain.ok(parent, api.tx.identitee.addLink(stringToHex('Website'), stringToHex('https://example.org/e2e')), ['identitee.LinkAdded']);
    await chain.ok(parent, api.tx.identitee.addLink(stringToHex('Code'), stringToHex('https://example.org/e2e/code')), ['identitee.LinkAdded']);
    const profile = await chain.profileOf(parent);
    same(
      profile.identity.links.map((l: Json) => [l.id, hexToString(l.title), hexToString(l.url)]),
      [
        [0, 'Website', 'https://example.org/e2e'],
        [1, 'Code', 'https://example.org/e2e/code'],
      ],
      'links',
    );
  });

  await step('set_avatar (64x64 WebP fixture)', async () => {
    await chain.ok(parent, api.tx.identitee.setAvatar(avatarWebpHex), ['identitee.AvatarSet']);
    same((await chain.profileOf(parent)).identity.avatar, avatarWebpHex, 'avatar on chain');
    info(`${avatarWebp.length} bytes`);
  });

  await step('nothing verified yet: Declared', async () => {
    await chain.expectTrust(parent, 'Declared');
  });

  await step('request_judgement(authority 0, Field(Email))', async () => {
    await chain.ok(parent, api.tx.identitee.requestJudgement(0, { Field: emailKey }), ['identitee.AttestationRequested']);
    const pending = await api.query.identitee.pendingRequests(parent.address, [0, { Field: emailKey }]);
    assert(json(pending) !== null, 'the request is not in PendingRequests');
  });

  await step('Alice provide_judgement Email with the commitment read on chain: PartiallyVerified', async () => {
    const commitment = await chain.fieldCommitment(parent.address, 'Email');
    same(u8aToHex(commitment), u8aToHex(publicCommitment(stringToU8a(email))), 'on-chain email commitment');
    await chain.ok(
      alice,
      api.tx.identitee.provideJudgement(parent.address, emailKey, u8aToHex(commitment), 'Verified', 'EmailCode', null),
      ['identitee.FieldAttested'],
    );
    const profile = await chain.profileOf(parent);
    const [entry] = attestationsOf(profile, 'Email');
    assert(entry !== undefined, 'no Email attestation in the profile');
    same([entry[1], entry[2].verdict, entry[2].method, entry[3]], [0, 'Verified', { emailCode: null }, true], 'Email attestation');
    same(entry[2].commitment, u8aToHex(commitment), 'attested commitment');
    const pending = await api.query.identitee.pendingRequests(parent.address, [0, { Field: emailKey }]);
    same(json(pending), null, 'request consumed by the attestation');
    await chain.expectTrust(parent, 'PartiallyVerified');
  });

  await step('Alice attests every verifiable field (Telegram): FullyVerified', async () => {
    const commitment = await chain.fieldCommitment(parent.address, 'Telegram');
    same(u8aToHex(commitment), u8aToHex(telegramCommitment), 'on-chain telegram commitment');
    await chain.ok(
      alice,
      api.tx.identitee.provideJudgement(parent.address, telegramKey, u8aToHex(commitment), 'Verified', 'Manual', null),
      ['identitee.FieldAttested'],
    );
    await chain.expectTrust(parent, 'FullyVerified');
  });

  await step('Alice grant_fact(DocumentChecked): Certified', async () => {
    await chain.ok(
      alice,
      api.tx.identitee.grantFact(parent.address, 'DocumentChecked', null, 'Unspecified', stringToHex('e2e: identity document checked')),
      ['identitee.FactGranted'],
    );
    await chain.expectTrust(parent, 'Certified');
  });

  await step('changing the email invalidates its attestation: PartiallyVerified', async () => {
    await chain.ok(parent, api.tx.identitee.setField(emailKey, { Public: stringToHex(changedEmail) }), ['identitee.FieldSet']);
    const profile = await chain.profileOf(parent);
    same(attestationsOf(profile, 'Email').map((a) => a[3]), [false], 'Email attestation still valid');
    same(attestationsOf(profile, 'Telegram').map((a) => a[3]), [true], 'Telegram attestation valid');
    await chain.expectTrust(parent, 'PartiallyVerified');
  });

  await step('claim_username then resolve_name', async () => {
    same(await chain.nameStatus(name), { available: null }, 'name status before the claim');
    await chain.ok(parent, api.tx.identitee.claimUsername(stringToHex(name)), ['identitee.NameClaimed']);
    const owner = await chain.resolveName(name);
    assert(sameAccount(owner, parent.address), `resolve_name(${name}) is ${String(owner)}, not the parent`);
    const status = await chain.nameStatus(name);
    assert(sameAccount(status.taken, parent.address), `name_status(${name}) is ${JSON.stringify(status)}`);
    same(hexToString((await chain.profileOf(parent)).name), name, 'profile.name');
    info(`name ${name}`);
  });

  await step('sub-account proposed by the parent, accepted by the unfunded sub', async () => {
    await chain.ok(parent, api.tx.identitee.addSub(sub.address, stringToHex('e2e laptop')), ['identitee.SubProposed']);
    same(await chain.subsOf(parent.address), [], 'accepted subs after the proposal');
    same(await chain.parentOf(sub.address), null, 'parent of the sub after the proposal');
    const pending = await chain.pendingSubsOf(parent.address);
    same(pending.length, 1, 'pending proposals');
    assert(sameAccount(pending[0][0], sub.address), 'the pending proposal is not for the sub');

    await chain.ok(sub, api.tx.identitee.acceptSub(parent.address), ['identitee.SubAccepted']);
    const subs = await chain.subsOf(parent.address);
    same(subs.length, 1, 'accepted subs');
    assert(sameAccount(subs[0][0], sub.address), 'the accepted sub is not the sub');
    same(hexToString(subs[0][1]), 'e2e laptop', 'sub label');
    const link = await chain.parentOf(sub.address);
    assert(link !== null && sameAccount(link[0], parent.address), 'parent_of(sub) is not the parent');
    same(await chain.pendingSubsOf(parent.address), [], 'pending proposals after the acceptance');
    same(await chain.free(sub.address), 0n, 'sub free balance after');
  });

  await step('a PNG avatar is refused with InvalidAvatar', async () => {
    await chain.fails(parent, api.tx.identitee.setAvatar(u8aToHex(avatarPng)), 'identitee.InvalidAvatar');
    same((await chain.profileOf(parent)).identity.avatar, avatarWebpHex, 'avatar after the refusal');
    info(`${avatarPng.length} bytes of PNG`);
  });

  await step('reveal_field Telegram: wrong salt refused, right salt accepted, attestation follows', async () => {
    await chain.fails(
      parent,
      api.tx.identitee.revealField(telegramKey, stringToHex(telegram), u8aToHex(randomAsU8a(32))),
      'identitee.RevealMismatch',
    );
    await chain.ok(parent, api.tx.identitee.revealField(telegramKey, stringToHex(telegram), u8aToHex(salt)), ['identitee.FieldRevealed']);
    const profile = await chain.profileOf(parent);
    same(hexToString(profile.identity.typed.Telegram.public), telegram, 'telegram after the reveal');
    same(attestationsOf(profile, 'Telegram').map((a) => a[3]), [true], 'Telegram attestation after the reveal');
    await chain.expectTrust(parent, 'PartiallyVerified');
  });

  await step('Alice grant_fact(Fraud): Fraudulent', async () => {
    await chain.ok(
      alice,
      api.tx.identitee.grantFact(parent.address, 'Fraud', null, 'Other', stringToHex('e2e: fraud found')),
      ['identitee.FactGranted'],
    );
    await chain.expectTrust(parent, 'Fraudulent');
  });

  await step('set_identity: several fields set and cleared in one transaction, one quota unit', async () => {
    const usageCount = async (): Promise<number> => Number(json(await api.query.identitee.usage(parent.address))[1]);
    const displayNameKey = { Typed: 'DisplayName' };
    const pgpKey = { Typed: 'Pgp' };
    const pronounsKey = { Custom: stringToHex('pronoms') };
    const displayName = `E2E ${run}`;
    const before = await usageCount();
    // The stale attestation of the changed email is still there; clearing the field removes it.
    same(attestationsOf(await chain.profileOf(parent), 'Email').length, 1, 'Email attestations before');

    const out = await chain.ok(
      parent,
      api.tx.identitee.setIdentity([
        [displayNameKey, { Public: stringToHex(displayName) }],
        [pronounsKey, { Public: stringToHex('they') }],
        [emailKey, null],
      ]),
      ['identitee.FieldSet', 'identitee.FieldCleared'],
    );
    same(out.events.filter((e) => eventName(e) === 'identitee.FieldSet').length, 2, 'FieldSet events');
    same(out.events.filter((e) => eventName(e) === 'identitee.FieldCleared').length, 1, 'FieldCleared events');
    same(await usageCount(), before + 1, 'quota units used by the call (3 changes)');
    const profile = await chain.profileOf(parent);
    same(hexToString(profile.identity.typed.DisplayName.public), displayName, 'display name');
    same(profile.identity.typed.Email, undefined, 'email after the clear');
    same(Object.values(profile.identity.custom).map((v: Json) => hexToString(v.public)), ['they'], 'custom fields');
    same(attestationsOf(profile, 'Email'), [], 'Email attestations after the clear');
    await chain.expectTrust(parent, 'Fraudulent');

    // All or nothing: the second change is not a PGP fingerprint, so the first one is not kept.
    await chain.fails(
      parent,
      api.tx.identitee.setIdentity([
        [displayNameKey, { Public: stringToHex('not kept') }],
        [pgpKey, { Public: u8aToHex(randomAsU8a(19)) }],
      ]),
      'identitee.InvalidPgp',
    );
    same(hexToString((await chain.profileOf(parent)).identity.typed.DisplayName.public), displayName, 'display name after the refusal');
    // The same field twice, and a link key, are refused too.
    await chain.fails(
      parent,
      api.tx.identitee.setIdentity([
        [displayNameKey, { Public: stringToHex('a') }],
        [displayNameKey, null],
      ]),
      'identitee.DuplicateFieldInBatch',
    );
    await chain.fails(
      parent,
      api.tx.identitee.setIdentity([[{ Link: 0 }, null]]),
      'identitee.LinkKeyNotSettable',
    );
  });

  await step('the fresh account was never funded and stayed within its quota', async () => {
    same(await chain.free(parent.address), 0n, 'parent free balance after');
    same(await chain.free(sub.address), 0n, 'sub free balance after');
    const usage = json(await api.query.identitee.usage(parent.address));
    const quota = Number(json(api.consts.identitee!.quotaPerWindow!));
    assert(usage !== null, 'no usage recorded for the parent');
    same(usage[1], parent.sent, 'feeless usage recorded on chain vs extrinsics sent');
    assert(parent.sent < quota, `${parent.sent} writes would exceed the quota of ${quota}`);
    info(`parent made ${parent.sent} feeless calls, quota ${quota} per window`);
  });
}

// --- Migration scenario ----------------------------------------------------------------------

async function migrationScenario(chain: Chain, bob: Account): Promise<void> {
  const { api } = chain;
  const migrant = chain.freshAccount('migrant');
  const run = randomHex(4);
  const email = `migrated-${run}@example.org`;
  const github = `e2e-migrant-${run}`;
  const sourceBlock = 24_000_000;
  const sourceHash = u8aToHex(blake2AsU8a(stringToU8a(`identitee e2e source block ${run}`), 256));
  const payload = {
    typed: [
      ['Email', stringToHex(email)],
      ['GitHub', stringToHex(github)],
    ],
    custom: [],
    // dotID's verdict is the one that counts; another registrar's is kept as history only.
    judgements: [
      [DOTID_POLKADOT_REGISTRAR, 'KnownGood'],
      [3, 'LowQuality'],
    ],
  };

  await step('migrant is unfunded and has no identity', async () => {
    same(await chain.free(migrant.address), 0n, 'free balance before');
    same(await chain.profile(migrant.address), null, 'profile before');
    info(`migrant ${migrant.address}`);
  });

  await step('request_migration(Polkadot) from a zero-balance account', async () => {
    await chain.ok(migrant, api.tx.identitee.requestMigration('Polkadot'), ['identitee.MigrationRequested']);
    assert(json(await api.query.identitee.migrationRequests(migrant.address)) !== null, 'the request is not stored');
  });

  await step('Bob fulfil_migration with a KnownGood payload: Certified', async () => {
    await chain.ok(
      bob,
      api.tx.identitee.fulfilMigration(migrant.address, 'Polkadot', sourceBlock, sourceHash, payload),
      ['identitee.MigrationFulfilled'],
    );
    same(json(await api.query.identitee.migrationRequests(migrant.address)), null, 'request consumed');
    await chain.expectTrust(migrant, 'Certified');
  });

  await step('migrated profile carries its provenance, attestations and fact', async () => {
    const profile = await chain.profileOf(migrant);
    same(hexToString(profile.identity.typed.Email.public), email, 'migrated email');
    same(hexToString(profile.identity.typed.GitHub.public), github, 'migrated github');
    same(profile.imported, { source: 'Polkadot', block: sourceBlock, blockHash: sourceHash, judgements: payload.judgements }, 'imported history');
    const methods = (profile.attestations as Json[]).map(([key, authority, att, valid]) => [
      key.typed,
      authority,
      att.verdict,
      att.method.migratedFromPeopleChain?.registrar,
      valid,
    ]);
    methods.sort();
    same(
      methods,
      [
        ['Email', 0, 'Verified', DOTID_POLKADOT_REGISTRAR, true],
        ['GitHub', 0, 'Verified', DOTID_POLKADOT_REGISTRAR, true],
      ],
      'migrated attestations',
    );
    same((profile.facts as Json[]).map(([kind, authority, , active]) => [kind, authority, active]), [['DocumentChecked', 0, true]], 'migrated facts');
    same(await chain.free(migrant.address), 0n, 'migrant free balance after');
  });
}

// --- Entry point -----------------------------------------------------------------------------

/**
 * Signed extensions of the chain that polkadot.js does not know by name. For an unknown extension
 * it logs `Unknown signed extensions ... treating them as no-effect` and encodes nothing for it:
 * neither explicit data nor additional signed data. That is only right for an extension that
 * carries none. `AuthorizeCall` (frame_system, upstream) is one: both its types are `()`, and the
 * scenario signs real extrinsics with it. Any other unknown extension might need data that
 * polkadot.js would silently leave out, producing invalid transactions, so it must be looked at
 * before signing.
 */
const UNKNOWN_EXTENSIONS_ALLOWED = ['AuthorizeCall'];

/** Fail unless every extension unknown to polkadot.js is in `UNKNOWN_EXTENSIONS_ALLOWED`. */
function assertKnownExtensions(api: ApiPromise): string[] {
  const unknown = findUnknownExtensions(api.registry.signedExtensions);
  const unexpected = unknown.filter((name) => !UNKNOWN_EXTENSIONS_ALLOWED.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `signed extension(s) unknown to polkadot.js and not allow-listed: ${unexpected.join(', ')}` +
        ` (allowed: ${UNKNOWN_EXTENSIONS_ALLOWED.join(', ')}); check that they carry no data` +
        ' before signing, then add them to UNKNOWN_EXTENSIONS_ALLOWED',
    );
  }
  return unknown;
}

/**
 * Connect, then check the signed extensions. polkadot.js prints its own notices (unknown
 * extensions, RPC methods it does not decorate) on purpose: they are not silenced, the first one
 * is asserted instead.
 */
async function connect(ws: string): Promise<{ api: ApiPromise; unknown: string[] }> {
  const provider = new WsProvider(ws);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cannot connect to ${ws} within 20 s`)), 20_000);
  });
  let api: ApiPromise;
  try {
    api = await Promise.race([ApiPromise.create({ provider }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  try {
    return { api, unknown: assertKnownExtensions(api) };
  } catch (e) {
    await api.disconnect();
    throw e;
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  await cryptoWaitReady();

  let api: ApiPromise;
  try {
    const connection = await connect(options.ws);
    api = connection.api;
    console.log(`OK connect ${options.ws}`);
    stats.ok++;
    console.log(
      `     signed extensions unknown to polkadot.js: [${connection.unknown.join(', ')}] (allowed: [${UNKNOWN_EXTENSIONS_ALLOWED.join(', ')}])`,
    );
  } catch (e) {
    console.log(`FAIL connect: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    const keyring = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX });
    const chain = new Chain(api, keyring);

    await scenario('read-only checks', () => readChecks(chain, options.ws));

    if (!options.readonly) {
      const alice = chain.account('Alice', '//Alice');
      const bob = chain.account('Bob', '//Bob');
      const agentsReady = await scenario('dev agents', () =>
        step('Alice (all capabilities) and Bob (migrate) are agents of authority 0', async () => {
          same(json(await api.query.identitee.agents(alice.address)), [0, 15], 'Alice agent entry');
          same(json(await api.query.identitee.agents(bob.address)), [0, 8], 'Bob agent entry');
        }),
      );
      if (agentsReady) {
        await scenario('identity lifecycle of a never-funded account', () => mainScenario(chain, alice));
        await scenario('migration from the People Chain', () => migrationScenario(chain, bob));
      } else {
        console.log('(this node lacks the dev agents, whose keys we hold: use --readonly)');
      }
    }
  } catch (e) {
    console.log(`FAIL fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    stats.failed++;
  } finally {
    await api.disconnect();
  }

  console.log(stats.failed === 0 ? `PASS ${stats.ok} steps` : `FAILED ${stats.failed} step(s), ${stats.ok} passed`);
  return stats.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.log(`FAIL fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
