// The explorer indexer: follows the finalized blocks of a node and writes each one, decoded, to the
// store (store.ts), strictly in order, one transaction per block. A restart resumes after the last
// stored block, so a crash in the middle of a block costs nothing but its re-ingestion. Blocks are
// decoded with the registry of the runtime in force at each block (`api.at(hash)`).

import type { ApiPromise } from '@polkadot/api';
import type { Call, DispatchError, EventRecord, SignedBlock } from '@polkadot/types/interfaces';
import type { Codec } from '@polkadot/types/types';
import { hexToU8a, isHex, u8aToString } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';

import type { Logger } from '../migrator.ts';
import {
  accountsIn,
  AURA_AUTHORITIES_KEY,
  auraAuthor,
  auraAuthorityKeys,
  auraSlot,
  eventData,
  justificationSigners,
  toJson,
  walkCall,
  type WalkedCall,
} from './decode.ts';
import { sentence } from './sentences.ts';
import type {
  AccountLink,
  AttestationKind,
  AttestationRow,
  BlockRow,
  EventRow,
  ExplorerStore,
  ExtrinsicRow,
  Extras,
  MigrationKind,
  MigrationRow,
  TransferRow,
  UsernameKind,
  UsernameRow,
} from './store.ts';

type Json = any;

/** Bytes longer than this are stored as their length and hash. */
const MAX_BYTES = 4096;
const PROGRESS_EVERY = 1000;

// --- Pure helpers --------------------------------------------------------------------------------

function digest(bytes: Uint8Array): { bytes: number; hash: string } {
  return { bytes: bytes.length, hash: blake2AsHex(bytes, 256) };
}

function bytesOf(s: string): Uint8Array {
  return isHex(s) ? hexToU8a(s) : new TextEncoder().encode(s);
}

/**
 * `value` with every string over 4 KB (hex bytes or text, as `toJson` renders `Bytes`) replaced by
 * `{ bytes: <length>, hash: <blake2-256 hex> }`, so that a runtime upload does not land in the index.
 */
export function truncateLarge(value: unknown): unknown {
  if (typeof value === 'string') {
    // a quick bound first: a string of n characters is at least n / 2 bytes in hex, n in text
    if (value.length <= MAX_BYTES) return value;
    const bytes = bytesOf(value);
    return bytes.length > MAX_BYTES ? digest(bytes) : value;
  }
  if (Array.isArray(value)) return value.map(truncateLarge);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateLarge(v)]));
  }
  return value;
}

const isPlaceholder = (v: unknown): v is { pallet: string; method: string } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 2 &&
  typeof (v as Json).pallet === 'string' && typeof (v as Json).method === 'string';

/**
 * The arguments of a walked call with each nested call (`{ pallet, method }` in `args`) replaced by
 * the call in full, `{ pallet, method, args }`, recursively. `walkCall` lists the nested calls of
 * a level in `inner` in the order it meets them, which is the order of this traversal.
 */
export function callArgs(call: WalkedCall): Record<string, unknown> {
  const queue = [...call.inner];
  const expand = (v: unknown): unknown => {
    if (isPlaceholder(v) && queue[0]?.pallet === v.pallet && queue[0]?.method === v.method) {
      const nested = queue.shift()!;
      return { pallet: nested.pallet, method: nested.method, args: callArgs(nested) };
    }
    if (Array.isArray(v)) return v.map(expand);
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
    return v;
  };
  return expand(call.args) as Record<string, unknown>;
}

type FeedRow =
  | { feed: 'transfers'; row: TransferRow }
  | { feed: 'attestations'; row: AttestationRow }
  | { feed: 'migrations'; row: MigrationRow }
  | { feed: 'usernames'; row: UsernameRow };

