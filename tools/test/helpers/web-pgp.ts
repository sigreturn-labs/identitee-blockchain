// What the Web and PGP channel tests share: a fake chain that holds any typed field, a local HTTPS
// server that answers for several host names (self-signed certificate in test/fixtures, test only),
// and the harness that runs the real HTTP server with one channel. No network.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';

import { publicCommitment, publicKeyOf, type AttestResult, type Chain, type FieldKey, type FieldKind, type FieldOnChain, type Method } from '../../src/verifier/chain.ts';
import { channelRegistry, type Channel } from '../../src/verifier/channels.ts';
import { parseConfig } from '../../src/verifier/config.ts';
import type { Ctx } from '../../src/verifier/ctx.ts';
import { HttpServer } from '../../src/verifier/http.ts';
import { verifierLogger } from '../../src/verifier/log.ts';
import { PacketMemory, privateCommitment, registerPacketRoute } from '../../src/verifier/packet.ts';
import { Store } from '../../src/verifier/store.ts';

export const GENESIS = `0x${'ab'.repeat(32)}`;
export const SALT = new Uint8Array(32).fill(0x11);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
/** A self-signed certificate for site.test, www.site.test, other.test and keys.openpgp.org (tests only). */
export const TEST_CERT = readFileSync(join(FIXTURES, 'tls-test.crt'));
// A throwaway key made for these tests, paired with the self-signed certificate above: it protects nothing.
const TEST_KEY = readFileSync(join(FIXTURES, 'tls-test.key'));

/** The bytes a field holds on chain: a PGP fingerprint as bytes, anything else as UTF-8. */
const bytesOf = (kind: FieldKind, value: string): Uint8Array => (kind === 'Pgp' ? hexToU8a(`0x${value}`) : stringToU8a(value));

/** What the chain holds, and what the agent attested. `attest` refuses like the runtime does. */
export class FakeChain implements Chain {
  readonly genesis = GENESIS;
  readonly fields = new Map<string, FieldOnChain>();
  readonly attests: Array<{ address: string; key: FieldKey; commitment: string; method: Method }> = [];
  /** Answer the next attestations with this, once each, instead of working. */
  failures: AttestResult[] = [];
  /** Called when an attestation starts (a test acts "meanwhile"). */
  onAttest: (() => void) | undefined;

  private slot = (address: string, kind: FieldKind): string => `${u8aToHex(publicKeyOf(address))}/${kind}`;

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  /** A PGP value is lowercase hex without 0x, as `LiveChain.field` gives it. */
  setPublic(address: string, kind: FieldKind, value: string): void {
    this.fields.set(this.slot(address, kind), { value, private: false, commitment: publicCommitment(bytesOf(kind, value)) });
  }

  setPrivate(address: string, kind: FieldKind, value: string, salt = SALT): string {
    const commitment = privateCommitment(salt, bytesOf(kind, value));
    this.fields.set(this.slot(address, kind), { value: null, private: true, commitment });
    return commitment;
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    return this.fields.get(this.slot(address, key.Typed)) ?? null;
  }

  async attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
    this.onAttest?.();
    const failure = this.failures.shift();
    if (failure !== undefined) return failure;
    const now = await this.field(address, key);
    if (now === null) return { ok: false, reason: 'gone' };
    if (now.commitment.toLowerCase() !== commitment.toLowerCase()) return { ok: false, reason: 'stale' };
    this.attests.push({ address, key, commitment, method });
    return { ok: true };
  }

  async grantDocument(): Promise<AttestResult> {
    return { ok: true };
  }

  async documentChecked(): Promise<boolean | null> {
    return false;
  }
}

// --- A local HTTPS server for several hosts ----------------------------------------------------------

export interface Seen {
  host: string;
  path: string;
  headers: IncomingMessage['headers'];
}

export type Site = (req: IncomingMessage, res: ServerResponse) => void;

export class FakeWeb {
  readonly seen: Seen[] = [];
  /** By host name (the Host header). */
  readonly sites = new Map<string, Site>();
  private server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      this.seen.push({ host, path: req.url ?? '', headers: req.headers });
      const site = this.sites.get(host);
      if (site === undefined) {
        res.writeHead(404).end('no such site');
        return;
      }
      site(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Serve `body` at `path` on `host` (404 elsewhere). */
  file(host: string, path: string, body: string | Buffer, status = 200): void {
    this.sites.set(host, (req, res) => {
      if (req.url === path) res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
      else res.writeHead(404).end();
    });
  }
}

// --- The harness ---------------------------------------------------------------------------------------

export type Answer = { status: number; json: Record<string, unknown> };

export interface Harness {
  clock: { t: number };
  chain: FakeChain;
  ctx: Ctx;
  lines: string[];
  store: Store;
  post(path: string, body?: unknown, ip?: string): Promise<Answer>;
  /** A raw body, to test the size limits. */
  postRaw(path: string, body: string): Promise<{ status: number }>;
}

export async function withChannel(channel: Channel, run: (h: Harness) => Promise<void>, clockStart = Date.now()): Promise<void> {
  const clock = { t: clockStart };
  const chain = new FakeChain();
  const stateDir = mkdtempSync(join(tmpdir(), 'verifier-webpgp-'));
  const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', STATE_DIRECTORY: stateDir });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const server = new HttpServer({ dev: false, log });
  registerPacketRoute(server, ctx);
  const registry = channelRegistry([channel], ctx, server);
  await registry.start();
  const port = await server.listen(0, '127.0.0.1');
  const post = async (path: string, body?: unknown, ip = '198.51.100.1'): Promise<Answer> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const postRaw = async (path: string, body: string): Promise<{ status: number }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await r.arrayBuffer();
    return { status: r.status };
  };
  try {
    await run({ clock, chain, ctx, lines, store, post, postRaw });
  } finally {
    await registry.stop();
    await server.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
