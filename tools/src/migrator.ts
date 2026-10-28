// The migration service: fulfils or rejects the `request_migration` requests of identitee.
//
//   IDENTITEE_MIGRATOR_SURI='<secret uri>' npx tsx src/migrator.ts [--snapshot <file>]...
//
// It watches the FINALIZED blocks of the identitee node (IDENTITEE_WS, default
// ws://127.0.0.1:9944) for `identitee.MigrationRequested`, reads the identity of the account on
// the People Chain the request names, and sends `fulfil_migration` (or `reject_migration` when
// that chain has no identity for the account). The signer is the agent whose key is in
// IDENTITEE_MIGRATOR_SURI; it needs the MIGRATE capability. With `--snapshot` (repeatable, one
// file per chain, a hand-written JSON, see snapshot-file.ts) the identities come from the files
// and the People Chains are not contacted. Logs are one JSON object per line on stdout; the key
// is never logged. See tools/README.md.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { findUnknownExtensions } from '@polkadot/types/extrinsic/signedExtensions';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import {
  DEFAULT_LIMITS,
  PEOPLE_AT_ENV,
  connectPeople,
  pinnedBlock,
  readPeopleIdentity,
  type Dropped,
  type Limits,
  type PeopleConnection,
  type PeopleRead,
  type SourceName,
} from './people.ts';
import { accountKey, parseSnapshot, type Snapshot } from './snapshot-file.ts';

const SS58_PREFIX = 2426;
/** `Capabilities::MIGRATE` (pallets/identitee/src/types.rs). */
const MIGRATE = 8;

/** How often the finalized state is searched for requests that no event announced (or that failed). */
const SWEEP_MS = 60_000;
/**
 * How long a request that failed (read or transaction, a problem that may go away) is left alone:
 * RETRY_BASE_MS after the first failure, doubling at each next one, up to RETRY_MAX_MS.
 */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
/** How long a request for a chain without a snapshot is left alone (not a failure: a fixed delay). */
const NOT_SERVED_RETRY_MS = 5 * 60_000;
/** Longest wait for a transaction to be in a block. */
const INCLUSION_TIMEOUT_MS = 90_000;
/** At a stop, how long a transaction already sent is waited for. */
const STOP_WAIT_MS = 30_000;
/** Longest wait for one People Chain read. */
const READ_TIMEOUT_MS = 30_000;
const PENDING_PAGE = 100;

// --- Logging ---------------------------------------------------------------------------------

export type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

/**
 * One JSON object per line on stdout, with every `secrets` string removed from it, in its plain
 * form and in the form `JSON.stringify` gives it inside the line (a quote or a backslash in a
 * secret is escaped there).
 */
export function makeLogger(secrets: string[], write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  const forms = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (level, event, fields = {}) => {
    let line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    for (const form of forms) line = line.split(form).join('[redacted]');
    write(`${line}\n`);
  };
}

// --- Configuration ---------------------------------------------------------------------------

export interface Config {
  ws: string;
  suri: string;
  snapshots: string[];
  /** The People Chain blocks the sources are pinned to (hash), by source; the latest finalized one if absent. */
  pinned: Partial<Record<SourceName, string>>;
}

