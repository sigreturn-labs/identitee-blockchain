// Tests of the KYC channel (src/verifier/didit.ts): a fake chain and a fake Didit behind an injected
// fetch, no network. The HTTP server is the real one.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { canonicalAddress, LiveChain, publicKeyOf, type AttestResult, type Chain, type FieldOnChain } from '../src/verifier/chain.ts';
import { channelRegistry } from '../src/verifier/channels.ts';
import { parseConfig } from '../src/verifier/config.ts';
import type { Ctx } from '../src/verifier/ctx.ts';
import { diditChannel, kycMessage, normalizeDocumentNumber, PENDING_MAX_MS, REVIEW_MAX_MS } from '../src/verifier/didit.ts';
import { HttpServer } from '../src/verifier/http.ts';
import { verifierLogger } from '../src/verifier/log.ts';
import { PacketMemory } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const BASE = 'https://didit.test';
const API_KEY = 'didit_API_KEY_secret_1';
const WORKFLOW = 'wf-1234';
const WH_SECRET = 'didit_WEBHOOK_secret_2';
const ENV = { DIDIT_API_KEY: API_KEY, DIDIT_WORKFLOW_ID: WORKFLOW, DIDIT_WEBHOOK_SECRET: WH_SECRET };
const MINUTE = 60_000;

let alice: KeyringPair;
let bob: KeyringPair;
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});

// --- A fake chain ------------------------------------------------------------------------------------

class FakeChain implements Chain {
  readonly genesis = GENESIS;
  /** Accounts with an identity, and whether each has an active DocumentChecked fact. */
  readonly identities = new Map<string, boolean>();
  readonly grants: string[] = [];
  /** Answer the next grants with this, once each. */
  failures: Array<AttestResult | Error> = [];

  private id = (address: string): string => u8aToHex(publicKeyOf(address));

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  addIdentity(address: string, checked = false): void {
    this.identities.set(this.id(address), checked);
  }

  async field(): Promise<FieldOnChain | null> {
    return null;
  }

  async attest(): Promise<AttestResult> {
    return { ok: true };
  }

  async grantDocument(address: string): Promise<AttestResult> {
    const failure = this.failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    if (!this.identities.has(this.id(address))) return { ok: false, reason: 'gone' };
    this.identities.set(this.id(address), true);
    this.grants.push(address);
    return { ok: true };
  }

  async documentChecked(address: string): Promise<boolean | null> {
    return this.identities.get(this.id(address)) ?? null;
  }
}

// --- A fake Didit ------------------------------------------------------------------------------------

/** Personal data a real decision carries: none of it may reach a log line or SQLite. */
const PERSONAL = ['Johanna', 'Mustermann', 'X1234567', 'Y7654321', '1984-08-12', 'Heidestrasse 17', 'portrait-image-url', '987654321098', 'Berlin'];

function decisionFor(session: string, address: string, status: string, documentNumber = 'X1234567', extra: Record<string, unknown> = {}) {
  return {
    session_id: session,
    session_number: 4242,
    status,
    workflow_id: WORKFLOW,
    vendor_data: address,
    id_verification: {
      status,
      document_type: 'Passport',
      document_number: documentNumber,
      personal_number: '987654321098',
      issuing_state: 'DEU',
      issuing_state_name: 'Germany',
      first_name: 'Johanna',
      last_name: 'Mustermann',
      full_name: 'Johanna Mustermann',
      date_of_birth: '1984-08-12',
      place_of_birth: 'Berlin',
      address: 'Heidestrasse 17',
      portrait_image: 'https://didit.test/portrait-image-url',
    },
    liveness: { status: 'Approved', score: 98 },
    ...extra,
  };
}

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

class FakeDidit {
  readonly calls: Call[] = [];
  readonly decisions = new Map<string, unknown>();
  private next = 0;
  /** Status answered to session creation, decision fetch, session delete, user delete. */
  createStatus = 201;
  decisionStatus = 200;
  deleteStatus = 200;
  userDeleteStatus = 200;
  throwOnDecision = false;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    this.calls.push({ method, url, headers: new Headers(init?.headers), body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && url === `${BASE}/v2/session/`) {
      if (this.createStatus >= 300) return json(this.createStatus, { detail: 'no' });
      const id = `0000000${++this.next}-aaaa-bbbb-cccc-0123456789ab`;
      this.created.push(id);
      return json(this.createStatus, { session_id: id, session_number: this.next, url: `https://verify.didit.test/session/${id}`, vendor_data: body.vendor_data });
    }
    const decision = /^https:\/\/didit\.test\/v2\/session\/([^/]+)\/decision\/$/.exec(url);
    if (method === 'GET' && decision) {
      if (this.throwOnDecision) throw new TypeError('fetch failed');
      if (this.decisionStatus >= 300) return json(this.decisionStatus, {});
      const d = this.decisions.get(decodeURIComponent(decision[1]!));
      return d === undefined ? json(404, {}) : json(200, d);
    }
    if (method === 'DELETE' && /^https:\/\/didit\.test\/v1\/session\/[^/]+\/delete\/$/.test(url)) return new Response(null, { status: this.deleteStatus });
    if (method === 'POST' && url === `${BASE}/v3/users/delete/`) return json(this.userDeleteStatus, {});
    return json(404, {});
  }) as typeof fetch;

  /** The ids of the sessions created, in order. */
  readonly created: string[] = [];

  sessions(): string[] {
    return [...this.created];
  }

  count(method: string, part: string): number {
    return this.calls.filter((c) => c.method === method && c.url.includes(part)).length;
  }
}