const ATTESTATIONS: Record<string, AttestationKind> = {
  AttestationRequested: 'requested',
  RequestCancelled: 'cancelled',
  FieldAttested: 'attested',
  AttestationRevoked: 'revoked',
  RequestRejected: 'rejected',
  FactGranted: 'attested',
  FactRevoked: 'revoked',
};
const MIGRATIONS: Record<string, MigrationKind> = {
  MigrationRequested: 'requested',
  MigrationCancelled: 'cancelled',
  MigrationFulfilled: 'fulfilled',
  MigrationRejected: 'rejected',
};
const USERNAMES: Record<string, UsernameKind> = {
  NameClaimed: 'claimed',
  NameReleased: 'released',
  NameReserved: 'reserved',
  NameUnreserved: 'unreserved',
  NameAssigned: 'assigned',
  NameRevoked: 'revoked',
};

const omit = (d: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => !keys.includes(k)));

/**
 * The feed row an event feeds, if any. Attestation targets all read as the runtime's `Target`:
 * `{ Field: <field key> }` or `{ Fact: <fact kind> }`, whichever event they come from.
 */
export function feedRow(
  pallet: string,
  method: string,
  d: Record<string, unknown>,
  at: { block: number; eventId: string; extrinsicId: string | null },
): FeedRow | null {
  const { block, eventId } = at;
  if (pallet === 'balances' && method === 'Transfer') {
    return { feed: 'transfers', row: { from: d.from as string, to: d.to as string, amount: String(d.amount), block, extrinsicId: at.extrinsicId, eventId } };
  }
  if (pallet !== 'identitee') return null;
  const attestation = ATTESTATIONS[method];
  if (attestation !== undefined) {
    const target = 'target' in d ? d.target : 'key' in d ? { Field: d.key } : { Fact: d.kind };
    const rest = omit(d, 'who', 'authority', 'target', 'key', 'kind');
    return {
      feed: 'attestations',
      row: { who: d.who as string, authorityId: d.authority as number, kind: attestation, target, data: Object.keys(rest).length === 0 ? null : rest, block, eventId },
    };
  }
  const migration = MIGRATIONS[method];
  if (migration !== undefined) return { feed: 'migrations', row: { who: d.who as string, kind: migration, data: omit(d, 'who'), block, eventId } };
  const username = USERNAMES[method];
  if (username !== undefined) {
    return { feed: 'usernames', row: { name: d.name as string, who: typeof d.who === 'string' ? d.who : null, kind: username, block, eventId } };
  }
  return null;
}

/** A dispatch error as `{ pallet, name, docs }`: the module error from the metadata, or the kind. */
function dispatchError(err: DispatchError, registry: { findMetaError(e: Json): { section: string; name: string; docs: string[] } }): ExtrinsicRow['error'] {
  if (err.isModule) {
    try {
      const meta = registry.findMetaError(err.asModule);
      return { pallet: meta.section, name: meta.name, docs: meta.docs.join(' ').trim() };
    } catch {
      return { pallet: 'unknown', name: err.asModule.toHex(), docs: '' };
    }
  }
  // `Token(FundsUnavailable)` reads as pallet "Token", name "FundsUnavailable"; `BadOrigin` as "", "BadOrigin".
  const inner = (err as Json).inner as Json;
  if (inner && typeof inner.type === 'string' && !inner.isEmpty) return { pallet: err.type, name: inner.type, docs: '' };
  return { pallet: '', name: err.type, docs: '' };
}

const lower = (c: { toHex(): string }): string => c.toHex().toLowerCase();

// --- Indexer -------------------------------------------------------------------------------------

export interface IndexerOptions {
  /** First wait before retrying a block that failed while following; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Called once the node is found on another chain than the index (the store is marked for a rebuild). */
  onChainChanged?: (reason: string) => void;
}

/**
 * The node no longer serves the chain in the index: a testnet reset, or a node restored from a
 * backup that then built other blocks. The store is marked so that the next start re-indexes from
 * scratch; the process is expected to exit and be started again.
 */
export class ChainChangedError extends Error {
  constructor(readonly reason: string) {
    super(`the node serves another chain than the index (${reason})`);
    this.name = 'ChainChangedError';
  }
}

export interface Heads {
  best: number;
  finalized: number;
}

export class Indexer {
  private best = 0;
  private finalized = 0;
  private starting = false;
  private stopped = false;
  private running: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private unsubs: Array<() => void> = [];
  private listeners: Array<(h: Heads) => void> = [];
  private authorityNames = new Map<number, string>();
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly onChainChanged: ((reason: string) => void) | undefined;
  private changed: ChainChangedError | null = null;

