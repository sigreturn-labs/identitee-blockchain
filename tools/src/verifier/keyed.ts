// A secret key for a channel's keyed hashes (code hashes, row ids), made once and kept in the state
// directory outside the database: whoever reads `verifier.db` cannot brute-force a live code (10^6
// values) nor learn what a row id stands for. Used by every channel that keeps keyed hashes.

import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The key in `<dir>/<file>`: 32 random bytes made on first use, mode 0600. */
export function loadKey(dir: string, file: string): Buffer {
  const path = join(dir, file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, 'hex');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString('hex'), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** HMAC-SHA256 of `purpose` and `parts` under `key`: the purpose keeps one use of the key apart from another. */
export const mac = (key: Buffer, purpose: string, ...parts: string[]): Buffer => createHmac('sha256', key).update([purpose, ...parts].join(':')).digest();
