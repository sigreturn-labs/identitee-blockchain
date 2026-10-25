// The explorer's read-only JSON API on node:http, behind nginx: GET only, CORS for the explorer's
// origins, errors as `{ "error": "<code>" }` (400 or 404 on bad input, 503 when a route needs the
// node and it is down, never a 500 for input). Indexed data is served from the store whatever the
// node does; live state (balances, identities, roles, authorities, validators) comes through `Live`.
// `/api/live` is a Server-Sent Events stream of the heads.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ApiPromise } from '@polkadot/api';
import type { Metadata } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import type { Logger } from '../migrator.ts';
import { profileUrl } from './config.ts';
import { SS58_PREFIX, toJson } from './decode.ts';
import type { Heads } from './indexer.ts';
import * as state from './state.ts';
import { BadCursorError, type BlockRow, type EventRow, type ExtrinsicRow, type ExplorerStore, type HistoryItem } from './store.ts';

type Json = any;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const BLOCK_TIME_MS = 6000;
const LIVE_TIMEOUT_MS = 5000;
const MAX_QUERY = 128;
const WARN_EVERY_MS = 60_000;

// --- Live state ----------------------------------------------------------------------------------

export interface Balance {
  free: string;
  reserved: string;
  frozen: string;
}

export interface Item {
  name: string;
  docs: string;
}

export interface PalletInfo {
  name: string;
  index: number;
  calls: Item[];
  events: Item[];
  errors: Item[];
  storage: Item[];
  constants: Item[];
}

export interface RuntimeInfo {
  specName: string;
  specVersion: number;
  pallets: PalletInfo[];
}

/** What the API reads from the node. Every promise rejects when the node is down. */
export interface Live {
  connected(): boolean;
  /** The runtime version the node runs, null if unknown. */
  specVersion(): number | null;
  account(address: string): Promise<Balance & { nonce: number }>;
  identitySummary(address: string): Promise<state.IdentitySummary>;
  roles(address: string): Promise<state.Roles>;
  authorities(): Promise<state.AuthorityState[]>;
  validators(): Promise<state.Validators>;
  health(): Promise<state.Health>;
  /** The owner of a username (SS58), null if nobody holds it. */
  nameOwner(name: string): Promise<string | null>;
  /** The current runtime and its pallets (from the metadata in memory), null if not known yet. */
  runtime(): RuntimeInfo | null;
  /** The digest logs of the header of a block. */
  blockLogs(blockHash: string): Promise<DigestLog[]>;
  /** The GRANDPA authority keys (lowercase hex) in the state at a block. */
  grandpaAuthorities(blockHash: string): Promise<string[]>;
}

/** One item of a block header's digest; `data` is hex, `engine` the 4-character consensus engine id. */
export interface DigestLog {
  type: string;
  engine: string | null;
  data: string;
}

export interface HeadSource {
  heads(): Heads;
  onHead(cb: (h: Heads) => void): void;
}

/** The node is not reachable, or did not answer in time: expected, never logged. */
class NodeUnavailable extends Error {}

const down = (): Promise<never> => Promise.reject(new NodeUnavailable('no node'));

/** Before the first connection to the node. */
export const OFFLINE: Live = {
  connected: () => false,
  specVersion: () => null,
  account: down,
  identitySummary: down,
  roles: down,
  authorities: down,
  validators: down,
  health: down,
  nameOwner: down,
  runtime: () => null,
  blockLogs: down,
  grandpaAuthorities: down,
};

const PRINTABLE_ENGINE = /^[\x20-\x7e]{4}$/;

/** The digest items of a header: type, consensus engine (ASCII like `aura`, else hex) and bytes. */
export function digestLogs(header: Json): DigestLog[] {
  return header.digest.logs.map((log: Json): DigestLog => {
    const type = log.type as string;
    if (log.isConsensus || log.isSeal || log.isPreRuntime) {
      const [id, data] = log.value as [Json, Json];
      const raw = id.toU8a() as Uint8Array;
      const text = Buffer.from(raw).toString('latin1');
      return { type, engine: PRINTABLE_ENGINE.test(text) ? text : u8aToHex(raw), data: data.toHex() };
    }
    return { type, engine: null, data: log.value.toHex() };
  });
}