// --- The harness -------------------------------------------------------------------------------------

type Answer = { status: number; json: Record<string, unknown> };

interface StartOptions {
  /** Who signs (default: `who` itself, or Alice for an address given as text). */
  signer?: KeyringPair;
  /** The signed message's time (default now) and chain (default the fake chain's genesis). */
  time?: number;
  chain?: string;
  /** Send exactly this message / signature instead (`null`: leave it out). */
  message?: string | null;
  signature?: string | null;
}

/** The start message signed as a wallet signs it. */
function signedStart(signer: KeyringPair, address: string, time: number, chain = GENESIS) {
  const message = kycMessage(chain, canonicalAddress(address) ?? address, time);
  return { message, signature: u8aToHex(signer.sign(u8aWrapBytes(stringToU8a(message)))) };
}

interface Harness {
  clock: { t: number };
  chain: FakeChain;
  didit: FakeDidit;
  ctx: Ctx;
  lines: string[];
  stateDir: string;
  enabled: string[];
  channel: ReturnType<typeof diditChannel>;
  start(who: KeyringPair | string, ip?: string, o?: StartOptions): Promise<Answer>;
  status(who: KeyringPair | string): Promise<Answer>;
  webhook(body: unknown, options?: { signature?: string | null; headers?: Record<string, string> }): Promise<Answer>;
  post(path: string, body: unknown): Promise<Answer>;
}

const sign = (raw: string, secret = WH_SECRET): string => createHmac('sha256', secret).update(raw).digest('hex');