  constructor(
    private readonly api: ApiPromise,
    private readonly store: ExplorerStore,
    private readonly log: Logger,
    options: IndexerOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 1000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.onChainChanged = options.onChainChanged;
  }

  /** Called on every change of the best or finalized height. */
  onHead(cb: (h: Heads) => void): void {
    this.listeners.push(cb);
  }

  heads(): Heads {
    return { best: this.best, finalized: this.finalized };
  }

  /**
   * Tie the store to the node's chain, catch up with the finalized head (resolves once there;
   * rejects if a block fails on the way), then follow finality in the background.
   */
  async start(): Promise<void> {
    if (this.changed !== null) throw this.changed;
    this.stopped = false;
    this.starting = true;
    try {
      const genesis = lower(this.api.genesisHash);
      if (this.store.openForGenesis(genesis).reset) this.log('warn', 'genesis_changed', { genesis });
      await this.verifyChain();
      this.watchReconnects();
      this.unsubs.push(
        await this.api.rpc.chain.subscribeFinalizedHeads((h) => {
          this.setHeads(this.best, h.number.toNumber());
          this.follow();
        }),
      );
      this.unsubs.push(await this.api.rpc.chain.subscribeNewHeads((h) => this.setHeads(h.number.toNumber(), this.finalized)));
      const head = await this.api.rpc.chain.getHeader(await this.api.rpc.chain.getFinalizedHead());
      this.setHeads(this.best, head.number.toNumber());
      const from = (this.store.lastIndexed() ?? -1) + 1;
      this.log('info', 'catch_up', { from, to: this.finalized });
      await this.drain();
      this.log('info', 'caught_up', { indexed: this.store.lastIndexed() });
    } catch (e) {
      this.starting = false;
      await this.stop();
      throw e;
    }
    this.starting = false;
    this.follow();
  }

  /** Stop following; an ingestion in progress finishes (its block is written whole or not at all). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const unsub of this.unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // the connection is gone
      }
    }
    await this.running;
  }

  /**
   * Check that the node still serves the indexed chain: the same block 0, and the same hash at the
   * highest height both have. Throws `ChainChangedError` (after marking the store) if not.
   */
  async verifyChain(): Promise<void> {
    const genesis = lower(await this.api.rpc.chain.getBlockHash(0));
    const stored = this.store.genesis();
    if (stored !== null && genesis !== stored) this.chainChanged('genesis', { stored, node: genesis });
    const last = this.store.lastIndexed();
    if (last === null || last === 0) return;
    const finalized = (await this.api.rpc.chain.getHeader(await this.api.rpc.chain.getFinalizedHead())).number.toNumber();
    const at = Math.min(last, finalized);
    if (at === 0) return;
    const node = lower(await this.api.rpc.chain.getBlockHash(at));
    const ours = this.store.block(at)?.hash;
    if (ours !== undefined && node !== ours) this.chainChanged('block_hash', { block: at, stored: ours, node });
  }

  /** polkadot.js keeps the first genesis across reconnections: check the chain again on each one. */
  private watchReconnects(): void {
    const api = this.api as unknown as { on?(e: string, cb: () => void): unknown; off?(e: string, cb: () => void): unknown };
    if (typeof api.on !== 'function') return;
    const onConnected = (): void => {
      this.verifyChain().catch((e: unknown) => {
        if (!(e instanceof ChainChangedError)) this.log('warn', 'chain_check_failed', { error: e instanceof Error ? e.message : String(e) });
      });
    };
    api.on('connected', onConnected);
    this.unsubs.push(() => api.off?.('connected', onConnected));
  }

  /** Log, mark the store for a rebuild, tell the owner (once), and throw. */
  private chainChanged(reason: string, details: Record<string, unknown>): never {
    if (this.changed === null) {
      this.changed = new ChainChangedError(reason);
      this.log('error', 'chain_changed', { reason, ...details });
      this.store.markChainChanged();
      this.stopped = true;
      this.onChainChanged?.(reason);
    }
    throw this.changed;
  }