const docsOf = (docs: Array<{ toString(): string }>): string => docs.map((d) => d.toString().trim()).join('\n').trim();

/** Every pallet of the metadata with the names and docs of its calls, events, errors, storage and constants. */
export function palletsOf(metadata: Metadata): PalletInfo[] {
  const latest = metadata.asLatest as Json;
  const lookup = metadata.registry.lookup;
  const variants = (opt: Json): Item[] => {
    if (opt.isNone) return [];
    const def = lookup.getSiType(opt.unwrap().type).def;
    if (!def.isVariant) return [];
    return def.asVariant.variants.map((v: Json) => ({ name: v.name.toString(), docs: docsOf(v.docs) }));
  };
  return latest.pallets.map((p: Json) => ({
    name: p.name.toString(),
    index: p.index.toNumber(),
    calls: variants(p.calls),
    events: variants(p.events),
    errors: variants(p.errors),
    storage: p.storage.isSome ? p.storage.unwrap().items.map((s: Json) => ({ name: s.name.toString(), docs: docsOf(s.docs) })) : [],
    constants: p.constants.map((c: Json) => ({ name: c.name.toString(), docs: docsOf(c.docs) })),
  }));
}

/** `Live` over a connected `ApiPromise` (which reconnects by itself). */
export function chainLive(api: ApiPromise, labels: Record<string, string>): Live {
  let pallets: { version: number; list: PalletInfo[] } | null = null;
  const up = <T>(read: () => Promise<T>): Promise<T> => (api.isConnected ? read() : down());
  return {
    connected: () => api.isConnected,
    specVersion: () => api.runtimeVersion.specVersion.toNumber(),
    account: (address) =>
      up(async () => {
        const info = (await api.query.system.account(state.publicKey(address))) as Json;
        const d = info.data;
        return { free: d.free.toString(), reserved: d.reserved.toString(), frozen: (d.frozen ?? d.miscFrozen).toString(), nonce: info.nonce.toNumber() };
      }),
    identitySummary: (address) => up(() => state.identitySummary(api, address)),
    roles: (address) => up(() => state.roles(api, address)),
    authorities: () => up(() => state.authorities(api)),
    validators: () => up(() => state.validators(api, labels)),
    health: () => up(() => state.health(api)),
    nameOwner: (name) =>
      up(async () => {
        const owner = toJson(await (api.query as Json).identitee.nameOwner(name));
        return typeof owner === 'string' ? owner : null;
      }),
    blockLogs: (blockHash) => up(async () => digestLogs(await api.rpc.chain.getHeader(blockHash))),
    grandpaAuthorities: (blockHash) => up(() => state.grandpaMembers(api, blockHash)),
    runtime: () => {
      const version = api.runtimeVersion.specVersion.toNumber();
      if (pallets === null || pallets.version !== version) pallets = { version, list: palletsOf(api.runtimeMetadata) };
      return { specName: api.runtimeVersion.specName.toString(), specVersion: version, pallets: pallets.list };
    },
  };
}

// --- Shapes --------------------------------------------------------------------------------------

export interface CallRef {
  pallet: string;
  method: string;
}