async function withHarness(options: { env?: Record<string, string> }, run: (h: Harness) => Promise<void>): Promise<void> {
  const clock = { t: 1_800_000_000_000 };
  const chain = new FakeChain();
  const didit = new FakeDidit();
  const stateDir = mkdtempSync(join(tmpdir(), 'verifier-didit-'));
  const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', VERIFIER_DEV: '1', STATE_DIRECTORY: stateDir, ...(options.env ?? ENV) });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const server = new HttpServer({ dev: false, log });
  const channel = diditChannel({ fetch: didit.fetch, baseUrl: BASE, sweepMs: 0 });
  const registry = channelRegistry([channel], ctx, server);
  await registry.start();
  const port = await server.listen(0, '127.0.0.1');
  const call = async (method: 'GET' | 'POST', path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  let seq = 0;
  const addressOf = (who: KeyringPair | string): string => (typeof who === 'string' ? who : who.address);
  const h: Harness = {
    clock,
    chain,
    didit,
    ctx,
    lines,
    stateDir,
    enabled: registry.enabled,
    channel,
    start: (who, ip = '198.51.100.1', o = {}) => {
      const address = addressOf(who);
      const signer = o.signer ?? (typeof who === 'string' ? alice : who);
      // A distinct millisecond for each start: a start message is used once.
      const made = signedStart(signer, address, o.time ?? clock.t + ++seq, o.chain);
      const body: Record<string, unknown> = { address };
      if (o.message !== null) body.message = o.message ?? made.message;
      if (o.signature !== null) body.signature = o.signature ?? made.signature;
      return call('POST', '/api/kyc/start', JSON.stringify(body), { 'x-forwarded-for': ip });
    },
    status: (who) => call('GET', `/api/kyc/status?address=${encodeURIComponent(addressOf(who))}`),
    webhook: (body, o = {}) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const signature = o.signature === undefined ? sign(raw) : o.signature;
      return call('POST', '/didit/webhook', raw, { ...(signature === null ? {} : { 'x-signature': signature }), ...(o.headers ?? {}) });
    },
    post: (path, body) => call('POST', path, JSON.stringify(body)),
  };
  try {
    await run(h);
  } finally {
    await registry.stop();
    await server.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Start a session for `who` (who has an identity) and make Didit's decision `status`. */
async function started(h: Harness, who: KeyringPair, status: string, documentNumber?: string, ip?: string): Promise<string> {
  h.chain.addIdentity(who.address);
  const r = await h.start(who, ip);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const session = h.didit.sessions().at(-1)!;
  h.didit.decisions.set(session, decisionFor(session, who.address, status, documentNumber));
  return session;
}

const event = (session: string, status: string, address: string, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  status,
  webhook_type: 'status.updated',
  vendor_data: address,
  workflow_id: WORKFLOW,
  ...extra,
});

/** Close the last session Didit made for `who` as declined, so that a new one may start. */
async function close(h: Harness, who: KeyringPair): Promise<void> {
  const session = h.didit.sessions().at(-1)!;
  h.didit.decisions.set(session, decisionFor(session, who.address, 'Declined'));
  await h.webhook(event(session, 'Declined', who.address));
  await h.channel.idle();
}

const events = (h: Harness): string[] => h.lines.map((l) => (JSON.parse(l) as { event: string }).event);

// --- Tests -------------------------------------------------------------------------------------------

describe('KYC: configuration', () => {
  it('is enabled only with the three Didit variables', async () => {
    await withHarness({ env: { DIDIT_API_KEY: API_KEY, DIDIT_WORKFLOW_ID: WORKFLOW } }, async (h) => {
      assert.deepEqual(h.enabled, []);
      assert.deepEqual(await h.start(alice), { status: 503, json: { error: 'This verification is not available yet.' } });
      assert.equal((await h.webhook({})).status, 503);
      assert.equal((await h.status(alice)).status, 503);
    });
    await withHarness({}, async (h) => assert.deepEqual(h.enabled, ['kyc']));
  });

  it('keeps its key in didit.key, mode 0600', async () => {
    await withHarness({}, async (h) => {
      assert.equal(statSync(join(h.stateDir, 'didit.key')).mode & 0o777, 0o600);
    });
  });
});

describe('KYC: start', () => {
  it('creates a Didit session for the canonical address and returns its url', async () => {
    await withHarness({}, async (h) => {
      h.chain.addIdentity(alice.address);
      const other = encodeAddress(alice.publicKey, 0);
      const r = await h.start(other);
      assert.equal(r.status, 200);
      const session = h.didit.sessions()[0]!;
      assert.deepEqual(r.json, { url: `https://verify.didit.test/session/${session}` });
      const call = h.didit.calls[0]!;
      assert.equal(call.headers.get('x-api-key'), API_KEY);
      assert.deepEqual(call.body, { workflow_id: WORKFLOW, vendor_data: alice.address, callback: 'https://identit.ee/me?kyc=done' });
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
      assert.ok(events(h).includes('kyc-started'));
    });
  });

  it('needs a fresh wallet signature of the address, used once', async () => {
    await withHarness({}, async (h) => {
      h.chain.addIdentity(alice.address);
      const sign = { error: 'Sign the request with your wallet to start.' };
      const invalid = { error: 'This signature is not valid. Try again.' };
      assert.deepEqual(await h.start(alice, undefined, { signature: null }), { status: 400, json: sign });
      assert.deepEqual(await h.start(alice, undefined, { message: null }), { status: 400, json: sign });
      assert.deepEqual(await h.start(alice, undefined, { signer: bob }), { status: 400, json: invalid }, "another account's signature");
      assert.deepEqual(await h.start(alice, undefined, { chain: `0x${'cd'.repeat(32)}` }), { status: 400, json: invalid }, 'another chain');
      assert.deepEqual(await h.start(alice, undefined, { time: h.clock.t - 5 * MINUTE - 1 }), { status: 400, json: invalid }, 'too old');
      assert.deepEqual(await h.start(alice, undefined, { time: h.clock.t + 5 * MINUTE + 1 }), { status: 400, json: invalid }, 'too far ahead');
      const other = signedStart(alice, bob.address, h.clock.t);
      assert.deepEqual(await h.start(alice, undefined, other), { status: 400, json: invalid }, 'signed for another address');
      const good = signedStart(alice, alice.address, h.clock.t - 4 * MINUTE);
      assert.deepEqual(await h.start(alice, undefined, { message: `${good.message} `, signature: good.signature }), { status: 400, json: invalid }, 'altered message');
      assert.deepEqual(await h.start(alice, undefined, { message: good.message, signature: '0x1234' }), { status: 400, json: invalid });
      assert.equal(h.didit.calls.length, 0, 'Didit is never called for a refused signature');
      assert.equal((await h.start(alice, undefined, good)).status, 200);
      assert.deepEqual(await h.start(alice, '198.51.100.99', good), { status: 400, json: invalid }, 'a replay');
      assert.equal(h.didit.calls.length, 1);
    });
  });

  it('refuses a bad address, an account without identity, and an already checked document', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(await h.start('nope'), { status: 400, json: { error: 'This is not a valid account address.' } });
      assert.deepEqual(await h.start(alice), { status: 400, json: { error: 'Create your identity first.' } });
      h.chain.addIdentity(alice.address, true);
      assert.deepEqual(await h.start(alice), { status: 409, json: { error: 'Your identity document is already checked.' } });
      assert.equal(h.didit.calls.length, 0);
    });
  });

  it('allows 3 sessions a day per IP and address, without locking the owner out from another IP', async () => {
    await withHarness({}, async (h) => {
      h.chain.addIdentity(alice.address);
      for (let i = 0; i < 3; i++) {
        assert.equal((await h.start(alice, '203.0.113.9')).status, 200);
        await close(h, alice);
      }
      assert.deepEqual(await h.start(alice, '203.0.113.9'), { status: 429, json: { error: 'Too many identity checks today. Try again tomorrow.' } });
      assert.equal((await h.start(alice, '198.51.100.7')).status, 200);
      await close(h, alice);
      h.clock.t += 24 * 60 * MINUTE + 1;
      assert.equal((await h.start(alice, '203.0.113.9')).status, 200);
    });
  });

  it('says so when Didit does not create the session, and keeps nothing', async () => {
    await withHarness({}, async (h) => {
      h.chain.addIdentity(alice.address);
      h.didit.createStatus = 500;
      assert.deepEqual(await h.start(alice), { status: 502, json: { error: 'The identity check could not be started. Try again in a moment.' } });
      assert.deepEqual((await h.status(alice)).json, { status: 'none' });
      assert.ok(h.lines.some((l) => l.includes('kyc-start-failed') && l.includes('"status":500')));
      // Failures do not use up the 3 sessions of the day.
      for (let i = 0; i < 3; i++) assert.equal((await h.start(alice)).status, 502);
      h.didit.createStatus = 201;
      for (let i = 0; i < 3; i++) {
        assert.equal((await h.start(alice)).status, 200);
        await close(h, alice);
      }
      assert.equal((await h.start(alice)).status, 429);
    });
  });

  it('status: none for an unknown address, 400 for a bad one', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(await h.status(bob), { status: 200, json: { status: 'none' } });
      assert.equal((await h.status('nope')).status, 400);
    });
  });
});