export const USAGE = `usage: IDENTITEE_MIGRATOR_SURI='<secret uri>' npx tsx src/migrator.ts [--snapshot <file>]...

  IDENTITEE_WS               identitee node RPC endpoint (default ws://127.0.0.1:9944)
  IDENTITEE_MIGRATOR_SURI    secret URI of the agent that holds the MIGRATE capability (required)
  --snapshot <file>          serve this chain's identities from a snapshot file instead of the
                             People Chain (repeatable, one per chain; a request for a chain
                             without a file is left pending)
  PEOPLE_AT_BLOCK_POLKADOT   block hash to read the Polkadot People Chain at, instead of its
  PEOPLE_AT_BLOCK_KUSAMA     latest finalized block (same for Kusama); needs an archive endpoint`;

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const snapshots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--snapshot') {
      const file = argv[++i];
      if (!file) throw new Error(`--snapshot needs a file\n${USAGE}`);
      snapshots.push(file);
    } else if (arg !== undefined && arg.startsWith('--snapshot=')) {
      snapshots.push(arg.slice('--snapshot='.length));
    } else {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  const suri = env.IDENTITEE_MIGRATOR_SURI;
  if (!suri) throw new Error(`IDENTITEE_MIGRATOR_SURI is not set\n${USAGE}`);
  const pinned: Config['pinned'] = {};
  for (const source of ['Polkadot', 'Kusama'] as const) {
    const at = pinnedBlock(source, env);
    if (at !== undefined) pinned[source] = at;
  }
  return { ws: env.IDENTITEE_WS || 'ws://127.0.0.1:9944', suri, snapshots, pinned };
}

// --- Where the identities come from ----------------------------------------------------------

/** What a source answers: the identity, `null` if the chain has none, `'not-served'` if it cannot say. */
export type SourceResult = PeopleRead | null | 'not-served';

export interface SourceReader {
  read(source: SourceName, who: string): Promise<SourceResult>;
  close(): Promise<void>;
}

/** Identities from snapshot files, one per chain. */
export class SnapshotSource implements SourceReader {
  private readonly bySource = new Map<SourceName, Snapshot>();

  constructor(snapshots: Snapshot[]) {
    for (const snapshot of snapshots) {
      if (this.bySource.has(snapshot.source)) throw new Error(`two snapshots for ${snapshot.source}`);
      this.bySource.set(snapshot.source, snapshot);
    }
  }

  async read(source: SourceName, who: string): Promise<SourceResult> {
    const snapshot = this.bySource.get(source);
    if (snapshot === undefined) return 'not-served';
    const payload = snapshot.byAccount.get(accountKey(who));
    if (payload === undefined) return null;
    return { block: snapshot.block, blockHash: snapshot.blockHash, payload, dropped: [] };
  }

  async close(): Promise<void> {}
}

/** Identities read from the People Chains, over a connection kept until it fails. */
export class LivePeopleSource implements SourceReader {
  private readonly connections = new Map<SourceName, PeopleConnection>();
  private readonly failures = new Map<SourceName, number>();

  constructor(
    private readonly limits: Limits,
    private readonly log: Logger,
    private readonly pinned: Config['pinned'] = {},
    // Replaceable by the tests, which have no People Chain to talk to.
    private readonly deps: { connect: typeof connectPeople; read: typeof readPeopleIdentity } = {
      connect: connectPeople,
      read: readPeopleIdentity,
    },
  ) {}

  private async connection(source: SourceName): Promise<PeopleConnection> {
    const existing = this.connections.get(source);
    if (existing) return existing;
    const connection = await this.deps.connect(source, { first: this.failures.get(source) ?? 0 });
    this.log('info', 'people-connected', { source, endpoint: connection.endpoint });
    this.connections.set(source, connection);
    return connection;
  }

  private async drop(source: SourceName): Promise<void> {
    const connection = this.connections.get(source);
    this.connections.delete(source);
    this.failures.set(source, (this.failures.get(source) ?? 0) + 1);
    await connection?.api.disconnect().catch(() => undefined);
  }

  /** One read; a failure drops the connection so that the next try starts on the next endpoint. */
  private async attempt(source: SourceName, who: string): Promise<PeopleRead | null> {
    const connection = await this.connection(source);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer from ${connection.endpoint} within ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS);
      });
      const at = this.pinned[source];
      return await Promise.race([
        this.deps.read(connection.api, who, { limits: this.limits, source, ...(at ? { at } : {}) }),
        timeout,
      ]);
    } catch (e) {
      await this.drop(source);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async read(source: SourceName, who: string): Promise<SourceResult> {
    try {
      return await this.attempt(source, who);
    } catch (first) {
      this.log('warn', 'people-read-failed', { source, who, error: messageOf(first), next: 'retrying on the next endpoint' });
      return await this.attempt(source, who);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((source) => this.drop(source)));
  }
}