  private setHeads(best: number, finalized: number): void {
    const f = Math.max(this.finalized, finalized);
    const b = Math.max(best, f);
    if (b === this.best && f === this.finalized) return;
    this.best = b;
    this.finalized = f;
    for (const cb of this.listeners) {
      try {
        cb({ best: b, finalized: f });
      } catch (e) {
        this.log('error', 'head_listener_failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private next(): number {
    return (this.store.lastIndexed() ?? -1) + 1;
  }

  /** Ingest every block up to the finalized head, which may move meanwhile. */
  private async drain(): Promise<void> {
    while (!this.stopped && this.next() <= this.finalized) {
      const n = this.next();
      await this.ingest(n);
      if (n % PROGRESS_EVERY === 0 && n > 0) this.log('info', 'indexed', { block: n, finalized: this.finalized });
    }
  }

  /** Drain in the background; on a failure, log and retry later with a growing wait. */
  private follow(): void {
    if (this.starting || this.stopped || this.running !== null || this.retryTimer !== null) return;
    if (this.next() > this.finalized) return;
    this.running = this.drain()
      .then(
        () => {
          this.failures = 0;
        },
        (e: unknown) => {
          if (e instanceof ChainChangedError) return;
          this.failures++;
          const wait = Math.min(this.retryMs * 2 ** (this.failures - 1), this.maxRetryMs);
          this.log('warn', 'ingest_failed', { block: this.next(), error: e instanceof Error ? e.message : String(e), retryInMs: wait });
          if (!this.stopped) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              this.follow();
            }, wait);
          }
        },
      )
      .finally(() => {
        this.running = null;
        // a head that arrived as the drain was ending
        this.follow();
      });
  }