describe('KYC: webhook', () => {
  it('grants once on an approved decision, then deletes the session and the user at Didit; a replay does nothing more', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      const body = event(session, 'Approved', alice.address);
      assert.deepEqual(await h.webhook(body), { status: 200, json: { ok: true } });
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.deepEqual((await h.status(alice)).json, { status: 'approved' });
      const decisionCall = h.didit.calls.find((c) => c.url.includes('/decision/'))!;
      assert.equal(decisionCall.headers.get('x-api-key'), API_KEY);
      assert.equal(h.didit.count('DELETE', `/v1/session/${session}/delete/`), 1);
      const userDelete = h.didit.calls.find((c) => c.url.endsWith('/v3/users/delete/'))!;
      assert.deepEqual(userDelete.body, { vendor_data_list: [alice.address] });
      assert.ok(events(h).includes('kyc-approved'));
      const kinds = (h.ctx.store.dump().items as Array<{ kind: string }>).map((r) => r.kind).sort();
      assert.deepEqual(kinds, ['kyc-address', 'kyc-document', 'kyc-signature'], 'the session row goes once deleted at Didit');

      const fetched = h.didit.calls.length;
      assert.equal((await h.webhook(body)).status, 200);
      await h.channel.idle();
      await h.channel.sweep();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.equal(h.didit.calls.length, fetched, 'nothing more asked of Didit');
    });
  });

  it('a replay while the deletion at Didit is still to do grants nothing more', async () => {
    await withHarness({}, async (h) => {
      h.didit.deleteStatus = 500;
      const session = await started(h, alice, 'Approved');
      const body = event(session, 'Approved', alice.address);
      await h.webhook(body);
      await h.channel.idle();
      h.chain.addIdentity(alice.address, false); // even with the fact gone meanwhile
      for (let i = 0; i < 2; i++) assert.equal((await h.webhook(body)).status, 200);
      await h.channel.idle();
      await h.channel.sweep();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.equal(h.didit.count('GET', '/decision/'), 1);
    });
  });

  it('refuses a bad or missing signature with 401 and does nothing', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      const body = event(session, 'Approved', alice.address);
      assert.equal((await h.webhook(body, { signature: sign(JSON.stringify(body), 'wrong-secret') })).status, 401);
      assert.equal((await h.webhook(body, { signature: null })).status, 401);
      assert.equal((await h.webhook(body, { signature: 'zz' })).status, 401);
      // Signed, then altered.
      const raw = JSON.stringify(body);
      assert.equal((await h.webhook(raw.replace('Approved', 'Approved '), { signature: sign(raw) })).status, 401);
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.equal(h.didit.count('GET', '/decision/'), 0);
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
    });
  });

  it('acts on the decision fetched from Didit, not on the webhook: Approved in the webhook, Declined at Didit', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Declined');
      assert.equal((await h.webhook(event(session, 'Approved', alice.address))).status, 200);
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.deepEqual((await h.status(alice)).json, { status: 'declined' });
      assert.equal(h.didit.count('DELETE', '/delete/'), 1);
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 1);
    });
  });

  it('waits while Didit has no final decision, then acts on a later webhook', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'In Progress');
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
      assert.equal(h.didit.count('DELETE', '/delete/'), 0);
      h.didit.decisions.set(session, decisionFor(session, alice.address, 'Approved'));
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
    });
  });

  it('ignores an unknown session, and a decision for another address', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(await h.webhook(event('99999999-aaaa-bbbb-cccc-0123456789ab', 'Approved', alice.address)), { status: 200, json: { ok: true } });
      await h.channel.idle();
      assert.equal(h.didit.count('GET', '/decision/'), 0);

      const session = await started(h, alice, 'Approved');
      h.didit.decisions.set(session, decisionFor(session, bob.address, 'Approved'));
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.ok(events(h).includes('kyc-mismatch'));
    });
  });

  it('refuses an event older than 10 minutes (signed timestamp), and one with an old X-Timestamp', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      const now = Math.floor(h.clock.t / 1000);
      assert.equal((await h.webhook(event(session, 'Approved', alice.address, { timestamp: now - 11 * 60 }))).status, 401);
      assert.equal((await h.webhook(event(session, 'Approved', alice.address), { headers: { 'x-timestamp': String(now - 11 * 60) } })).status, 401);
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.equal((await h.webhook(event(session, 'Approved', alice.address, { timestamp: now - 60 }), { headers: { 'x-timestamp': String(now) } })).status, 200);
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
    });
  });
});

