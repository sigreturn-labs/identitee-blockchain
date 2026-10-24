// The verifier's state: challenges in progress (email codes, Telegram tokens, PGP challenges,
// OAuth and KYC sessions) with their expiry, and rate-limit hits. One SQLite file
// (`node:sqlite`), so that limits hold across restarts. Never a private value: a private field's
// value lives in `PacketMemory` only.

import { DatabaseSync } from 'node:sqlite';

export class Store {
  private readonly db: DatabaseSync;

  /** `path` is a file, or `:memory:` in the tests; `now` is the clock (ms since the epoch). */
  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS items (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        expires INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS hits (bucket TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hits_by_key ON hits (bucket, key, at);
    `);
  }

  /** Keep `data` (JSON) under `kind`/`id` for `ttlMs`, replacing any row there (attempts start at 0). */
  put(kind: string, id: string, data: unknown, ttlMs: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO items (kind, id, data, expires, attempts) VALUES (?, ?, ?, ?, 0)')
      .run(kind, id, JSON.stringify(data), this.now() + ttlMs);
  }

  /** The row's data, `null` if there is none or it expired. */
  get<T = unknown>(kind: string, id: string): T | null {
    const row = this.db.prepare('SELECT data FROM items WHERE kind = ? AND id = ? AND expires > ?').get(kind, id, this.now()) as { data: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.data) as T);
  }

  /** The row's data, deleted in the same statement: two callers never both get it. */
  take<T = unknown>(kind: string, id: string): T | null {
    const row = this.db.prepare('DELETE FROM items WHERE kind = ? AND id = ? RETURNING data, expires').get(kind, id) as { data: string; expires: number } | undefined;
    return row === undefined || row.expires <= this.now() ? null : (JSON.parse(row.data) as T);
  }

  /** The live rows of `kind`, oldest expiry first (a channel's sweep walks its own rows). */
  list<T = unknown>(kind: string): Array<{ id: string; data: T }> {
    const rows = this.db.prepare('SELECT id, data FROM items WHERE kind = ? AND expires > ? ORDER BY expires').all(kind, this.now()) as Array<{ id: string; data: string }>;
    return rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as T }));
  }

  /** Delete a row, if there is one. */
  drop(kind: string, id: string): void {
    this.db.prepare('DELETE FROM items WHERE kind = ? AND id = ?').run(kind, id);
  }

  /** Count one more attempt on a live row: the new count, `null` if there is no live row. */
  bump(kind: string, id: string): number | null {
    const row = this.db
      .prepare('UPDATE items SET attempts = attempts + 1 WHERE kind = ? AND id = ? AND expires > ? RETURNING attempts')
      .get(kind, id, this.now()) as { attempts: number } | undefined;
    return row === undefined ? null : row.attempts;
  }

  /**
   * Rate limit: `true` and one more hit counted if `key` had fewer than `limit` hits in `bucket`
   * during the last `windowMs`; `false` (and nothing counted) otherwise.
   */
  hit(bucket: string, key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { n } = this.db.prepare('SELECT count(*) AS n FROM hits WHERE bucket = ? AND key = ? AND at > ?').get(bucket, key, now - windowMs) as { n: number };
      const allowed = n < limit;
      if (allowed) this.db.prepare('INSERT INTO hits (bucket, key, at, expires) VALUES (?, ?, ?, ?)').run(bucket, key, now, now + windowMs);
      this.db.exec('COMMIT');
      return allowed;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** How many hits `key` has in `bucket` during the last `windowMs`; nothing is counted. */
  count(bucket: string, key: string, windowMs: number): number {
    const { n } = this.db.prepare('SELECT count(*) AS n FROM hits WHERE bucket = ? AND key = ? AND at > ?').get(bucket, key, this.now() - windowMs) as { n: number };
    return n;
  }

  /** Count one hit in `bucket` for `key` without any limit (read the limit with `count`, record when it was used). */
  record(bucket: string, key: string, windowMs: number): void {
    const now = this.now();
    this.db.prepare('INSERT INTO hits (bucket, key, at, expires) VALUES (?, ?, ?, ?)').run(bucket, key, now, now + windowMs);
  }

  /** Delete the expired rows and hits; how many. Run every minute. */
  sweep(): number {
    const now = this.now();
    const items = this.db.prepare('DELETE FROM items WHERE expires <= ?').run(now).changes;
    const hits = this.db.prepare('DELETE FROM hits WHERE expires <= ?').run(now).changes;
    return Number(items) + Number(hits);
  }

  /** Every row, for the tests that check what is stored. */
  dump(): { items: unknown[]; hits: unknown[] } {
    return { items: this.db.prepare('SELECT * FROM items').all(), hits: this.db.prepare('SELECT * FROM hits').all() };
  }

  close(): void {
    this.db.close();
  }
}
