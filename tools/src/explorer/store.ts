// The explorer's index: finalized blocks and what was decoded from them (extrinsics, events, an
// address-to-item index, runtime versions, transfers and the identitee feeds), in one SQLite file
// (`node:sqlite`). Derived data: losing the file means a re-index. The indexer is the only writer,
// one transaction per block; the API reads. Lists are newest first and paginate with a cursor that
// means "strictly older than" the last item of the previous page.

import { existsSync, renameSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// --- Rows ----------------------------------------------------------------------------------------

export interface BlockRow {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  /** Milliseconds since the epoch, from the timestamp inherent. */
  timestamp: number | null;
  specVersion: number;
  author: string | null;
  authoritySetId: number;
  justificationSigners: string[] | null;
  extrinsicCount: number;
  eventCount: number;
}

export interface ExtrinsicRow {
  /** `<block>-<index>` */
  id: string;
  block: number;
  index: number;
  hash: string;
  pallet: string;
  method: string;
  args: unknown;
  signer: string | null;
  nonce: number | null;
  /** Planck, as a decimal string. */
  tip: string | null;
  fee: string | null;
  success: boolean;
  error: { pallet: string; name: string; docs: string } | null;
}

export interface EventRow {
  /** `<block>-<index>` */
  id: string;
  block: number;
  index: number;
  /** The extrinsic that emitted it, null for the events of the block itself. */
  extrinsicIndex: number | null;
  pallet: string;
  method: string;
  data: unknown;
  sentence: string | null;
}

/** An address that appears in an extrinsic or an event, so that the address page can list it. */
export interface AccountLink {
  address: string;
  itemKind: 'extrinsic' | 'event';
  /** `<block>-<index>` of the extrinsic or event. */
  itemId: string;
  block: number;
}

// The feeds are fed from events, one row per event at most. `eventId` is `<block>-<index>`;
// `extrinsicId` likewise.
export interface TransferRow {
  from: string;
  to: string;
  /** Planck, as a decimal string (a u128 does not fit a JS number). */
  amount: string;
  block: number;
  extrinsicId: string | null;
  eventId: string;
}

export type AttestationKind = 'requested' | 'attested' | 'revoked' | 'rejected' | 'cancelled';
export interface AttestationRow {
  who: string;
  authorityId: number;
  kind: AttestationKind;
  /** The field key, fact kind or request target the event is about. */
  target: unknown;
  /** The rest of the event (verdict, reason, note, agent), null if there is nothing more. */
  data: unknown | null;
  block: number;
  eventId: string;
}

export type MigrationKind = 'requested' | 'cancelled' | 'fulfilled' | 'rejected';
export interface MigrationRow {
  who: string;
  kind: MigrationKind;
  /** Source chain, source block and hash, agent, reason: whatever the event carries. */
  data: unknown;
  block: number;
  eventId: string;
}

export type UsernameKind = 'claimed' | 'released' | 'reserved' | 'unreserved' | 'assigned' | 'revoked';
export interface UsernameRow {
  name: string;
  /** Null for a reservation, which has no owner. */
  who: string | null;
  kind: UsernameKind;
  block: number;
  eventId: string;
}

export interface Extras {
  transfers: TransferRow[];
  attestations: AttestationRow[];
  migrations: MigrationRow[];
  usernames: UsernameRow[];
}

/** A feed row as read: the row plus the sentence of the event it came from. */
export type Listed<T> = T & { sentence: string | null };

export interface RuntimeRow {
  specVersion: number;
  fromBlock: number;
  specName: string;
}

export type HistoryItem =
  | { kind: 'extrinsic'; block: number; item: ExtrinsicRow }
  | { kind: 'event'; block: number; item: EventRow };

export interface Counts {
  blocks: number;
  extrinsics: number;
  events: number;
  accounts: number;
  transfers: number;
  attestations: number;
  migrations: number;
  usernames: number;
}

/** `next` is the cursor of the following page, null on the last one. */
export interface Page<T, C = string> {
  items: T[];
  next: C | null;
}

/** A cursor that this store never handed out. */
export class BadCursorError extends Error {
  constructor(cursor: unknown) {
    super(`bad cursor: ${typeof cursor === 'string' ? JSON.stringify(cursor.slice(0, 40)) : String(cursor)}`);
    this.name = 'BadCursorError';
  }
}

// --- Schema --------------------------------------------------------------------------------------

// Each step takes the database from version i to i + 1 (`PRAGMA user_version`). Never edit a step
// that shipped: add one.
const STEPS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  -- running totals, so that the front page never counts millions of rows
  CREATE TABLE totals (name TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
  INSERT INTO totals (name, n) VALUES ('blocks', 0), ('extrinsics', 0), ('events', 0), ('accounts', 0),
    ('transfers', 0), ('attestations', 0), ('migrations', 0), ('usernames', 0);

  CREATE TABLE blocks (
    number INTEGER PRIMARY KEY,
    hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    state_root TEXT NOT NULL,
    extrinsics_root TEXT NOT NULL,
    timestamp INTEGER,
    spec_version INTEGER NOT NULL,
    author TEXT,
    authority_set_id INTEGER NOT NULL,
    justification_signers TEXT,
    extrinsic_count INTEGER NOT NULL,
    event_count INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX blocks_by_hash ON blocks (hash);

  CREATE TABLE extrinsics (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    hash TEXT NOT NULL,
    pallet TEXT NOT NULL,
    method TEXT NOT NULL,
    args TEXT NOT NULL,
    signer TEXT,
    nonce INTEGER,
    tip TEXT,
    fee TEXT,
    success INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;
  CREATE INDEX extrinsics_by_hash ON extrinsics (hash);
  CREATE INDEX extrinsics_by_signer ON extrinsics (signer, block, idx);
  CREATE INDEX extrinsics_by_pallet ON extrinsics (pallet, block, idx);

  CREATE TABLE events (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    extrinsic_index INTEGER,
    pallet TEXT NOT NULL,
    method TEXT NOT NULL,
    data TEXT NOT NULL,
    sentence TEXT,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;
  CREATE INDEX events_by_pallet ON events (pallet, block, idx);
  CREATE INDEX events_by_name ON events (pallet, method, block, idx);

  CREATE TABLE accounts (address TEXT PRIMARY KEY, first_block INTEGER NOT NULL) WITHOUT ROWID;
  -- kind: 0 extrinsic, 1 event; item_index: the extrinsic or event index within the block
  CREATE TABLE account_links (
    address TEXT NOT NULL,
    block INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    item_index INTEGER NOT NULL,
    PRIMARY KEY (address, block, kind, item_index)
  ) WITHOUT ROWID;

  CREATE TABLE runtime_versions (
    from_block INTEGER PRIMARY KEY,
    spec_version INTEGER NOT NULL,
    spec_name TEXT NOT NULL
  );

  -- the feeds: idx is the index of the event the row comes from
  CREATE TABLE transfers (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    amount TEXT NOT NULL,
    extrinsic_id TEXT,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;
  CREATE INDEX transfers_by_from ON transfers (from_addr, block, idx);
  CREATE INDEX transfers_by_to ON transfers (to_addr, block, idx);

  CREATE TABLE attestations (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    who TEXT NOT NULL,
    authority_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    data TEXT,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;
  CREATE INDEX attestations_by_authority ON attestations (authority_id, block, idx);

  CREATE TABLE migrations (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    who TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;

  CREATE TABLE usernames (
    block INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    who TEXT,
    kind TEXT NOT NULL,
    PRIMARY KEY (block, idx)
  ) WITHOUT ROWID;
  `,
];

/** Bring `db` to the last of `steps`, each step in its own transaction; refuse a newer database. */
export function migrate(db: DatabaseSync, steps: string[] = STEPS): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version > steps.length) {
    throw new Error(`the explorer database is at schema version ${version}, this code only knows ${steps.length}`);
  }
  for (let i = version; i < steps.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(steps[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// --- Helpers -------------------------------------------------------------------------------------

const MEMORY = ':memory:';
const GENESIS_RE = /^0x[0-9a-f]{64}$/;
const POSITION_RE = /^(\d{1,15})-(\d{1,9})$/;
const HISTORY_RE = /^(\d{1,15})-([xe])-(\d{1,9})$/;
const KIND_RANK = { extrinsic: 0, event: 1 } as const;

const json = (value: unknown): string => JSON.stringify(value === undefined ? null : value);

/** `<block>-<index>` as a pair, or null if `id` is not one. */
function position(id: string): { block: number; index: number } | null {
  const m = POSITION_RE.exec(id);
  return m === null ? null : { block: Number(m[1]), index: Number(m[2]) };
}

function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  return limit;
}

/** `rows` were read with `limit + 1`: cut the extra one and name the cursor of the next page. */
function paginate<T, C>(rows: T[], limit: number, cursorOf: (last: T) => C): Page<T, C> {
  if (rows.length <= limit) return { items: rows, next: null };
  const items = rows.slice(0, limit);
  return { items, next: cursorOf(items[limit - 1]!) };
}

/** SQL for "older than the cursor" over `(block, idx)`, with its parameters. */
function olderThan(cursor: string | null, alias: string): { sql: string; params: number[] } {
  if (cursor === null) return { sql: '1', params: [] };
  const at = position(cursor);
  if (at === null) throw new BadCursorError(cursor);
  return { sql: `(${alias}block, ${alias}idx) < (?, ?)`, params: [at.block, at.index] };
}

interface RawBlock {
  number: number;
  hash: string;
  parent_hash: string;
  state_root: string;
  extrinsics_root: string;
  timestamp: number | null;
  spec_version: number;
  author: string | null;
  authority_set_id: number;
  justification_signers: string | null;
  extrinsic_count: number;
  event_count: number;
}

interface RawExtrinsic {
  block: number;
  idx: number;
  hash: string;
  pallet: string;
  method: string;
  args: string;
  signer: string | null;
  nonce: number | null;
  tip: string | null;
  fee: string | null;
  success: number;
  error: string | null;
}

interface RawEvent {
  block: number;
  idx: number;
  extrinsic_index: number | null;
  pallet: string;
  method: string;
  data: string;
  sentence: string | null;
}

const toBlock = (r: RawBlock): BlockRow => ({
  number: r.number,
  hash: r.hash,
  parentHash: r.parent_hash,
  stateRoot: r.state_root,
  extrinsicsRoot: r.extrinsics_root,
  timestamp: r.timestamp,
  specVersion: r.spec_version,
  author: r.author,
  authoritySetId: r.authority_set_id,
  justificationSigners: r.justification_signers === null ? null : (JSON.parse(r.justification_signers) as string[]),
  extrinsicCount: r.extrinsic_count,
  eventCount: r.event_count,
});

const toExtrinsic = (r: RawExtrinsic): ExtrinsicRow => ({
  id: `${r.block}-${r.idx}`,
  block: r.block,
  index: r.idx,
  hash: r.hash,
  pallet: r.pallet,
  method: r.method,
  args: JSON.parse(r.args) as unknown,
  signer: r.signer,
  nonce: r.nonce,
  tip: r.tip,
  fee: r.fee,
  success: r.success === 1,
  error: r.error === null ? null : (JSON.parse(r.error) as ExtrinsicRow['error']),
});

const toEvent = (r: RawEvent): EventRow => ({
  id: `${r.block}-${r.idx}`,
  block: r.block,
  index: r.idx,
  extrinsicIndex: r.extrinsic_index,
  pallet: r.pallet,
  method: r.method,
  data: JSON.parse(r.data) as unknown,
  sentence: r.sentence,
});

// --- Store ---------------------------------------------------------------------------------------

export class ExplorerStore {
  private db!: DatabaseSync;

  /** `path` is a file, or `:memory:` in the tests. */
  constructor(private readonly path: string) {
    this.open();
  }

  private open(): void {
    this.db = new DatabaseSync(this.path);
    // NORMAL is enough in WAL mode: a power cut can lose the last blocks, never corrupt the file,
    // and the indexer resumes after the last block that is there.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // --- Genesis -----------------------------------------------------------------------------------

  /**
   * Tie the store to a chain. The first call records the genesis hash. If the store holds another
   * chain (a testnet reset) the file is moved to `<path>.<first 8 hex of the old genesis>.bak`
   * (a number is added if that name is taken), and the store starts empty; an in-memory store is
   * just cleared.
   */
  openForGenesis(genesisHash: string): { reset: boolean } {
    const genesis = genesisHash.toLowerCase();
    if (!GENESIS_RE.test(genesis)) throw new Error(`the genesis hash must be 0x and 64 hex digits, got ${JSON.stringify(genesisHash.slice(0, 80))}`);
    const stored = this.getMeta('genesis');
    if (stored === genesis) return { reset: false };
    if (stored === null) {
      this.setMeta('genesis', genesis);
      return { reset: false };
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
    if (this.path !== MEMORY) this.moveAside(stored);
    this.open();
    this.setMeta('genesis', genesis);
    return { reset: true };
  }

  private moveAside(oldGenesis: string): void {
    const base = `${this.path}.${oldGenesis.slice(2, 10)}.bak`;
    let bak = base;
    for (let n = 2; existsSync(bak); n++) bak = `${base}.${n}`;
    renameSync(this.path, bak);
    // a closed database leaves no side files; if a crash left some, they belong with the old file
    for (const side of ['-wal', '-shm']) {
      if (existsSync(this.path + side)) renameSync(this.path + side, bak + side);
    }
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // --- Writing -----------------------------------------------------------------------------------

  /** The highest block in the store, null if it is empty. */
  lastIndexed(): number | null {
    const row = this.db.prepare('SELECT max(number) AS n FROM blocks').get() as { n: number | null };
    return row.n;
  }

  /**
   * One block with everything decoded from it, in one transaction: either all of it is stored or
   * none. The rows must belong together (same block, ids matching their position, links and
   * feed rows pointing at rows of this block, counts matching), and the block must not be there yet;
   * anything else throws before the first byte is written, or rolls back.
   */
  writeBlock(b: BlockRow, xts: ExtrinsicRow[], evs: EventRow[], links: AccountLink[], extras: Extras): void {
    const db = this.db;
    const xtIds = new Set(xts.map((x) => x.id));
    const evIds = new Set(evs.map((e) => e.id));
    this.checkRows(b, xts, evs, links, extras, xtIds, evIds);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO blocks (number, hash, parent_hash, state_root, extrinsics_root, timestamp, spec_version, author,
           authority_set_id, justification_signers, extrinsic_count, event_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        b.number, b.hash, b.parentHash, b.stateRoot, b.extrinsicsRoot, b.timestamp, b.specVersion, b.author, b.authoritySetId,
        b.justificationSigners === null ? null : json(b.justificationSigners), b.extrinsicCount, b.eventCount,
      );

      const insertXt = db.prepare('INSERT INTO extrinsics (block, idx, hash, pallet, method, args, signer, nonce, tip, fee, success, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of xts) {
        insertXt.run(x.block, x.index, x.hash, x.pallet, x.method, json(x.args), x.signer, x.nonce, x.tip, x.fee, x.success ? 1 : 0, x.error === null ? null : json(x.error));
      }
      const insertEv = db.prepare('INSERT INTO events (block, idx, extrinsic_index, pallet, method, data, sentence) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of evs) insertEv.run(e.block, e.index, e.extrinsicIndex, e.pallet, e.method, json(e.data), e.sentence);

      const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (address, first_block) VALUES (?, ?)');
      const insertLink = db.prepare('INSERT OR IGNORE INTO account_links (address, block, kind, item_index) VALUES (?, ?, ?, ?)');
      let newAccounts = 0;
      for (const l of links) {
        newAccounts += Number(insertAccount.run(l.address, l.block).changes);
        insertLink.run(l.address, l.block, KIND_RANK[l.itemKind], position(l.itemId)!.index);
      }

      const insertTransfer = db.prepare('INSERT INTO transfers (block, idx, from_addr, to_addr, amount, extrinsic_id) VALUES (?, ?, ?, ?, ?, ?)');
      for (const t of extras.transfers) insertTransfer.run(t.block, position(t.eventId)!.index, t.from, t.to, t.amount, t.extrinsicId);
      const insertAttestation = db.prepare('INSERT INTO attestations (block, idx, who, authority_id, kind, target, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const a of extras.attestations) {
        insertAttestation.run(a.block, position(a.eventId)!.index, a.who, a.authorityId, a.kind, json(a.target), a.data === null || a.data === undefined ? null : json(a.data));
      }
      const insertMigration = db.prepare('INSERT INTO migrations (block, idx, who, kind, data) VALUES (?, ?, ?, ?, ?)');
      for (const m of extras.migrations) insertMigration.run(m.block, position(m.eventId)!.index, m.who, m.kind, json(m.data));
      const insertUsername = db.prepare('INSERT INTO usernames (block, idx, name, who, kind) VALUES (?, ?, ?, ?, ?)');
      for (const u of extras.usernames) insertUsername.run(u.block, position(u.eventId)!.index, u.name, u.who, u.kind);

      const bump = db.prepare('UPDATE totals SET n = n + ? WHERE name = ?');
      bump.run(1, 'blocks');
      bump.run(xts.length, 'extrinsics');
      bump.run(evs.length, 'events');
      bump.run(newAccounts, 'accounts');
      bump.run(extras.transfers.length, 'transfers');
      bump.run(extras.attestations.length, 'attestations');
      bump.run(extras.migrations.length, 'migrations');
      bump.run(extras.usernames.length, 'usernames');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  private checkRows(b: BlockRow, xts: ExtrinsicRow[], evs: EventRow[], links: AccountLink[], extras: Extras, xtIds: Set<string>, evIds: Set<string>): void {
    const fail = (what: string): never => {
      throw new Error(`block ${b.number}: ${what}`);
    };
    if (b.extrinsicCount !== xts.length) fail(`extrinsicCount is ${b.extrinsicCount} for ${xts.length} extrinsics`);
    if (b.eventCount !== evs.length) fail(`eventCount is ${b.eventCount} for ${evs.length} events`);
    for (const x of xts) {
      if (x.block !== b.number) fail(`extrinsic ${x.id} is in block ${x.block}, not ${b.number}`);
      if (x.id !== `${x.block}-${x.index}`) fail(`extrinsic id ${x.id} does not match its index ${x.index}`);
    }
    for (const e of evs) {
      if (e.block !== b.number) fail(`event ${e.id} is in block ${e.block}, not ${b.number}`);
      if (e.id !== `${e.block}-${e.index}`) fail(`event id ${e.id} does not match its index ${e.index}`);
      if (e.extrinsicIndex !== null && !xtIds.has(`${b.number}-${e.extrinsicIndex}`)) fail(`event ${e.id} comes from extrinsic ${e.extrinsicIndex}, which is not in the block`);
    }
    for (const l of links) {
      if (l.block !== b.number) fail(`link of ${l.address} is in block ${l.block}, not ${b.number}`);
      if (!(l.itemKind === 'extrinsic' ? xtIds : evIds).has(l.itemId)) fail(`link of ${l.address} points at ${l.itemKind} ${l.itemId}, which is not in the block`);
    }
    const feeds: Array<[string, Array<{ block: number; eventId: string }>]> = [
      ['transfer', extras.transfers], ['attestation', extras.attestations], ['migration', extras.migrations], ['username', extras.usernames],
    ];
    for (const [name, rows] of feeds) {
      for (const r of rows) {
        if (r.block !== b.number) fail(`${name} of event ${r.eventId} is in block ${r.block}, not ${b.number}`);
        if (!evIds.has(r.eventId)) fail(`${name} points at event ${r.eventId}, which is not in the block`);
      }
    }
    for (const t of extras.transfers) {
      if (t.extrinsicId !== null && !xtIds.has(t.extrinsicId)) fail(`transfer of event ${t.eventId} points at extrinsic ${t.extrinsicId}, which is not in the block`);
    }
  }

  /** Record a runtime version seen from `fromBlock`; nothing if it is the one already in force there. */
  recordRuntime(specVersion: number, fromBlock: number, specName: string): void {
    const inForce = this.db.prepare('SELECT spec_version AS v FROM runtime_versions WHERE from_block <= ? ORDER BY from_block DESC LIMIT 1').get(fromBlock) as { v: number } | undefined;
    if (inForce !== undefined && inForce.v === specVersion) return;
    this.db.prepare('INSERT OR IGNORE INTO runtime_versions (from_block, spec_version, spec_name) VALUES (?, ?, ?)').run(fromBlock, specVersion, specName);
  }

  // --- Reading -----------------------------------------------------------------------------------

  /** A block by number, or by hash (0x, any case); null if it is not indexed. */
  block(numberOrHash: number | string): BlockRow | null {
    const row = (
      typeof numberOrHash === 'number'
        ? this.db.prepare('SELECT * FROM blocks WHERE number = ?').get(numberOrHash)
        : this.db.prepare('SELECT * FROM blocks WHERE hash = ?').get(numberOrHash.toLowerCase())
    ) as RawBlock | undefined;
    return row === undefined ? null : toBlock(row);
  }

  /** Blocks newest first. `cursor` is a block number: the page starts below it. */
  blocks(cursor: number | null, limit: number): Page<BlockRow, number> {
    checkLimit(limit);
    if (cursor !== null && !(Number.isSafeInteger(cursor) && cursor >= 0)) throw new BadCursorError(cursor);
    const rows = (cursor === null
      ? this.db.prepare('SELECT * FROM blocks ORDER BY number DESC LIMIT ?').all(limit + 1)
      : this.db.prepare('SELECT * FROM blocks WHERE number < ? ORDER BY number DESC LIMIT ?').all(cursor, limit + 1)) as unknown as RawBlock[];
    return paginate(rows.map(toBlock), limit, (b) => b.number);
  }

  /** An extrinsic by id (`<block>-<index>`); null for an unknown or malformed id. */
  extrinsic(id: string): ExtrinsicRow | null {
    const at = position(id);
    if (at === null) return null;
    const row = this.db.prepare('SELECT * FROM extrinsics WHERE block = ? AND idx = ?').get(at.block, at.index) as RawExtrinsic | undefined;
    return row === undefined ? null : toExtrinsic(row);
  }

  /** Every extrinsic with this hash, newest first (a hash can be included more than once). */
  extrinsicByHash(hash: string): ExtrinsicRow[] {
    const rows = this.db.prepare('SELECT * FROM extrinsics WHERE hash = ? ORDER BY block DESC, idx DESC').all(hash.toLowerCase()) as unknown as RawExtrinsic[];
    return rows.map(toExtrinsic);
  }

  extrinsicsOfBlock(n: number): ExtrinsicRow[] {
    const rows = this.db.prepare('SELECT * FROM extrinsics WHERE block = ? ORDER BY idx').all(n) as unknown as RawExtrinsic[];
    return rows.map(toExtrinsic);
  }

  /** Extrinsics newest first. `cursor` is the id of the last extrinsic of the previous page. */
  extrinsics(cursor: string | null, limit: number, filter: { signer?: string; pallet?: string } = {}): Page<ExtrinsicRow> {
    checkLimit(limit);
    const older = olderThan(cursor, '');
    const where = [older.sql];
    const params: SQLInputValue[] = [...older.params];
    if (filter.signer !== undefined) {
      where.push('signer = ?');
      params.push(filter.signer);
    }
    if (filter.pallet !== undefined) {
      where.push('pallet = ?');
      params.push(filter.pallet);
    }
    const rows = this.db.prepare(`SELECT * FROM extrinsics WHERE ${where.join(' AND ')} ORDER BY block DESC, idx DESC LIMIT ?`).all(...params, limit + 1) as unknown as RawExtrinsic[];
    return paginate(rows.map(toExtrinsic), limit, (x) => x.id);
  }

  /** Events newest first. `cursor` is the id of the last event of the previous page. */
  events(cursor: string | null, limit: number, filter: { pallet?: string; method?: string } = {}): Page<EventRow> {
    checkLimit(limit);
    const older = olderThan(cursor, '');
    const where = [older.sql];
    const params: SQLInputValue[] = [...older.params];
    if (filter.pallet !== undefined) {
      where.push('pallet = ?');
      params.push(filter.pallet);
    }
    if (filter.method !== undefined) {
      where.push('method = ?');
      params.push(filter.method);
    }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY block DESC, idx DESC LIMIT ?`).all(...params, limit + 1) as unknown as RawEvent[];
    return paginate(rows.map(toEvent), limit, (e) => e.id);
  }

  /** The events of a block in the order they were emitted. */
  eventsOfBlock(n: number): EventRow[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE block = ? ORDER BY idx').all(n) as unknown as RawEvent[];
    return rows.map(toEvent);
  }

  /**
   * The extrinsics and events that mention `address`, newest first; within a block the events
   * come before the extrinsics. `cursor` is the `next` of the previous page (`<block>-x|e-<index>`).
   */
  accountHistory(address: string, cursor: string | null, limit: number): Page<HistoryItem> {
    checkLimit(limit);
    let older = '1';
    const params: SQLInputValue[] = [address];
    if (cursor !== null) {
      const m = HISTORY_RE.exec(cursor);
      if (m === null) throw new BadCursorError(cursor);
      older = '(block, kind, item_index) < (?, ?, ?)';
      params.push(Number(m[1]), m[2] === 'x' ? KIND_RANK.extrinsic : KIND_RANK.event, Number(m[3]));
    }
    const links = this.db
      .prepare(`SELECT block, kind, item_index FROM account_links WHERE address = ? AND ${older} ORDER BY block DESC, kind DESC, item_index DESC LIMIT ?`)
      .all(...params, limit + 1) as unknown as Array<{ block: number; kind: number; item_index: number }>;
    const getXt = this.db.prepare('SELECT * FROM extrinsics WHERE block = ? AND idx = ?');
    const getEv = this.db.prepare('SELECT * FROM events WHERE block = ? AND idx = ?');
    const items: Array<HistoryItem & { cursor: string }> = [];
    for (const l of links) {
      if (l.kind === KIND_RANK.extrinsic) {
        const row = getXt.get(l.block, l.item_index) as RawExtrinsic | undefined;
        if (row !== undefined) items.push({ kind: 'extrinsic', block: l.block, item: toExtrinsic(row), cursor: `${l.block}-x-${l.item_index}` });
      } else {
        const row = getEv.get(l.block, l.item_index) as RawEvent | undefined;
        if (row !== undefined) items.push({ kind: 'event', block: l.block, item: toEvent(row), cursor: `${l.block}-e-${l.item_index}` });
      }
    }
    const page = paginate(items, limit, (last) => last.cursor);
    return { items: page.items.map(({ cursor: _cursor, ...item }) => item as HistoryItem), next: page.next };
  }

  /** Transfers newest first, those of `address` (sent or received) or all of them if null. */
  transfers(address: string | null, cursor: string | null, limit: number): Page<Listed<TransferRow>> {
    checkLimit(limit);
    const older = olderThan(cursor, '');
    const rawSelect = (side: 'from_addr' | 'to_addr'): string =>
      `SELECT * FROM (SELECT * FROM transfers WHERE ${side} = ? AND ${older.sql} ORDER BY block DESC, idx DESC LIMIT ?)`;
    // each side reads at most a page from its index; UNION also folds a transfer to oneself into one row
    const [source, params] =
      address === null
        ? ['transfers', older.params]
        : [`(${rawSelect('from_addr')} UNION ${rawSelect('to_addr')})`, [address, ...older.params, limit + 1, address, ...older.params, limit + 1]];
    const where = address === null ? `WHERE ${olderThan(cursor, 't.').sql}` : '';
    const rows = this.db
      .prepare(
        `SELECT t.*, e.sentence FROM ${source} t LEFT JOIN events e ON e.block = t.block AND e.idx = t.idx
         ${where} ORDER BY t.block DESC, t.idx DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as unknown as Array<{ block: number; idx: number; from_addr: string; to_addr: string; amount: string; extrinsic_id: string | null; sentence: string | null }>;
    return paginate(
      rows.map((r) => ({ from: r.from_addr, to: r.to_addr, amount: r.amount, block: r.block, extrinsicId: r.extrinsic_id, eventId: `${r.block}-${r.idx}`, sentence: r.sentence })),
      limit,
      (t) => t.eventId,
    );
  }

  /** Attestation events newest first; `filter.authority` keeps one authority's. */
  attestations(cursor: string | null, limit: number, filter: { authority?: number } = {}): Page<Listed<AttestationRow>> {
    const rows = this.feed('attestations', cursor, limit, filter.authority === undefined ? undefined : ['t.authority_id = ?', filter.authority]) as Array<{
      block: number; idx: number; who: string; authority_id: number; kind: AttestationKind; target: string; data: string | null; sentence: string | null;
    }>;
    return paginate(
      rows.map((r) => ({
        who: r.who,
        authorityId: r.authority_id,
        kind: r.kind,
        target: JSON.parse(r.target) as unknown,
        data: r.data === null ? null : (JSON.parse(r.data) as unknown),
        block: r.block,
        eventId: `${r.block}-${r.idx}`,
        sentence: r.sentence,
      })),
      limit,
      (a) => a.eventId,
    );
  }

  /** Migration events newest first. */
  migrations(cursor: string | null, limit: number): Page<Listed<MigrationRow>> {
    const rows = this.feed('migrations', cursor, limit) as Array<{ block: number; idx: number; who: string; kind: MigrationKind; data: string; sentence: string | null }>;
    return paginate(
      rows.map((r) => ({ who: r.who, kind: r.kind, data: JSON.parse(r.data) as unknown, block: r.block, eventId: `${r.block}-${r.idx}`, sentence: r.sentence })),
      limit,
      (m) => m.eventId,
    );
  }

  /** Name events newest first. */
  usernames(cursor: string | null, limit: number): Page<Listed<UsernameRow>> {
    const rows = this.feed('usernames', cursor, limit) as Array<{ block: number; idx: number; name: string; who: string | null; kind: UsernameKind; sentence: string | null }>;
    return paginate(
      rows.map((r) => ({ name: r.name, who: r.who, kind: r.kind, block: r.block, eventId: `${r.block}-${r.idx}`, sentence: r.sentence })),
      limit,
      (u) => u.eventId,
    );
  }

  /** `limit + 1` rows of a feed table, newest first, each with the sentence of its event. */
  private feed(table: 'attestations' | 'migrations' | 'usernames', cursor: string | null, limit: number, extra?: [string, SQLInputValue]): unknown[] {
    checkLimit(limit);
    const older = olderThan(cursor, 't.');
    const where = [older.sql];
    const params: SQLInputValue[] = [...older.params];
    if (extra !== undefined) {
      where.push(extra[0]);
      params.push(extra[1]);
    }
    return this.db
      .prepare(
        `SELECT t.*, e.sentence FROM ${table} t LEFT JOIN events e ON e.block = t.block AND e.idx = t.idx
         WHERE ${where.join(' AND ')} ORDER BY t.block DESC, t.idx DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
  }

  /** The timestamp of each block of `numbers` (null if not indexed or without one). */
  blockTimes(numbers: number[]): Map<number, number | null> {
    const wanted = [...new Set(numbers)];
    const out = new Map<number, number | null>(wanted.map((n) => [n, null]));
    for (let i = 0; i < wanted.length; i += 500) {
      const chunk = wanted.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT number, timestamp FROM blocks WHERE number IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as Array<{
        number: number; timestamp: number | null;
      }>;
      for (const r of rows) out.set(r.number, r.timestamp);
    }
    return out;
  }

  /** The genesis hash the store is tied to, null before `openForGenesis`. */
  genesis(): string | null {
    return this.getMeta('genesis');
  }

  /** The runtime versions seen so far, oldest first. */
  runtimes(): RuntimeRow[] {
    const rows = this.db.prepare('SELECT spec_version, from_block, spec_name FROM runtime_versions ORDER BY from_block').all() as unknown as Array<{
      spec_version: number; from_block: number; spec_name: string;
    }>;
    return rows.map((r) => ({ specVersion: r.spec_version, fromBlock: r.from_block, specName: r.spec_name }));
  }

  counts(): Counts {
    const rows = this.db.prepare('SELECT name, n FROM totals').all() as unknown as Array<{ name: keyof Counts; n: number }>;
    const counts: Counts = { blocks: 0, extrinsics: 0, events: 0, accounts: 0, transfers: 0, attestations: 0, migrations: 0, usernames: 0 };
    for (const r of rows) counts[r.name] = r.n;
    return counts;
  }
}