describe('KYC: one document, one address', () => {
  it('refuses a document that already certified another address', async () => {
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Approved', 'X1234567');
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      // The same passport, written differently.
      const second = await started(h, bob, 'Approved', 'x1234 567');
      await h.webhook(event(second, 'Approved', bob.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.deepEqual((await h.status(bob)).json, { status: 'declined' });
      assert.ok(events(h).includes('kyc-duplicate'));
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 2, 'the duplicate is deleted at Didit too');
    });
  });

  it('keys on number and country only: personal number and type do not count, alpha-2 equals alpha-3', async () => {
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Approved', 'X1234567');
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      // Another document with the same personal number is another document.
      const second = await started(h, bob, 'Approved', 'Y7654321');
      await h.webhook(event(second, 'Approved', bob.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address, bob.address]);
      // The first passport again, as an ID card from "DE": the same document.
      const charlie = new Keyring({ type: 'sr25519', ss58Format: 2426 }).addFromUri('//Charlie');
      const third = await started(h, charlie, 'Approved');
      const d = decisionFor(third, charlie.address, 'Approved');
      h.didit.decisions.set(third, { ...d, id_verification: { ...d.id_verification, issuing_state: 'de', document_type: 'Identity Card', personal_number: '1' } });
      await h.webhook(event(third, 'Approved', charlie.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address, bob.address]);
      assert.deepEqual((await h.status(charlie)).json, { status: 'declined' });
    });
  });

  it('keeps the letters of any script in a document number', async () => {
    assert.equal(normalizeDocumentNumber(' ab-12 34 '), 'AB1234');
    assert.equal(normalizeDocumentNumber('ＡＢ１２'), 'AB12', 'full-width forms fold (NFKC)');
    assert.notEqual(normalizeDocumentNumber('ΑΒ123456'), normalizeDocumentNumber('ΑΕ123456'));
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Approved', 'ΑΒ123456');
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      const second = await started(h, bob, 'Approved', 'ΑΕ123456');
      await h.webhook(event(second, 'Approved', bob.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address, bob.address], 'two Greek numbers differing only in letters are two documents');
    });
  });

  it('lets the same document certify the same address again', async () => {
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Approved');
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      h.chain.addIdentity(alice.address, false); // the fact was revoked
      const second = await started(h, alice, 'Approved');
      await h.webhook(event(second, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address, alice.address]);
    });
  });

  it('does not grant an approval without a document key: kept at Didit for the operator, at most 7 days', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      h.didit.decisions.set(session, { session_id: session, status: 'Approved', vendor_data: alice.address, id_verification: { status: 'Approved', first_name: 'Johanna', issuing_state: 'DEU' } });
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.ok(h.lines.some((l) => l.includes('kyc-needs-review') && l.includes(alice.address)));
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
      assert.equal(h.didit.count('DELETE', '/delete/') + h.didit.count('POST', '/v3/users/delete/'), 0, 'kept at Didit');
      const asked = h.didit.calls.length;
      h.clock.t += REVIEW_MAX_MS - MINUTE;
      await h.channel.sweep();
      assert.equal(h.didit.calls.length, asked, 'not polled, not deleted before 7 days');
      h.clock.t += 2 * MINUTE;
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', `/v1/session/${session}/delete/`), 1);
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 1);
      assert.deepEqual((await h.status(alice)).json, { status: 'none' });
      assert.deepEqual(h.chain.grants, []);
    });
  });

  it('reads the document from the id_verifications list of newer decisions', async () => {
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Approved');
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      const second = await started(h, bob, 'Approved');
      const { id_verification, ...rest } = decisionFor(second, bob.address, 'Approved');
      h.didit.decisions.set(second, { ...rest, id_verifications: [{ ...id_verification, personal_number: undefined }] });
      await h.webhook(event(second, 'Approved', bob.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
    });
  });
});

describe('KYC: privacy', () => {
  it('no personal field reaches the logs or SQLite', async () => {
    await withHarness({}, async (h) => {
      const a = await started(h, alice, 'Approved');
      // A webhook body full of the decision too, as Didit sends it.
      await h.webhook({ ...event(a, 'Approved', alice.address), decision: decisionFor(a, alice.address, 'Approved') });
      await h.channel.idle();
      const b = await started(h, bob, 'Approved', 'X1234567');
      await h.webhook(event(b, 'Approved', bob.address));
      await h.channel.idle();
      const stored = JSON.stringify(h.ctx.store.dump());
      const logged = h.lines.join('\n');
      for (const value of [...PERSONAL, API_KEY, WH_SECRET, 'DEU', 'Passport']) {
        assert.ok(!stored.includes(value), `stored: ${value}`);
        assert.ok(!logged.includes(value), `logged: ${value}`);
      }
      assert.ok(events(h).includes('kyc-duplicate'));
    });
  });
});