// --- The service -----------------------------------------------------------------------------

type Json = any;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a stop makes of the work in flight. */
class Aborted extends Error {
  constructor() {
    super('stopped');
  }
}

/**
 * Runtime refusals of `fulfil_migration` that no retry can change, and what to do with the request:
 * the request is gone or has changed (nothing to do), or the account/payload can never be accepted
 * (refuse the request, so that it does not block the queue for ever). Everything else is taken for
 * a problem that may pass, and retried with a growing delay.
 */
const TERMINAL_SKIP = ['identitee.NoMigrationRequest', 'identitee.MigrationSourceMismatch'];
const TERMINAL_REJECT: Record<string, string> = {
  'identitee.IdentityExists': 'the account created an identity after its request',
  'identitee.InvalidUtf8': 'the runtime refused the payload (invalid UTF-8)',
  'identitee.InvalidPgp': 'the runtime refused the payload (PGP fingerprint)',
  'identitee.DuplicateField': 'the runtime refused the payload (duplicate field)',
  'identitee.DuplicateJudgement': 'the runtime refused the payload (duplicate judgement)',
  'identitee.TooManyCustomFields': 'the runtime refused the payload (too many custom fields)',
};

export interface Submitted {
  /** `section.Name` of every event of the extrinsic. */
  events: string[];
  /** `section.Name` of the dispatch error, if the extrinsic failed. */
  error?: string;
  blockHash: string;
}

export interface MigratorOptions {
  sweepMs?: number;
  /** First retry delay of a failed request, doubled at each failure up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  inclusionTimeoutMs?: number;
  /** At a stop, how long a transaction already sent is waited for. */
  stopWaitMs?: number;
  /** The clock of the retry delays (ms since the epoch); replaceable by the tests. */
  now?: () => number;
}