  /** Fetch block `n`, decode it and write it with one `writeBlock`. `n` must be the next block. */
  async ingest(n: number): Promise<void> {
    const expected = this.next();
    if (n !== expected) throw new Error(`ingest(${n}): the next block to index is ${expected}`);
    const api = this.api;
    const hash = await api.rpc.chain.getBlockHash(n);
    const signed: SignedBlock = await api.rpc.chain.getBlock(hash);
    const at = await api.at(hash);
    const query = at.query as Json;
    const header = signed.block.header;
    if (n > 0) {
      const parent = this.store.block(n - 1)?.hash;
      const claimed = lower(header.parentHash);
      if (parent !== undefined && claimed !== parent) this.chainChanged('parent_hash', { block: n, stored: parent, node: claimed });
    }
    const [records, now, setId] = (await Promise.all([query.system.events(), query.timestamp.now(), query.grandpa.currentSetId()])) as [
      EventRecord[],
      { toNumber(): number },
      { toNumber(): number },
    ];

    let author: string | null = null;
    const slot = auraSlot(header.digest.logs);
    if (slot !== null && n > 0) {
      // The authorities at the parent, read raw: see `auraAuthorityKeys`.
      const raw = (await api.rpc.state.getStorage(AURA_AUTHORITIES_KEY, header.parentHash)) as Json;
      const keys = raw.isSome ? auraAuthorityKeys(raw.unwrap().toU8a(true)) : [];
      if (keys.length > 0) author = auraAuthor(slot, keys);
    }

    let signers: string[] | null = null;
    const justifications = signed.justifications as Json;
    if (justifications.isSome) {
      for (const [engine, data] of justifications.unwrap() as Array<[Codec, Codec & { toU8a(bare?: boolean): Uint8Array }]>) {
        if (u8aToString(engine.toU8a()) === 'FRNK') signers = justificationSigners(data.toU8a(true), at.registry);
      }
    }

    // Events first: they give each extrinsic its result and fee.
    const outcome = new Map<number, ExtrinsicRow['error']>();
    const fees = new Map<number, string>();
    const links: AccountLink[] = [];
    const extras: Extras = { transfers: [], attestations: [], migrations: [], usernames: [] };
    const decoded = records.map((record, index) => {
      const { event, phase } = record;
      const xi = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : null;
      const data = truncateLarge(eventData(event)) as Record<string, unknown>;
      if (xi !== null && event.section === 'system') {
        if (event.method === 'ExtrinsicSuccess') outcome.set(xi, null);
        if (event.method === 'ExtrinsicFailed') outcome.set(xi, dispatchError(event.data[0] as DispatchError, at.registry));
      }
      if (xi !== null && event.section === 'transactionPayment' && event.method === 'TransactionFeePaid') fees.set(xi, String(data.actual_fee));
      const id = `${n}-${index}`;
      for (const address of accountsIn(event)) links.push({ address, itemKind: 'event', itemId: id, block: n });
      const feed = feedRow(event.section, event.method, data, { block: n, eventId: id, extrinsicId: xi === null ? null : `${n}-${xi}` });
      if (feed !== null) (extras[feed.feed] as unknown[]).push(feed.row);
      return { index, xi, pallet: event.section, method: event.method, data };
    });

    await this.loadAuthorityNames(decoded, at.query as Json);
    const ctx = { authorityName: (id: number) => this.authorityNames.get(id) ?? null };
    const evs: EventRow[] = decoded.map((e) => ({
      id: `${n}-${e.index}`,
      block: n,
      index: e.index,
      extrinsicIndex: e.xi,
      pallet: e.pallet,
      method: e.method,
      data: e.data,
      sentence: sentence(e.pallet, e.method, e.data, ctx),
    }));

    const xts: ExtrinsicRow[] = signed.block.extrinsics.map((xt, index) => {
      const walked = walkCall(xt.method as unknown as Call);
      let args = truncateLarge(callArgs(walked)) as Record<string, unknown>;
      // a runtime upload is never stored, whatever its size
      if (walked.pallet === 'system' && walked.method.startsWith('set_code') && typeof args.code === 'string') {
        args = { ...args, code: digest(bytesOf(args.code)) };
      }
      const id = `${n}-${index}`;
      for (const address of accountsIn(xt)) links.push({ address, itemKind: 'extrinsic', itemId: id, block: n });
      const error = outcome.get(index) ?? null;
      return {
        id,
        block: n,
        index,
        hash: lower(xt.hash),
        pallet: walked.pallet,
        method: walked.method,
        args,
        signer: xt.isSigned ? (toJson(xt.signer) as string) : null,
        nonce: xt.isSigned ? xt.nonce.toNumber() : null,
        tip: xt.isSigned ? xt.tip.toString() : null,
        // a signed extrinsic without TransactionFeePaid was feeless
        fee: fees.get(index) ?? (xt.isSigned ? '0' : null),
        success: error === null,
        error,
      };
    });

    const timestamp = now.toNumber();
    const block: BlockRow = {
      number: n,
      hash: lower(hash),
      parentHash: lower(header.parentHash),
      stateRoot: lower(header.stateRoot),
      extrinsicsRoot: lower(header.extrinsicsRoot),
      timestamp: timestamp === 0 ? null : timestamp,
      specVersion: at.runtimeVersion.specVersion.toNumber(),
      author,
      authoritySetId: setId.toNumber(),
      justificationSigners: signers,
      extrinsicCount: xts.length,
      eventCount: evs.length,
    };
    this.store.recordRuntime(block.specVersion, n, at.runtimeVersion.specName.toString());
    this.store.writeBlock(block, xts, evs, links, extras);
  }

  /** Authority names for the sentences: read at this block when an event names an unknown one. */
  private async loadAuthorityNames(events: Array<{ pallet: string; data: Record<string, unknown> }>, query: Json): Promise<void> {
    const missing = events.some(
      (e) => e.pallet === 'identitee' && typeof e.data.authority === 'number' && !this.authorityNames.has(e.data.authority),
    );
    if (!missing) return;
    const entries = (await query.identitee.authorities.entries()) as Array<[Json, Json]>;
    for (const [key, info] of entries) {
      const value = toJson(info) as { name?: unknown } | null;
      if (value !== null && typeof value.name === 'string') this.authorityNames.set(key.args[0].toNumber(), value.name);
    }
  }
}