describe('KYC: failures and the sweep', () => {
  it('logs each deletion at Didit: kyc-purged when done, kyc-purge-not-found on a 404', async () => {
    await withHarness({}, async (h) => {
      h.didit.userDeleteStatus = 404;
      const session = await started(h, alice, 'Approved');
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      const mine = h.lines.filter((l) => l.includes('kyc-purge'));
      assert.equal(mine.length, 2, mine.join('\n'));
      assert.ok(mine.some((l) => l.includes('"kyc-purged"') && l.includes('"what":"session"')), mine.join('\n'));
      assert.ok(mine.some((l) => l.includes('kyc-purge-not-found') && l.includes('"what":"user"') && l.includes('"status":404')), mine.join('\n'));
      for (const l of mine) assert.ok(!l.includes(alice.address) && !l.includes(session), l);
      await h.channel.sweep();
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 1, 'a 404 is done: not asked again');
    });
  });

  it('retries a failed deletion at Didit in the sweep, and logs the status only', async () => {
    await withHarness({}, async (h) => {
      h.didit.deleteStatus = 500;
      h.didit.userDeleteStatus = 503;
      const session = await started(h, alice, 'Approved');
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.ok(h.lines.some((l) => l.includes('kyc-delete-failed') && l.includes('"what":"session"') && l.includes('"status":500')));
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 0, 'the user goes after the session');
      h.didit.deleteStatus = 404; // already gone counts as deleted
      await h.channel.sweep();
      assert.ok(h.lines.some((l) => l.includes('kyc-delete-failed') && l.includes('"what":"user"') && l.includes('"status":503')));
      // a 404 counts as done, but is said apart (a wrong path would show), with nothing personal
      const notFound = h.lines.filter((l) => l.includes('kyc-purge-not-found'));
      assert.equal(notFound.length, 1, notFound.join('\n'));
      assert.ok(notFound[0]!.includes('"what":"session"') && notFound[0]!.includes('"status":404'), notFound[0]);
      assert.ok(!notFound[0]!.includes(alice.address) && !notFound[0]!.includes(session), notFound[0]);
      assert.ok(!h.lines.some((l) => l.includes('kyc-purged')), 'a 404 is not a deletion');
      h.didit.userDeleteStatus = 200;
      await h.channel.sweep();
      const purged = h.lines.filter((l) => l.includes('kyc-purged'));
      assert.equal(purged.length, 1, purged.join('\n'));
      assert.ok(purged[0]!.includes('"what":"user"') && !purged[0]!.includes(alice.address), purged[0]);
      assert.equal(h.didit.count('DELETE', '/delete/'), 2, 'the session is not deleted again');
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 2);
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', '/delete/'), 2, 'nothing left to delete');
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 2);
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.deepEqual((await h.status(alice)).json, { status: 'approved' });
    });
  });

  it('retries the grant in the sweep when the chain failed, without asking Didit again', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      h.chain.failures.push({ ok: false, reason: 'failed', detail: 'pool' });
      await h.webhook(event(session, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, []);
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
      const decisions = h.didit.count('GET', '/decision/');
      await h.channel.sweep();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.equal(h.didit.count('GET', '/decision/'), decisions);
      assert.deepEqual((await h.status(alice)).json, { status: 'approved' });
    });
  });

  it('logs a crash of the background work by its class only', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      h.chain.failures.push(new Error('Johanna secret detail'));
      assert.equal((await h.webhook(event(session, 'Approved', alice.address))).status, 200);
      await h.channel.idle();
      assert.ok(h.lines.some((l) => l.includes('kyc-background-failed') && l.includes('"error":"Error"')));
      assert.ok(!h.lines.join('\n').includes('secret detail'));
    });
  });

  it('settles a session whose webhook never came, and abandons one left pending too long', async () => {
    await withHarness({}, async (h) => {
      h.didit.throwOnDecision = true;
      const missed = await started(h, alice, 'Approved');
      await h.webhook(event(missed, 'Approved', alice.address));
      await h.channel.idle();
      assert.ok(h.lines.some((l) => l.includes('kyc-decision-failed') && l.includes('TypeError')));
      h.didit.throwOnDecision = false;
      const idle = await started(h, bob, 'Not Started');
      h.clock.t += 15 * MINUTE;
      await h.channel.sweep();
      assert.deepEqual(h.chain.grants, [alice.address]);
      assert.deepEqual((await h.status(bob)).json, { status: 'pending' });
      h.clock.t += PENDING_MAX_MS;
      await h.channel.sweep();
      assert.deepEqual((await h.status(bob)).json, { status: 'none' });
      assert.equal(h.didit.count('DELETE', `/v1/session/${idle}/delete/`), 1);
      assert.ok(events(h).includes('kyc-abandoned'));
      assert.deepEqual(h.chain.grants, [alice.address]);
    });
  });
});

describe('KYC: chain', () => {
  it('LiveChain.documentChecked reads the active DocumentChecked facts of the profile', async () => {
    const profiles = new Map<string, unknown>([
      [u8aToHex(alice.publicKey), { identity: {}, facts: [['DocumentChecked', 0, {}, true]] }],
      [u8aToHex(bob.publicKey), { identity: {}, facts: [['DocumentChecked', 0, {}, false], ['Fraud', 0, {}, true]] }],
    ]);
    const api = {
      genesisHash: { toHex: () => GENESIS },
      call: { identiteeApi: { profile: async (key: string) => ({ toJSON: () => profiles.get(key) ?? null }) } },
    } as unknown as ApiPromise;
    const chain = new LiveChain(api, alice, () => undefined);
    assert.equal(await chain.documentChecked(alice.address), true);
    assert.equal(await chain.documentChecked(bob.address), false);
    assert.equal(await chain.documentChecked(encodeAddress(new Uint8Array(32).fill(7), 2426)), null);
  });
});