/** The calls nested in decoded call arguments, depth first (`sudo` wraps one, a batch would wrap several). */
export function callSummary(args: unknown): CallRef[] {
  const out: CallRef[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.pallet === 'string' && typeof v.method === 'string' && 'args' in v) {
      out.push({ pallet: v.pallet, method: v.method });
      walk(v.args, depth + 1);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
}

export type ExtrinsicSummary = Omit<ExtrinsicRow, 'args'> & { inner: CallRef[] };

export function summarize(x: ExtrinsicRow): ExtrinsicSummary {
  const { args, ...rest } = x;
  return { ...rest, inner: callSummary(args) };
}

// --- HTTP ----------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const notFound = (): ApiError => new ApiError(404, 'not_found');

/** An answer on a cacheable route that lacks parts the node could not give: sent, but not to be kept. */
class Uncached {
  constructor(readonly value: unknown) {}
}

type Params = string[];
type Route = [RegExp, (params: Params, query: URLSearchParams) => unknown | Promise<unknown>, cacheable?: boolean];

const HASH = /^0x[0-9a-f]{64}$/;
const POSITION = /^\d{1,10}-\d{1,6}$/;
const NAME = /^[a-z0-9_-]{3,32}$/;
const IDENT = /^[A-Za-z0-9_]{1,64}$/;

/** An SS58 address (any prefix) or a 32-byte hex public key, as an SS58 2426 address; null if invalid. */
export function normalizeAddress(input: string): string | null {
  if (input.length === 0 || input.length > 66) return null;
  try {
    if (input.startsWith('0x')) return /^0x[0-9a-fA-F]{64}$/.test(input) ? encodeAddress(input.toLowerCase(), SS58_PREFIX) : null;
    const bytes = decodeAddress(input);
    return bytes.length === 32 ? encodeAddress(bytes, SS58_PREFIX) : null;
  } catch {
    return null;
  }
}

export interface ExplorerApiOptions {
  store: ExplorerStore;
  live?: Live;
  heads?: HeadSource;
  origins: string[];
  /** Names of validator keys (hex key to label), the keys in any case. */
  labels?: Record<string, string>;
  log: Logger;
  /** How long a read from the node may take (default 5 s). */
  liveTimeoutMs?: number;
  /** SSE comment ping (default 20 s). */
  pingMs?: number;
  /** How often the SSE stream checks whether the index moved (default 1 s). */
  pollMs?: number;
  /** Most SSE clients at once (default 1000); more get 503 `too_many_clients`. */
  maxClients?: number;
  /** Bytes a client may leave unread before it is dropped (default 64 KB). */
  maxBuffer?: number;
}

export class ExplorerApi {
  private readonly store: ExplorerStore;
  private live: Live;
  private headSource: HeadSource | null = null;
  private readonly origins: Set<string>;
  private readonly log: Logger;
  private readonly routes: Route[];
  private readonly clients = new Set<ServerResponse>();
  private lastSent = '';
  private server: Server | undefined;
  private timers: NodeJS.Timeout[] = [];
  private readonly pingMs: number;
  private readonly pollMs: number;
  private readonly maxClients: number;
  private readonly maxBuffer: number;
  private readonly labels = new Map<string, string>();
  private readonly liveTimeoutMs: number;
  private readonly warned = new Map<string, number>();

  constructor(options: ExplorerApiOptions) {
    this.store = options.store;
    for (const [key, label] of Object.entries(options.labels ?? {})) this.labels.set(key.toLowerCase(), label);
    this.liveTimeoutMs = options.liveTimeoutMs ?? LIVE_TIMEOUT_MS;
    this.live = options.live ?? OFFLINE;
    this.origins = new Set(options.origins);
    this.log = options.log;
    this.pingMs = options.pingMs ?? 20_000;
    this.pollMs = options.pollMs ?? 1000;
    this.maxClients = options.maxClients ?? 1000;
    this.maxBuffer = options.maxBuffer ?? 64 * 1024;
    if (options.heads !== undefined) this.attach(this.live, options.heads);
    this.routes = this.table();
  }

  /** Switch to the node's live state and heads once connected. */
  attach(live: Live, heads: HeadSource): void {
    this.live = live;
    this.headSource = heads;
    heads.onHead(() => this.broadcast());
  }

  listen(port: number, host: string): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    this.timers.push(setInterval(() => this.broadcast(), this.pollMs), setInterval(() => this.ping(), this.pingMs));
    for (const t of this.timers) t.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    for (const t of this.timers.splice(0)) clearInterval(t);
    for (const res of this.clients) res.end();
    this.clients.clear();
    const server = this.server;
    if (server === undefined) return Promise.resolve();
    this.server = undefined;
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // --- Heads ---

  /** The node's heads are only known while it is reachable: the last ones seen are not reported as current. */
  private headState(): { best: number | null; finalized: number | null; indexed: number | null } {
    const h = this.live.connected() ? this.headSource?.heads() : undefined;
    return { best: h?.best ?? null, finalized: h?.finalized ?? null, indexed: this.store.lastIndexed() };
  }

  private broadcast(): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(this.headState());
    if (data === this.lastSent) return;
    this.lastSent = data;
    for (const res of this.clients) this.send(res, `event: head\ndata: ${data}\n\n`);
  }

  private ping(): void {
    for (const res of this.clients) this.send(res, ': ping\n\n');
  }

  /** Write to a stream client, or drop it if it does not read what it was sent. */
  private send(res: ServerResponse, chunk: string): void {
    if (res.writableLength > this.maxBuffer) {
      this.clients.delete(res);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  private stream(res: ServerResponse, headers: Record<string, string>): void {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(503, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'too_many_clients' }));
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write(`event: head\ndata: ${JSON.stringify(this.headState())}\n\n`);
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  // --- Requests ---

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Vary on every answer: a shared cache must not hand a response without CORS to an allowed origin
    const headers: Record<string, string> = { 'x-content-type-options': 'nosniff', vary: 'Origin' };
    const origin = req.headers.origin;
    if (origin !== undefined && this.origins.has(origin)) headers['access-control-allow-origin'] = origin;
    const json = (status: number, value: unknown, cache = 'no-store'): void => {
      res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': cache });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') {
        headers.allow = 'GET';
        return json(405, { error: 'method_not_allowed' });
      }
      const url = new URL(req.url ?? '/', 'http://explorer');
      if (url.pathname === '/api/live') return this.stream(res, headers);
      for (const [pattern, handler, cacheable] of this.routes) {
        const m = pattern.exec(url.pathname);
        if (m === null) continue;
        let params: Params;
        try {
          params = m.slice(1).map((p) => decodeURIComponent(p));
        } catch {
          throw new ApiError(400, 'bad_request');
        }
        const out = await handler(params, url.searchParams);
        if (out instanceof Uncached) return json(200, out.value);
        return json(200, out, cacheable ? 'public, max-age=300' : 'no-store');
      }
      throw notFound();
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { error: e.code });
      if (e instanceof BadCursorError) return json(400, { error: 'bad_cursor' });
      this.log('error', 'request_failed', { path: (req.url ?? '').split('?')[0], error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) json(500, { error: 'internal' });
      else res.end();
    }
  }

  /** A live read, or 503 `node_down`. */
  private async needLive<T>(read: (live: Live) => Promise<T>): Promise<T> {
    try {
      return await this.tryLive(read);
    } catch {
      throw new ApiError(503, 'node_down');
    }
  }

  private tryLive<T>(read: (live: Live) => Promise<T>): Promise<T> {
    if (!this.live.connected()) return down();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NodeUnavailable('node timeout')), this.liveTimeoutMs);
    });
    const value = read(this.live);
    value.catch(() => undefined);
    return Promise.race([value, timeout]).finally(() => clearTimeout(timer));
  }

  /** A live read, or null; a failure other than the node being away (a decoding error) is logged. */
  private orNull<T>(read: (live: Live) => Promise<T>): Promise<T | null> {
    return this.tryLive(read).catch((e: unknown) => {
      this.noteLiveFailure(e);
      return null;
    });
  }

  /** Log a failed live read at most once a minute per message. */
  private noteLiveFailure(e: unknown): void {
    if (e instanceof NodeUnavailable || !this.live.connected()) return;
    const error = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    const last = this.warned.get(error);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    if (this.warned.size >= 100) this.warned.clear();
    this.warned.set(error, now);
    this.log('warn', 'live_read_failed', { error });
  }

  private times<T extends { block: number }>(items: T[]): Array<T & { timestamp: number | null }> {
    const times = this.store.blockTimes(items.map((i) => i.block));
    return items.map((i) => ({ ...i, timestamp: times.get(i.block) ?? null }));
  }

  private table(): Route[] {
    const s = this.store;
    return [
      [/^\/api\/status$/, () => this.status()],
      [/^\/api\/stats$/, async () => ({ ...s.counts(), authorities: (await this.orNull((l) => l.authorities()))?.length ?? null })],
      [/^\/api\/blocks$/, (_p, q) => this.blocks(blockCursor(q), limitOf(q))],
      [/^\/api\/block\/([^/]+)$/, ([id]) => this.block(id!), true],
      [/^\/api\/extrinsics$/, (_p, q) => this.page(s.extrinsics(cursorOf(q), limitOf(q), { signer: optAddress(q, 'signer'), pallet: optIdent(q, 'pallet'), signed: optFlag(q, 'signed') }), summarize)],
      [/^\/api\/extrinsic\/([^/]+)$/, ([id]) => this.extrinsic(id!), true],
      [/^\/api\/events$/, (_p, q) => this.page(s.events(cursorOf(q), limitOf(q), eventFilter(q)))],
      [/^\/api\/account\/([^/]+)$/, ([a]) => this.account(a!)],
      [/^\/api\/account\/([^/]+)\/history$/, ([a], q) => this.history(address(a!), q)],
      [/^\/api\/account\/([^/]+)\/transfers$/, ([a], q) => this.page(s.transfers(address(a!), cursorOf(q), limitOf(q)))],
      [/^\/api\/authorities$/, async () => ({ items: await this.needLive((l) => l.authorities()) })],
      [/^\/api\/authority\/([^/]+)$/, ([id], q) => this.authority(id!, q)],
      [/^\/api\/attestations$/, (_p, q) => this.page(s.attestations(cursorOf(q), limitOf(q), { authority: optNumber(q, 'authority') }))],
      [/^\/api\/migrations$/, (_p, q) => this.page(s.migrations(cursorOf(q), limitOf(q)))],
      [/^\/api\/usernames$/, (_p, q) => this.page(s.usernames(cursorOf(q), limitOf(q)))],
      [/^\/api\/runtime$/, () => this.runtime()],
      [/^\/api\/network$/, () => this.network()],
      [/^\/api\/search$/, (_p, q) => this.search(q.get('q') ?? '')],
    ];
  }

  private page<T extends { block: number }, U extends { block: number } = T>(p: { items: T[]; next: string | null }, map?: (t: T) => U): { items: Array<U & { timestamp: number | null }>; next: string | null } {
    const items = map === undefined ? (p.items as unknown as U[]) : p.items.map(map);
    return { items: this.times(items), next: p.next };
  }

  private status(): unknown {
    const node = this.live.connected();
    const runtimes = this.store.runtimes();
    return {
      ...this.headState(),
      node: node ? 'up' : 'down',
      specVersion: (node ? this.live.specVersion() : null) ?? runtimes.at(-1)?.specVersion ?? null,
      genesis: this.store.genesis(),
    };
  }

  /** The key is lowercase hex, as the indexer and the node give it. */
  private label(key: string | null): string | null {
    return key === null ? null : (this.labels.get(key) ?? null);
  }

  private named(keys: string[]): Array<{ key: string; label: string | null }> {
    return keys.map((key) => ({ key, label: this.label(key) }));
  }

  private blocks(cursor: number | null, limit: number): { items: Array<BlockRow & { authorLabel: string | null }>; next: number | null } {
    const p = this.store.blocks(cursor, limit);
    return { items: p.items.map((b) => ({ ...b, authorLabel: this.label(b.author) })), next: p.next };
  }

  /** The block with the labels of its keys, and what only the node can read at it (digest logs, GRANDPA members) or null. */
  private async block(id: string): Promise<unknown> {
    const key = blockId(id);
    const b = this.store.block(key);
    if (b === null) throw notFound();
    const [logs, members] = await Promise.all([this.orNull((l) => l.blockLogs(b.hash)), this.orNull((l) => l.grandpaAuthorities(b.hash))]);
    const out = {
      ...b,
      authorLabel: this.label(b.author),
      signers: b.justificationSigners === null ? null : this.named(b.justificationSigners),
      authoritySet: { id: b.authoritySetId, members: members === null ? null : this.named(members) },
      logs,
      extrinsics: this.store.extrinsicsOfBlock(b.number).map((x) => ({ ...summarize(x), timestamp: b.timestamp })),
      events: this.store.eventsOfBlock(b.number).map((e) => ({ ...e, timestamp: b.timestamp })),
    };
    // a finalized block never changes, but an answer missing its live parts must not be cached as if it were whole
    return logs === null || members === null ? new Uncached(out) : out;
  }

  private extrinsic(id: string): unknown {
    const lower = id.toLowerCase();
    if (HASH.test(lower)) {
      const found = this.store.extrinsicByHash(lower);
      if (found.length === 0) throw notFound();
      if (found.length > 1) return { matches: this.times(found.map(summarize)) };
      return this.full(found[0]!);
    }
    if (!POSITION.test(id)) throw new ApiError(400, 'bad_id');
    const x = this.store.extrinsic(id);
    if (x === null) throw notFound();
    return this.full(x);
  }

  private full(x: ExtrinsicRow): unknown {
    const [withTime] = this.times([x]);
    const events: EventRow[] = this.store.eventsOfBlock(x.block).filter((e) => e.extrinsicIndex === x.index);
    return { ...withTime, events: events.map((e) => ({ ...e, timestamp: withTime!.timestamp })) };
  }

  private async account(input: string): Promise<unknown> {
    const addr = address(input);
    const [balance, identity, roles] = await Promise.all([
      this.orNull((l) => l.account(addr)),
      this.orNull((l) => l.identitySummary(addr)),
      this.orNull((l) => l.roles(addr)),
    ]);
    return {
      address: addr,
      publicKey: u8aToHex(decodeAddress(addr)),
      balance: balance === null ? null : { free: balance.free, reserved: balance.reserved, frozen: balance.frozen },
      nonce: balance?.nonce ?? null,
      identity,
      roles,
      profileUrl: profileUrl(identity?.username ?? null, addr),
      node: this.live.connected() ? 'up' : 'down',
    };
  }

  private history(addr: string, q: URLSearchParams): unknown {
    const p = this.store.accountHistory(addr, cursorOf(q), limitOf(q));
    const items = p.items.map((h: HistoryItem) => (h.kind === 'extrinsic' ? { kind: h.kind, block: h.block, item: summarize(h.item) } : h));
    return { items: this.times(items), next: p.next };
  }

  private async authority(id: string, q: URLSearchParams): Promise<unknown> {
    if (!/^\d{1,9}$/.test(id)) throw new ApiError(400, 'bad_id');
    const n = Number(id);
    const found = (await this.needLive((l) => l.authorities())).find((a) => a.id === n);
    if (found === undefined) throw notFound();
    return { ...found, attestations: this.page(this.store.attestations(cursorOf(q), limitOf(q), { authority: n })) };
  }

  private runtime(): unknown {
    let info: RuntimeInfo | null = null;
    try {
      info = this.live.runtime();
    } catch {
      info = null;
    }
    return {
      current: info === null ? null : { specName: info.specName, specVersion: info.specVersion },
      versions: this.store.runtimes(),
      pallets: info?.pallets ?? [],
    };
  }

  private async network(): Promise<unknown> {
    const [validators, health] = await this.needLive((l) => Promise.all([l.validators(), l.health()]));
    return { validators, health, blockTime: { target: BLOCK_TIME_MS, recent: this.recentBlockTime() }, grandpaSetId: validators.setId };
  }

  /** The mean time between the last 100 indexed blocks, in ms; null without two timestamps. */
  private recentBlockTime(): number | null {
    const stamped = this.store.blocks(null, 101).items.filter((b) => b.timestamp !== null);
    if (stamped.length < 2) return null;
    const first = stamped[0]!;
    const last = stamped[stamped.length - 1]!;
    return Math.round((first.timestamp! - last.timestamp!) / (first.number - last.number));
  }

  private async search(raw: string): Promise<unknown> {
    const q = raw.trim();
    if (q === '' || q.length > MAX_QUERY) throw new ApiError(400, 'bad_query');
    const none = { kind: 'none', target: '', alternatives: [] };
    const username = async (term: string): Promise<{ kind: 'username'; target: string; name: string } | null> => {
      const name = term.replace(/^@/, '').toLowerCase();
      if (!NAME.test(name)) return null;
      const owner = await this.orNull((l) => l.nameOwner(name));
      return owner === null ? null : { kind: 'username', target: owner, name };
    };

    if (/^\d+$/.test(q)) {
      const n = Number(q);
      const block = Number.isSafeInteger(n) ? this.store.block(n) : null;
      const name = await username(q);
      if (block !== null) return { kind: 'block', target: String(block.number), alternatives: name === null ? [] : [name] };
      return name === null ? none : { ...name, alternatives: [] };
    }
    const lower = q.toLowerCase();
    if (HASH.test(lower)) {
      const block = this.store.block(lower);
      if (block !== null) return { kind: 'block', target: String(block.number), alternatives: [] };
      const xts = this.store.extrinsicByHash(lower);
      if (xts.length > 0) return { kind: 'extrinsic', target: xts.length === 1 ? xts[0]!.id : lower, alternatives: [] };
    }
    if (POSITION.test(q) && this.store.extrinsic(q) !== null) return { kind: 'extrinsic', target: q, alternatives: [] };
    const addr = normalizeAddress(q);
    if (addr !== null) return { kind: 'account', target: addr, alternatives: [] };
    const name = await username(q);
    return name === null ? none : { ...name, alternatives: [] };
  }
}