export class Migrator {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  /** The account being served: not queued again meanwhile (a later sweep takes a request it left pending). */
  private inFlight: string | undefined;
  private readonly retryAfter = new Map<string, number>();
  /** Consecutive failures of each account that failed. */
  private readonly failures = new Map<string, number>();
  /** Rejects when `stop()` is called: the work waiting on a source gives up at once. */
  private readonly aborted: Promise<never>;
  private abort: (reason: Error) => void = () => undefined;
  private heads: Promise<void> = Promise.resolve();
  private worker: Promise<void> = Promise.resolve();
  private stopping = false;
  private sweeping = false;
  /** The last finalized block whose events were read. */
  private last: number | undefined;
  private unsubscribe: (() => void) | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: ApiPromise,
    private readonly agent: KeyringPair,
    private readonly source: SourceReader,
    private readonly log: Logger,
    private readonly options: MigratorOptions = {},
  ) {
    this.aborted = new Promise<never>((_, reject) => {
      this.abort = reject;
    });
    this.aborted.catch(() => undefined);
  }

  /** Fail fast on a node that is not identitee or a key that cannot migrate. */
  async check(): Promise<void> {
    const spec = this.api.runtimeVersion.specName.toString();
    if (spec !== 'identitee') throw new Error(`the node runs ${spec}, not identitee`);
    const entry = (await (this.api.query as Json).identitee.agents(this.agent.address)).toJSON() as [number, number] | null;
    if (entry === null) throw new Error(`${this.agent.address} is not an agent of any authority`);
    if ((entry[1] & MIGRATE) === 0) throw new Error(`${this.agent.address} is an agent of authority ${entry[0]} without the MIGRATE capability`);
    this.log('info', 'agent', { agent: this.agent.address, authority: entry[0], capabilities: entry[1] });
  }

  async start(): Promise<void> {
    await this.check();
    const onHead = (header: Json): void => {
      this.heads = this.heads.then(() => this.onFinalized(header)).catch((e: unknown) => {
        this.log('error', 'finalized-block-failed', { error: messageOf(e) });
      });
    };
    this.unsubscribe = (await this.api.rpc.chain.subscribeFinalizedHeads(onHead)) as unknown as () => void;
    this.sweepTimer = setInterval(() => {
      this.heads = this.heads.then(() => this.sweepFinalized()).catch((e: unknown) => {
        this.log('error', 'sweep-failed', { error: messageOf(e) });
      });
    }, this.options.sweepMs ?? SWEEP_MS);
  }

  /**
   * Stop taking requests. A read of a source in flight is abandoned at once (the request stays
   * pending, nothing was sent); a transaction already sent is waited for, at most `stopWaitMs`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.sweepTimer);
    this.unsubscribe?.();
    this.abort(new Aborted());
    let timer: NodeJS.Timeout | undefined;
    const patience = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref();
    });
    const done = Promise.all([this.heads, this.worker]).then(() => 'done' as const, () => 'done' as const);
    if ((await Promise.race([done, patience])) === 'timeout') {
      this.log('warn', 'stop-timeout', { reason: 'a transaction is still waiting to be included; leaving it' });
    }
    clearTimeout(timer);
  }

  // --- Finding requests ---

  private async onFinalized(header: Json): Promise<void> {
    const number: number = header.number.toNumber();
    if (this.last === undefined) {
      // The first head is the finalized state now: its pending requests are all there is to catch up on.
      this.last = number;
      this.log('info', 'started', { finalized: number, blockHash: header.hash.toHex() });
      await this.sweep(header.hash);
      return;
    }
    for (let block = this.last + 1; block <= number; block++) {
      // One notification can stand for several finalized blocks: read each one's events.
      const hash = block === number ? header.hash : await this.api.rpc.chain.getBlockHash(block);
      const events = (await (await this.api.at(hash)).query.system.events()) as unknown as Json[];
      for (const record of events) {
        const event = record.event;
        if (event.section === 'identitee' && event.method === 'MigrationRequested') {
          const who = event.data[0].toString();
          this.log('info', 'requested', { who, source: event.data[1].toString(), block });
          this.retryAfter.delete(who);
          this.failures.delete(who);
          this.enqueue(who);
        }
      }
      this.last = block;
    }
  }

  private async sweepFinalized(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      await this.sweep(await this.api.rpc.chain.getFinalizedHead());
    } finally {
      this.sweeping = false;
    }
  }

  /** Every request pending at `hash`. Cheap when none is, and it is what catches a request whose event was missed. */
  private async sweep(hash: Json): Promise<void> {
    const at = (await this.api.at(hash)) as Json;
    let startKey: string | undefined;
    let found = 0;
    for (;;) {
      const page = await at.query.identitee.migrationRequests.entriesPaged({ args: [], pageSize: PENDING_PAGE, startKey });
      for (const [key] of page) {
        found++;
        const who = key.args[0].toString();
        if ((this.retryAfter.get(who) ?? 0) > this.now()) continue;
        this.enqueue(who);
      }
      if (page.length < PENDING_PAGE) break;
      startKey = page[page.length - 1][0].toHex();
    }
    if (found > 0) this.log('info', 'pending', { count: found });
  }

  private enqueue(who: string): void {
    if (this.stopping || this.queued.has(who) || this.inFlight === who) return;
    this.queued.add(who);
    this.queue.push(who);
    this.worker = this.worker.then(() => this.drain());
  }

  /**
   * Serve the queue, one request at a time: the agent's nonce is never contended. Calls are
   * chained on `worker`, so two never run at once.
   */
  private async drain(): Promise<void> {
    for (let who = this.queue.shift(); who !== undefined && !this.stopping; who = this.queue.shift()) {
      this.queued.delete(who);
      this.inFlight = who;
      try {
        await this.process(who);
      } catch (e) {
        if (e instanceof Aborted) {
          this.log('info', 'aborted', { who, reason: 'stopping; the request stays pending' });
          continue;
        }
        // A problem that may pass: retry later, with a delay that doubles up to a cap, so that one
        // request that never works costs a line an hour and not a place in the queue.
        const attempt = (this.failures.get(who) ?? 0) + 1;
        const delay = Math.min((this.options.retryBaseMs ?? RETRY_BASE_MS) * 2 ** (attempt - 1), this.options.retryMaxMs ?? RETRY_MAX_MS);
        this.failures.set(who, attempt);
        this.retryAfter.set(who, this.now() + delay);
        this.log('error', 'request-failed', { who, error: messageOf(e), attempt, retryAfterMs: delay });
      } finally {
        this.inFlight = undefined;
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // --- Serving a request ---

  private async process(who: string): Promise<void> {
    const { api } = this;
    // Idempotent: whatever announced this account, only a request still pending is served.
    const pending = ((await (api.query as Json).identitee.migrationRequests(who)) as Json).toJSON() as [SourceName, number] | null;
    if (pending === null) {
      // Withdrawn, or served by someone else: nothing is left to retry.
      this.settled(who);
      this.log('info', 'skipped', { who, reason: 'no pending request' });
      return;
    }
    const [source] = pending;
    // A migration only creates an identity: an account that made one after its request can never be served.
    if (((await (api.query as Json).identitee.identities(who)) as Json).toJSON() !== null) {
      await this.reject(who, source, 'Other', TERMINAL_REJECT['identitee.IdentityExists'] as string);
      return;
    }
    const reading = this.source.read(source, who);
    reading.catch(() => undefined); // abandoned by a stop: its failure is of no interest
    const read = await Promise.race([reading, this.aborted]);
    if (read === 'not-served') {
      // Not an error and not the person's fault: leave the request for a migrator that has this chain.
      this.log('warn', 'not-served', { who, source, reason: 'no snapshot for this chain' });
      this.retryAfter.set(who, this.now() + NOT_SERVED_RETRY_MS);
      return;
    }
    if (read === null) {
      await this.reject(who, source, 'Unspecified', `no identity on the ${source} People Chain`);
      return;
    }
    const out = await this.submit((api.tx as Json).identitee.fulfilMigration(who, source, read.block, read.blockHash, read.payload));
    if (out.error !== undefined && TERMINAL_SKIP.includes(out.error)) {
      this.settled(who);
      this.log('info', 'skipped', { who, reason: out.error === 'identitee.NoMigrationRequest' ? 'the request was withdrawn or served meanwhile' : 'the request changed meanwhile', error: out.error });
    } else if (out.error !== undefined && out.error in TERMINAL_REJECT) {
      // No retry can make this payload or account acceptable: refuse the request.
      this.log('error', 'fulfil-refused', { who, source, error: out.error, sourceBlock: read.block, dropped: read.dropped.map(describeDrop) });
      await this.reject(who, source, 'Other', TERMINAL_REJECT[out.error] as string);
    } else if (out.error !== undefined) {
      throw new Error(`fulfil_migration failed with ${out.error}`);
    } else if (!out.events.includes('identitee.MigrationFulfilled')) {
      throw new Error('the extrinsic succeeded without identitee.MigrationFulfilled');
    } else {
      this.settled(who);
      this.log('info', 'fulfilled', {
        who,
        source,
        sourceBlock: read.block,
        sourceBlockHash: read.blockHash,
        typed: read.payload.typed.map(([kind]) => kind),
        custom: read.payload.custom.length,
        judgements: read.payload.judgements,
        dropped: read.dropped.map(describeDrop),
        blockHash: out.blockHash,
      });
    }
  }

  /** Refuse the request of `who` with `reason`, and say why. */
  private async reject(who: string, source: SourceName, reason: string, cause: string): Promise<void> {
    const out = await this.submit((this.api.tx as Json).identitee.rejectMigration(who, reason));
    if (out.error === 'identitee.NoMigrationRequest') {
      this.settled(who);
      this.log('info', 'skipped', { who, reason: 'the request was withdrawn or served meanwhile', error: out.error });
    } else if (out.error !== undefined) {
      throw new Error(`reject_migration failed with ${out.error}`);
    } else if (!out.events.includes('identitee.MigrationRejected')) {
      throw new Error('the extrinsic succeeded without identitee.MigrationRejected');
    } else {
      this.settled(who);
      this.log('info', 'rejected', { who, source, reason, cause, blockHash: out.blockHash });
    }
  }

  /** The request of `who` is dealt with: forget its failures. */
  private settled(who: string): void {
    this.failures.delete(who);
    this.retryAfter.delete(who);
  }

  /** Sign with the agent, send, and wait for the extrinsic to be in a block. */
  private submit(tx: SubmittableExtrinsic<'promise'>): Promise<Submitted> {
    return submitAndWait(this.api, this.agent, tx, this.options.inclusionTimeoutMs ?? INCLUSION_TIMEOUT_MS);
  }
}

/**
 * Sign `tx` with `agent`, send it, and wait for it to be in a block (at most `timeoutMs`): its
 * events and its dispatch error as `section.Name`. Rejects when the pool refuses it, when it drops
 * out, or on the timeout. Shared by the migrator and the verifier.
 */
export function submitAndWait(api: ApiPromise, agent: KeyringPair, tx: SubmittableExtrinsic<'promise'>, timeoutMs: number): Promise<Submitted> {
  return new Promise<Submitted>((resolve, reject) => {
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
      () => settle(() => reject(new Error(`not in a block after ${timeoutMs / 1000} s`))),
      timeoutMs,
    );
    tx.signAndSend(agent, (result) => {
      if (result.isError) {
        settle(() => reject(new Error(`extrinsic ${result.status.type}`)));
        return;
      }
      if (!result.status.isInBlock) return;
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
      const events = result.events.map(({ event }) => `${event.section}.${event.method}`);
      settle(() => resolve({ events, error, blockHash: result.status.asInBlock.toHex() }));
    })
      .then((u) => {
        unsub = u;
        if (settled) u();
      })
      .catch((e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

const describeDrop = (d: Dropped): string => `${d.field}:${d.reason}`;

// --- Entry point -----------------------------------------------------------------------------

/**
 * The limits the node's runtime enforces, read from its metadata: a node that does not expose one
 * is not an identitee node of this version, and sanitising against a guess would send payloads
 * the runtime refuses, so it is an error. `maxTypedFields` is not a constant of the pallet: its
 * bound (16) is above the number of `FieldKind` variants (10), so no payload reaches it.
 */
export function limitsOf(api: ApiPromise): Limits {
  const c = (api.consts as Json).identitee;
  const read = (name: string): number => {
    const value = c?.[name];
    const n = value === undefined ? Number.NaN : Number(value.toString());
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`the node does not expose the constant identitee.${name} (is it an identitee node of this version?)`);
    }
    return n;
  };
  return {
    maxValueLen: read('maxValueLen'),
    maxCustomKeyLen: read('maxCustomKeyLen'),
    maxCustomFields: read('maxCustomFields'),
    maxTypedFields: DEFAULT_LIMITS.maxTypedFields,
    maxImportedJudgements: read('maxImportedJudgements'),
  };
}

/**
 * Signed extensions of the chain that polkadot.js does not know by name: it encodes nothing for
 * them, which is only right for an extension that carries no data (`AuthorizeCall` is one). The
 * migrator signs real extrinsics, so any other one stops it (same list as src/e2e.ts).
 */
const UNKNOWN_EXTENSIONS_ALLOWED = ['AuthorizeCall'];

export function assertKnownExtensions(api: ApiPromise): void {
  const unexpected = findUnknownExtensions(api.registry.signedExtensions).filter((name) => !UNKNOWN_EXTENSIONS_ALLOWED.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `signed extension(s) unknown to polkadot.js and not allow-listed: ${unexpected.join(', ')}` +
        ` (allowed: ${UNKNOWN_EXTENSIONS_ALLOWED.join(', ')}); check that they carry no data before signing`,
    );
  }
}

export async function connectIdentitee(ws: string): Promise<ApiPromise> {
  const provider = new WsProvider(ws);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cannot connect to ${ws} within 60 s`)), 60_000);
  });
  try {
    const api = await Promise.race([ApiPromise.create({ provider }), timeout]);
    try {
      assertKnownExtensions(api);
    } catch (e) {
      await api.disconnect().catch(() => undefined);
      throw e;
    }
    return api;
  } catch (e) {
    await provider.disconnect().catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with the spec version of the runtime once the node runs another one than `api` was set up
 * with. On an upgrade polkadot.js reloads the metadata through `state_getMetadata`, at version 14,
 * which lists no runtime API: `api.call.identiteeApi`, and the runtime calls of `api.at` for the new
 * runtime, are gone until a new connection. So the services stop then, and systemd starts them again
 * on the new runtime. `stop` ends the subscription. */
export function runtimeUpgrade(api: ApiPromise): { upgraded: Promise<number>; stop: () => void } {
  const from = api.runtimeVersion.specVersion.toNumber();
  let unsubscribe: (() => void) | undefined;
  let stopped = false;
  const upgraded = new Promise<number>((resolve) => {
    api.rpc.state
      .subscribeRuntimeVersion((version) => {
        const spec = version.specVersion.toNumber();
        if (spec !== from) resolve(spec);
      })
      .then(
        (u) => (stopped ? u() : (unsubscribe = u)),
        () => undefined,
      );
  });
  return {
    upgraded,
    stop: () => {
      stopped = true;
      unsubscribe?.();
    },
  };
}

/** Where the identities come from: the snapshot files if there are any, else the People Chains. */
function sourceFor(config: Config, limits: Limits, log: Logger): SourceReader {
  if (config.snapshots.length > 0) {
    return new SnapshotSource(
      config.snapshots.map((file) => {
        const snapshot = parseSnapshot(readFileSync(file, 'utf8'), limits);
        log('info', 'snapshot', {
          file,
          source: snapshot.source,
          block: snapshot.block,
          blockHash: snapshot.blockHash,
          identities: snapshot.byAccount.size,
          dropped: snapshot.dropped.map(({ account, dropped }) => ({ account, dropped: dropped.map(describeDrop) })),
        });
        return snapshot;
      }),
    );
  }
  for (const [source, at] of Object.entries(config.pinned)) log('info', 'people-pinned', { source, at, env: PEOPLE_AT_ENV[source as SourceName] });
  return new LivePeopleSource(limits, log, config.pinned);
}

export interface MainDeps {
  connect: (ws: string) => Promise<ApiPromise>;
  makeSource: (config: Config, limits: Limits, log: Logger) => SourceReader;
  write: (line: string) => void;
  /** Called by a second signal while stopping. */
  exit: (code: number) => void;
  options: MigratorOptions;
}

/** SIGTERM and SIGINT, caught from now on: `stopped` says which came first. */
export function watchSignals(deps: { exit: (code: number) => void }): { stopped: Promise<string>; stopping: () => void; release: () => void } {
  let resolve: (signal: string) => void = () => undefined;
  const stopped = new Promise<string>((r) => {
    resolve = r;
  });
  const onTerm = (): void => resolve('SIGTERM');
  const onInt = (): void => resolve('SIGINT');
  const again = (): void => deps.exit(1);
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  return {
    stopped,
    // Stopping has begun: a second signal ends the process at once.
    stopping: () => {
      process.once('SIGTERM', again);
      process.once('SIGINT', again);
    },
    release: () => {
      for (const handler of [onTerm, onInt, again]) {
        process.removeListener('SIGTERM', handler);
        process.removeListener('SIGINT', handler);
      }
    },
  };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, overrides: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = {
    connect: connectIdentitee,
    makeSource: sourceFor,
    write: (line) => process.stdout.write(line),
    exit: (code) => process.exit(code),
    options: {},
    ...overrides,
  };
  let config: Config;
  try {
    config = parseConfig(argv, env);
  } catch (e) {
    // Bad arguments, a missing key, a malformed PEOPLE_AT_BLOCK_*: said once, before anything starts.
    process.stderr.write(`${messageOf(e)}\n`);
    return 2;
  }
  const log = makeLogger([config.suri], deps.write);
  // Caught before anything slow starts: a SIGTERM during the connection or a read must not kill the process with 143.
  const signals = watchSignals(deps);
  try {
    return await run(config, log, deps, signals);
  } finally {
    signals.release();
  }
}

async function run(config: Config, log: Logger, deps: MainDeps, signals: ReturnType<typeof watchSignals>): Promise<number> {
  let pair: KeyringPair;
  try {
    await cryptoWaitReady();
    pair = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX }).addFromUri(config.suri);
  } catch {
    // The reason is not printed: it could quote the key.
    log('error', 'fatal', { error: 'IDENTITEE_MIGRATOR_SURI is not a valid secret URI' });
    return 1;
  }
  if (config.snapshots.length > 0 && Object.keys(config.pinned).length > 0) {
    log('warn', 'people-pinned-ignored', {
      env: Object.keys(config.pinned).map((source) => PEOPLE_AT_ENV[source as SourceName]),
      reason: '--snapshot files carry their own block: the People Chains are not read',
    });
  }

  const connecting = deps.connect(config.ws);
  connecting.catch(() => undefined); // judged below; a stop first must not leave it unhandled
  let api: ApiPromise | undefined;
  let source: SourceReader | undefined;
  let migrator: Migrator | undefined;
  try {
    const first = await Promise.race([connecting.then((connected) => ({ connected })), signals.stopped.then((signal) => ({ signal }))]);
    if ('signal' in first) {
      log('info', 'stopping', { signal: first.signal, during: 'connecting' });
      void connecting.then((late) => late.disconnect()).catch(() => undefined);
      log('info', 'stopped');
      return 0;
    }
    api = first.connected;
    const limits = limitsOf(api);
    source = deps.makeSource(config, limits, log);
    log('info', 'connected', { ws: config.ws, chain: api.runtimeVersion.specName.toString(), mode: config.snapshots.length > 0 ? 'snapshot' : 'live' });
    migrator = new Migrator(api, pair, source, log, deps.options);
    await migrator.start();
  } catch (e) {
    log('error', 'fatal', { error: messageOf(e) });
    await migrator?.stop();
    await source?.close();
    await api?.disconnect().catch(() => undefined);
    return 1;
  }

  const upgrade = runtimeUpgrade(api);
  const stop = await Promise.race([signals.stopped.then((signal) => ({ signal })), upgrade.upgraded.then((specVersion) => ({ specVersion }))]);
  upgrade.stop();
  if ('signal' in stop) log('info', 'stopping', { signal: stop.signal });
  else log('warn', 'stopping', { reason: 'runtime_upgraded', specVersion: stop.specVersion });
  signals.stopping();
  await migrator.stop();
  await source.close();
  await api.disconnect().catch(() => undefined);
  log('info', 'stopped');
  // an upgrade is not a failure, but only a failure makes systemd start the service again
  return 'signal' in stop ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fatal: ${messageOf(e)}\n`);
      process.exit(1);
    },
  );
}