describe('KYC: abandon windows', () => {
  for (const status of ['Not Started', 'In Progress']) {
    it(`abandons "${status}" after 24 hours, not before`, async () => {
      await withHarness({}, async (h) => {
        const session = await started(h, alice, status);
        h.clock.t += PENDING_MAX_MS - MINUTE;
        await h.channel.sweep();
        assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
        assert.equal(h.didit.count('DELETE', '/delete/'), 0);
        h.clock.t += 2 * MINUTE;
        await h.channel.sweep();
        assert.deepEqual((await h.status(alice)).json, { status: 'none' });
        assert.equal(h.didit.count('DELETE', `/v1/session/${session}/delete/`), 1);
        assert.equal(h.didit.count('POST', '/v3/users/delete/'), 1);
        assert.deepEqual(h.ctx.store.list('kyc-session'), [], 'not polled any more');
      });
    });
  }

  it('keeps "In Review" at Didit for 7 days, then abandons it', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'In Review');
      await h.webhook(event(session, 'In Review', alice.address));
      await h.channel.idle();
      h.clock.t += 3 * PENDING_MAX_MS;
      await h.channel.sweep();
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' });
      assert.equal(h.didit.count('DELETE', '/delete/'), 0);
      h.clock.t += REVIEW_MAX_MS - 3 * PENDING_MAX_MS;
      await h.channel.sweep();
      assert.deepEqual((await h.status(alice)).json, { status: 'none' });
      assert.equal(h.didit.count('DELETE', `/v1/session/${session}/delete/`), 1);
    });
  });

  it('abandons and deletes a session whose decision cannot be read, or does not match, after 24 hours', async () => {
    await withHarness({}, async (h) => {
      const unread = await started(h, alice, 'Approved');
      h.didit.decisions.delete(unread); // Didit answers 404
      const wrong = await started(h, bob, 'Approved');
      h.didit.decisions.set(wrong, decisionFor(wrong, alice.address, 'Approved'));
      h.clock.t += 15 * MINUTE;
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', '/delete/'), 0);
      h.clock.t += PENDING_MAX_MS;
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', `/v1/session/${unread}/delete/`), 1);
      assert.equal(h.didit.count('DELETE', `/v1/session/${wrong}/delete/`), 1);
      assert.deepEqual(h.ctx.store.list('kyc-session'), []);
      assert.deepEqual(h.chain.grants, []);
      const polled = h.didit.count('GET', '/decision/');
      h.clock.t += PENDING_MAX_MS;
      await h.channel.sweep();
      assert.equal(h.didit.count('GET', '/decision/'), polled);
    });
  });
});

describe('KYC: webhook bytes and shutdown', () => {
  it('checks the HMAC over the raw bytes, whatever the spacing and key order', async () => {
    await withHarness({}, async (h) => {
      const session = await started(h, alice, 'Approved');
      const raw = `{\n  "webhook_type" : "status.updated",\t"status":"Approved" ,\n"session_id":   "${session}", "vendor_data":"${alice.address}"\n}\n`;
      // Signed as re-serialised JSON instead of the bytes sent: refused.
      assert.equal((await h.webhook(raw, { signature: sign(JSON.stringify(JSON.parse(raw))) })).status, 401);
      assert.equal((await h.webhook(raw, { signature: sign(raw) })).status, 200);
      await h.channel.idle();
      assert.deepEqual(h.chain.grants, [alice.address]);
    });
  });

  it('queues nothing once stopped', async () => {
    await withHarness({}, async (h) => {
      await started(h, alice, 'Approved');
      h.clock.t += PENDING_MAX_MS * 2;
      await h.channel.stop?.();
      // As after main's shutdown: the store is closed.
      h.ctx.store.list = () => {
        throw new Error('the store is closed');
      };
      const calls = h.didit.calls.length;
      await h.channel.sweep();
      await h.channel.idle();
      assert.equal(h.didit.calls.length, calls);
      assert.deepEqual(h.chain.grants, []);
    });
  });
});

