// Configuration of the explorer, from the environment only (a systemd EnvironmentFile), and the
// identit.ee profile links it hands out.

import { readFileSync } from 'node:fs';

export interface ExplorerConfig {
  /** The SQLite file of the index. */
  db: string;
  /** identitee node RPC endpoint (an archive node). */
  node: string;
  port: number;
  host: string;
  /** Browser origins allowed by CORS. */
  origins: string[];
  dev: boolean;
  /** Validator labels by hex key (lowercase). */
  labels: Record<string, string>;
}

export const DEFAULT_ORIGIN = 'https://explorer.identit.ee';
export const DEV_ORIGIN = 'http://localhost:5174';
export const PROFILE_BASE = 'https://identit.ee';

/** First path segments of the identit.ee app (web/src/routes.ts `RESERVED_PATHS`, kept equal by a test). */
export const RESERVED_PATHS: readonly string[] = ['me', 'requests', 'authority', 'a'];

/** The identit.ee profile of an account: its username's page, else its address's. */
export function profileUrl(name: string | null, address: string): string {
  return name !== null && name !== '' && !RESERVED_PATHS.includes(name) ? `${PROFILE_BASE}/${encodeURIComponent(name)}` : `${PROFILE_BASE}/a/${address}`;
}

export const USAGE = `usage: npx tsx src/explorer/main.ts

  EXPLORER_DB      SQLite file of the index (default /var/lib/identitee-explorer/explorer.db)
  EXPLORER_NODE    identitee node RPC endpoint (default ws://127.0.0.1:9944)
  EXPLORER_PORT    HTTP port (default 8788)
  EXPLORER_HOST    HTTP host (default 127.0.0.1)
  EXPLORER_ORIGIN  browser origin allowed by CORS (default ${DEFAULT_ORIGIN})
  EXPLORER_DEV     1: also allow ${DEV_ORIGIN}
  EXPLORER_LABELS  JSON file { "<hex key>": "label" } naming validators (optional)`;

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const KEY = /^0x[0-9a-f]{64}$/;

export function parseConfig(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ExplorerConfig {
  const portText = env.EXPLORER_PORT || '8788';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new Error(`EXPLORER_PORT is not a port: ${portText}\n${USAGE}`);
  const origin = env.EXPLORER_ORIGIN || DEFAULT_ORIGIN;
  if (!ORIGIN.test(origin)) throw new Error(`EXPLORER_ORIGIN is not an origin: ${origin}\n${USAGE}`);
  const dev = env.EXPLORER_DEV === '1';
  const labelsPath = env.EXPLORER_LABELS || null;
  return {
    db: env.EXPLORER_DB || '/var/lib/identitee-explorer/explorer.db',
    node: env.EXPLORER_NODE || 'ws://127.0.0.1:9944',
    port,
    host: env.EXPLORER_HOST || '127.0.0.1',
    origins: dev ? [origin, DEV_ORIGIN] : [origin],
    dev,
    labels: labelsPath === null ? {} : parseLabels(read(labelsPath), labelsPath),
  };
}

/** `{ "<0x + 64 hex>": "label" }`, keys lowercased; anything else throws. */
export function parseLabels(text: string, where = 'EXPLORER_LABELS'): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be a JSON object`);
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    const k = key.toLowerCase();
    if (!KEY.test(k)) throw new Error(`${where}: ${JSON.stringify(key.slice(0, 80))} is not a 32-byte hex key`);
    if (typeof label !== 'string' || label === '' || label.length > 64) throw new Error(`${where}: the label of ${k} must be a string of 1 to 64 characters`);
    out[k] = label;
  }
  return out;
}