// --- Query parsing -------------------------------------------------------------------------------

function limitOf(q: URLSearchParams): number {
  const text = q.get('limit');
  if (text === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) throw new ApiError(400, 'bad_limit');
  // a number too long for a double reads as Infinity, which the cap turns into "as many as allowed"
  return Math.min(Number(text), MAX_LIMIT);
}

function cursorOf(q: URLSearchParams): string | null {
  const c = q.get('cursor');
  if (c === null || c === '') return null;
  if (c.length > 64) throw new BadCursorError(c);
  return c;
}

function blockCursor(q: URLSearchParams): number | null {
  const c = cursorOf(q);
  if (c === null) return null;
  if (!/^\d{1,15}$/.test(c)) throw new BadCursorError(c);
  return Number(c);
}

function blockId(id: string): number | string {
  if (/^\d{1,15}$/.test(id)) return Number(id);
  const lower = id.toLowerCase();
  if (HASH.test(lower)) return lower;
  throw new ApiError(400, 'bad_id');
}

function address(input: string): string {
  const addr = normalizeAddress(input);
  if (addr === null) throw new ApiError(400, 'bad_address');
  return addr;
}

function optAddress(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key);
  return v === null || v === '' ? undefined : address(v);
}

/** `key=1` is on; absent, empty or `0` is off; anything else is a 400 `bad_<key>`. */
function optFlag(q: URLSearchParams, key: string): boolean {
  const v = q.get(key);
  if (v === null || v === '' || v === '0') return false;
  if (v === '1') return true;
  throw new ApiError(400, `bad_${key}`);
}

function optIdent(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key);
  if (v === null || v === '') return undefined;
  if (!IDENT.test(v)) throw new ApiError(400, `bad_${key}`);
  return v;
}

/** A method alone would walk every event: it is only an index range under its pallet. */
function eventFilter(q: URLSearchParams): { pallet?: string; method?: string } {
  const pallet = optIdent(q, 'pallet');
  const method = optIdent(q, 'method');
  if (method !== undefined && pallet === undefined) throw new ApiError(400, 'method_needs_pallet');
  return { pallet, method };
}

function optNumber(q: URLSearchParams, key: string): number | undefined {
  const v = q.get(key);
  if (v === null || v === '') return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new ApiError(400, `bad_${key}`);
  return Number(v);
}