describe('KYC: single use, busy sessions, review kept', () => {
  it('uses a start message once, whatever signature carries it', async () => {
    await withHarness({}, async (h) => {
      h.chain.addIdentity(alice.address);
      const invalid = { status: 400, json: { error: 'This signature is not valid. Try again.' } };
      const first = signedStart(alice, alice.address, h.clock.t);
      assert.equal((await h.start(alice, undefined, first)).status, 200);
      await close(h, alice);
      const prefixed = { message: first.message, signature: `0x01${first.signature.slice(2)}` };
      assert.deepEqual(await h.start(alice, undefined, prefixed), invalid, 'the same signature as a 0x01 MultiSignature');
      const again = signedStart(alice, alice.address, h.clock.t);
      assert.notEqual(again.signature, first.signature);
      assert.deepEqual(await h.start(alice, undefined, again), invalid, 'a new signature over the same message');
      // Other forms of the signature are refused.
      const fresh = signedStart(alice, alice.address, h.clock.t + 1);
      for (const signature of [`0x00${fresh.signature.slice(2)}`, `0x02${fresh.signature.slice(2)}`, `${fresh.signature}00`]) {
        assert.deepEqual(await h.start(alice, undefined, { message: fresh.message, signature }), invalid, signature.slice(0, 4));
      }
      assert.equal(h.didit.calls.filter((c) => c.url.endsWith('/v2/session/')).length, 1);
      // Another time is another message; the 0x01 form of an sr25519 signature is accepted.
      assert.equal((await h.start(alice, undefined, { message: fresh.message, signature: `0x01${fresh.signature.slice(2)}` })).status, 200);
      await close(h, alice);
      assert.equal((await h.start(alice, undefined, signedStart(alice, alice.address, h.clock.t + 2))).status, 200);
    });
  });

  it('gives back the same Didit page while the session is still to do there, without a new session', async () => {
    await withHarness({}, async (h) => {
      const first = await started(h, alice, 'Not Started');
      const url = `https://verify.didit.test/session/${first}`;
      // Closed the tab and came back, from another IP even.
      assert.deepEqual(await h.start(alice), { status: 200, json: { url } });
      h.didit.decisions.set(first, decisionFor(first, alice.address, 'In Progress'));
      await h.webhook(event(first, 'In Progress', alice.address));
      await h.channel.idle();
      assert.deepEqual(await h.start(alice, '198.51.100.200'), { status: 200, json: { url } });
      assert.equal(h.didit.created.length, 1, 'no new session at Didit');
      // Not counted: 3 resumes, and a new session can still be made after it ends.
      assert.deepEqual(await h.start(alice), { status: 200, json: { url } });
      assert.equal(h.ctx.store.count('kyc-start', `198.51.100.1|${alice.address}`, 24 * 60 * MINUTE), 1);
      assert.ok(!h.lines.join('\n').includes(url), 'the page is never logged');
      assert.ok(events(h).includes('kyc-resumed'));
      await close(h, alice);
      const second = await h.start(alice);
      assert.equal(second.status, 200);
      assert.notDeepEqual(second.json, { url });
      assert.equal(h.didit.created.length, 2);
    });
  });

  it('refuses a new session while one is in review at Didit, being granted, or in our review', async () => {
    await withHarness({}, async (h) => {
      const busy = { status: 409, json: { error: 'Your identity document is already being checked.' } };
      const first = await started(h, alice, 'In Review');
      await h.webhook(event(first, 'In Review', alice.address));
      await h.channel.idle();
      assert.deepEqual(await h.start(alice), busy, 'In Review at Didit');
      h.didit.decisions.set(first, { session_id: first, status: 'Approved', vendor_data: alice.address, id_verification: {} });
      await h.webhook(event(first, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(await h.start(alice), busy, 'in review');
      assert.deepEqual(await h.start(alice, '198.51.100.200'), busy, 'from another IP too');
      // Bob is not concerned.
      await started(h, bob, 'In Progress');
      h.clock.t += REVIEW_MAX_MS;
      await h.channel.sweep();
      assert.equal((await h.start(alice)).status, 200, 'once the review is over');
      // Approved, the grant failed: being granted.
      await close(h, alice);
      const third = await started(h, alice, 'Approved', 'Z9999999');
      h.chain.failures.push({ ok: false, reason: 'failed' });
      await h.webhook(event(third, 'Approved', alice.address));
      await h.channel.idle();
      assert.deepEqual(await h.start(alice), busy, 'being granted');
      assert.equal(h.didit.created.length, 4, "three of Alice's, one of Bob's");
    });
  });

  it('never deletes the vendor user while another session of the address is in review; the last one does', async () => {
    await withHarness({}, async (h) => {
      h.didit.deleteStatus = 500;
      const older = await started(h, alice, 'Declined');
      await h.webhook(event(older, 'Declined', alice.address));
      await h.channel.idle();
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 0);
      const review = await started(h, alice, 'Approved');
      h.didit.decisions.set(review, { session_id: review, status: 'Approved', vendor_data: alice.address, id_verification: {} });
      await h.webhook(event(review, 'Approved', alice.address));
      await h.channel.idle();
      h.didit.deleteStatus = 200;
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', `/v1/session/${older}/delete/`), 2, 'the older session is deleted');
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 0, 'but not the user: the review needs it');
      assert.equal(h.didit.count('DELETE', `/v1/session/${review}/delete/`), 0);
      h.clock.t += REVIEW_MAX_MS;
      await h.channel.sweep();
      assert.equal(h.didit.count('DELETE', `/v1/session/${review}/delete/`), 1);
      assert.equal(h.didit.count('POST', '/v3/users/delete/'), 1, 'the last session deletes the user');
      assert.deepEqual(h.ctx.store.list('kyc-session'), []);
    });
  });

  it('shows the status of the newest session of the address', async () => {
    await withHarness({}, async (h) => {
      await started(h, alice, 'Declined');
      await close(h, alice);
      assert.deepEqual((await h.status(alice)).json, { status: 'declined' });
      const second = await started(h, alice, 'Not Started');
      assert.deepEqual((await h.status(alice)).json, { status: 'pending' }, 'not hidden behind the older declined one');
      h.clock.t += PENDING_MAX_MS + MINUTE;
      await h.channel.sweep();
      assert.deepEqual((await h.status(alice)).json, { status: 'none' }, 'abandoned');
      assert.equal(h.didit.count('DELETE', `/v1/session/${second}/delete/`), 1);
    });
  });
});
