// Tests of the Telegram channel (src/verifier/telegram.ts): a fake chain and a fake Bot API (a
// stubbed `fetch`), no network. The HTTP server is the real one. The bot polls the fake like it
// polls Telegram: updates stay in the queue until a later `getUpdates` acknowledges them by its offset.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import { publicCommitment, publicKeyOf, type AttestResult, type Chain, type FieldKey, type FieldOnChain, type Method } from '../src/verifier/chain.ts';
import { channelRegistry } from '../src/verifier/channels.ts';
import { parseConfig } from '../src/verifier/config.ts';
import type { Ctx } from '../src/verifier/ctx.ts';
import { HttpServer } from '../src/verifier/http.ts';
import { verifierLogger } from '../src/verifier/log.ts';
import { main } from '../src/verifier/main.ts';
import { PacketMemory, privateCommitment, registerPacketRoute } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';
import { CODE_TTL_MS, MAX_ATTEMPTS, MAX_WRONG_PER_HOUR, START_TTL_MS, telegramChannel } from '../src/verifier/telegram.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const TOKEN = '123456:AAH-bot_SECRET-token';
const BOT = 'identitee_bot';
const BASE = 'https://api.telegram.test';
const SALT = new Uint8Array(32).fill(0x11);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const EXPIRED = 'This link expired. Start again from identit.ee.';
const VERIFIED = 'Verified. You can go back to identit.ee.';
const NO_USERNAME = 'Set a Telegram username first, then try again.';
const CODE_EXPIRED = 'This code has expired. Ask for a new one.';
const STALE = 'Your Telegram changed. Verify it again.';

let alice: KeyringPair;
let mallory: KeyringPair;
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  mallory = keyring.addFromUri('//Mallory');
});

// --- A fake chain --------------------------------------------------------------------------------------

class FakeChain implements Chain {
  readonly genesis = GENESIS;
  readonly fields = new Map<string, FieldOnChain>();
  readonly attests: Array<{ address: string; key: FieldKey; commitment: string; method: Method }> = [];
  failures: AttestResult[] = [];
  /** Every attestation asked for, refused or not. */
  attestCalls = 0;
  delayMs = 0;
  /** Called when an attestation starts. */
  onAttest: (() => void) | undefined;

  private slot = (address: string, key: FieldKey): string => `${u8aToHex(publicKeyOf(address))}/${key.Typed}`;

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  setPublic(address: string, value: string): void {
    this.fields.set(this.slot(address, { Typed: 'Telegram' }), { value, private: false, commitment: publicCommitment(stringToU8a(value)) });
  }

  setPrivate(address: string, value: string, salt = SALT): string {
    const commitment = privateCommitment(salt, stringToU8a(value));
    this.fields.set(this.slot(address, { Typed: 'Telegram' }), { value: null, private: true, commitment });
    return commitment;
  }

  /** A chain that answers a public field with this commitment and this value, whatever they are to each other. */
  lie(address: string, value: string, commitment: string): void {
    this.fields.set(this.slot(address, { Typed: 'Telegram' }), { value, private: false, commitment });
  }

  clear(address: string): void {
    this.fields.delete(this.slot(address, { Typed: 'Telegram' }));
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    return this.fields.get(this.slot(address, key)) ?? null;
  }

  async attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
    this.attestCalls++;
    this.onAttest?.();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
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

/** A packet as the web builds it for a private Telegram, signed as a wallet does. */
function makePacket(pair: KeyringPair, value: string, overrides: { salt?: Uint8Array } = {}) {
  const salt = overrides.salt ?? SALT;
  const content = {
    type: 'identitee-verification-packet',
    version: 1,
    chain: GENESIS,
    address: pair.address,
    field: { typed: 'Telegram' },
    value,
    salt: u8aToHex(salt),
    commitment: privateCommitment(salt, stringToU8a(value)),
  };
  return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
}

// --- A fake Bot API ------------------------------------------------------------------------------------

type Json = any;
type Failure = number | 'network' | 'garbage' | { status: number; retryAfter: number };

interface Call {
  url: string;
  method: string;
  body: Json;
  signal: AbortSignal | null | undefined;
}

const reply = (status: number, json: unknown): Response => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

class FakeTelegram {
  readonly calls: Call[] = [];
  /** The `offset` of each getUpdates. */
  readonly offsets: number[] = [];
  /** Failures to answer, in order, instead of working, per method. */
  readonly failures = new Map<string, Failure[]>();
  username = BOT;
  /** The highest offset a getUpdates sent: everything below it is acknowledged. */
  acked = 0;
  maxPushed = -1;
  /** Long-poll until an update comes or the request is aborted, instead of answering `[]` after a moment. */
  hold = false;
  aborted = 0;
  /** getUpdates calls being held open. */
  waiting = 0;
  private queue: Json[] = [];
  private nextUpdate = 1000;
  private nextMessage = 500;
  private wake: (() => void) | undefined;

  push(update: Record<string, unknown>): number {
    const id = this.nextUpdate++;
    this.queue.push({ update_id: id, ...update });
    this.maxPushed = Math.max(this.maxPushed, id);
    this.wake?.();
    return id;
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The texts sent or edited, in order. */
  texts(): string[] {
    return this.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.body.text));
  }

  private wait(signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.wake = undefined;
        this.waiting--;
        resolve();
      };
      const onAbort = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        this.waiting--;
        this.aborted++;
        reject(new DOMException('This operation was aborted', 'AbortError'));
      };
      this.waiting++;
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.hold) timer = setTimeout(done, 10);
      this.wake = done;
    });
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const found = /^(.*)\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    assert.ok(found, `unexpected URL ${url}`);
    assert.equal(found[1], BASE);
    assert.equal(found[2], TOKEN);
    const method = found[3]!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Json;
    const call: Call = { url, method, body, signal: init?.signal };
    this.calls.push(call);
    if (method === 'getUpdates') {
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      this.offsets.push(offset);
      this.acked = Math.max(this.acked, offset);
      this.queue = this.queue.filter((u) => u.update_id >= offset);
    }
    const failure = this.failures.get(method)?.shift();
    if (failure === 'network') throw new Error(`connect ECONNREFUSED ${url}`);
    if (failure === 'garbage') return reply(200, { ok: true, result: 'not a list' });
    if (failure !== undefined) {
      const status = typeof failure === 'number' ? failure : failure.status;
      const parameters = typeof failure === 'number' ? undefined : { retry_after: failure.retryAfter };
      return reply(status, { ok: false, error_code: status, description: `Boom ${url}`, ...(parameters ? { parameters } : {}) });
    }
    switch (method) {
      case 'getMe':
        return reply(200, { ok: true, result: { id: 42, is_bot: true, username: this.username } });
      case 'getUpdates':
        if (this.queue.length === 0) await this.wait(init?.signal);
        return reply(200, { ok: true, result: this.queue.slice(0, 100) });
      case 'sendMessage': {
        const message_id = this.nextMessage++;
        call.body = { ...body, message_id };
        return reply(200, { ok: true, result: { message_id, chat: { id: body.chat_id, type: 'private' }, date: 1, text: body.text } });
      }
      default:
        return reply(200, { ok: true, result: true });
    }
  }) as typeof fetch;
}

// --- Telegram's side of a conversation -------------------------------------------------------------------

interface TgUser {
  id: number;
  username?: string;
  is_bot?: boolean;
}
const ALICE: TgUser = { id: 424242001, username: 'alice_tg' };
const MALLORY: TgUser = { id: 424242002, username: 'mallory_tg' };
const VICTIM: TgUser = { id: 424242003, username: 'victim' };

const privateChat = (u: TgUser): Json => ({ id: u.id, type: 'private' });
const fromOf = (u: TgUser): Json => ({ is_bot: false, first_name: 'Someone', ...u });
let messageNumber = 1;

const textUpdate = (u: TgUser, text: string, chat: Json = privateChat(u)): Record<string, unknown> => ({
  message: { message_id: messageNumber++, from: fromOf(u), chat, date: 1, text },
});

/** What the bot answers to Start with a good link: one code, and nothing about who is being verified. */
const CODE_MESSAGE = /^Your identitee code is (\d{6})\. Type it on identit\.ee where you started\. If you did not start this, ignore this message and never share the code\.$/;

// --- The harness ---------------------------------------------------------------------------------------

type Answer = { status: number; json: Record<string, unknown> };

interface Options {
  env?: Record<string, string>;
  /** The least a poll without anything usable takes (the default 0 keeps the tests quick). */
  minPollMs?: number;
}

interface Harness {
  clock: { t: number };
  chain: FakeChain;
  ctx: Ctx;
  tg: FakeTelegram;
  lines: string[];
  sleeps: number[];
  stateDir: string;
  readonly enabled: string[];
  restart(): Promise<void>;
  stop(): Promise<void>;
  post(path: string, body?: unknown, ip?: string): Promise<Answer>;
  get(path: string): Promise<Answer>;
  /** POST /api/telegram/start: the link, its token and the session of the browser that asked. */
  start(who: KeyringPair, extra?: Record<string, unknown>, ip?: string): Promise<{ token: string; url: string; session: string }>;
  /** POST /api/telegram/check; `session` is the one of the account's last start by default. Resolved once the bot has said what it says. */
  check(who: KeyringPair, code: string, session?: string): Promise<Answer>;
  /** Wait until the bot has taken and handled everything pushed so far. */
  settle(): Promise<void>;
  /** The user sends a message; resolved once the bot handled it. */
  send(user: TgUser, text: string, chat?: Json): Promise<void>;
  /** The user opens the link: the code the bot answered. */
  open(user: TgUser, token: string): Promise<string>;
}

async function until(condition: () => boolean, what = 'condition', ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function withHarness(options: Options, run: (h: Harness) => Promise<void>): Promise<void> {
  const clock = { t: 1_800_000_000_000 };
  const chain = new FakeChain();
  const stateDir = mkdtempSync(join(tmpdir(), 'verifier-telegram-'));
  const cfg = parseConfig({
    IDENTITEE_VERIFIER_SURI: '//Alice',
    VERIFIER_DEV: '1',
    STATE_DIRECTORY: stateDir,
    ...(options.env ?? { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: BOT }),
  });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const tg = new FakeTelegram();
  const sleeps: number[] = [];
  /** The pause between two retries is recorded and (almost) skipped. */
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    await new Promise((r) => setTimeout(r, 1));
  };

  let server: HttpServer | undefined;
  let registry: ReturnType<typeof channelRegistry> | undefined;
  let bot: ReturnType<typeof telegramChannel> | undefined;
  let port = 0;
  let enabled: string[] = [];
  const begin = async (): Promise<void> => {
    server = new HttpServer({ dev: false, log });
    registerPacketRoute(server, ctx);
    bot = telegramChannel({ fetch: tg.fetch, apiBase: BASE, sleep, minPollMs: options.minPollMs ?? 0 });
    registry = channelRegistry([bot], ctx, server);
    await registry.start();
    enabled = registry.enabled;
    port = await server.listen(0, '127.0.0.1');
  };
  const stop = async (): Promise<void> => {
    await registry?.stop();
    await server?.close();
    registry = undefined;
    server = undefined;
  };
  await begin();

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, ip = '198.51.100.1'): Promise<Answer> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const settle = async (): Promise<void> => {
    await until(() => tg.acked > tg.maxPushed, 'the bot to take the updates');
    await bot!.idle();
  };
  /** The session of the last start each account made. */
  const lastSession = new Map<string, string>();
  const h: Harness = {
    clock,
    chain,
    ctx,
    tg,
    lines,
    sleeps,
    stateDir,
    get enabled() {
      return enabled;
    },
    restart: async () => {
      await stop();
      await begin();
    },
    stop,
    post: (path, body, ip) => call('POST', path, body, ip),
    get: (path) => call('GET', path),
    start: async (who, extra = {}, ip) => {
      const r = await call('POST', '/api/telegram/start', { address: who.address, ...extra }, ip);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const url = String(r.json.url);
      const token = new URL(url).searchParams.get('start');
      assert.ok(token, url);
      const session = String(r.json.session);
      lastSession.set(who.address, session);
      return { token, url, session };
    },
    check: async (who, code, session) => {
      const r = await call('POST', '/api/telegram/check', { address: who.address, session: session ?? lastSession.get(who.address), code });
      await bot!.idle();
      return r;
    },
    settle,
    send: async (user, text, chat) => {
      tg.push(textUpdate(user, text, chat));
      await settle();
    },
    open: async (user, token) => {
      const before = tg.of('sendMessage').length;
      await h.send(user, `/start ${token}`);
      const sent = tg.of('sendMessage');
      assert.equal(sent.length, before + 1, `no code: ${tg.texts().join(' | ')}`);
      const found = CODE_MESSAGE.exec(String(sent[before]!.body.text));
      assert.ok(found, `not a code message: ${String(sent[before]!.body.text)}`);
      assert.equal(sent[before]!.body.chat_id, user.id);
      return found[1]!;
    },
  };
  try {
    await run(h);
  } finally {
    await stop();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Alice's account with a public Telegram `@Alice_TG` (as people type it: a capital and an `@`). */
const withAlice = (run: (h: Harness) => Promise<void>) =>
  withHarness({}, async (h) => {
    h.chain.setPublic(alice.address, '@Alice_TG');
    await run(h);
  });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url');
/** A 6-digit code that is not `code`. */
const otherThan = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

interface Row {
  kind: string;
  id: string;
  data: string;
  expires: number;
}
/** The rows of one kind in the store (the bot's offset is another kind). */
const rowsOf = (h: Harness, kind: string): Row[] => (h.ctx.store.dump().items as Row[]).filter((r) => r.kind === kind);

// --- The channel ---------------------------------------------------------------------------------------

describe('telegram channel: availability', () => {
  it('is enabled with the token and the bot name, tells the front which bot, and polls', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(h.enabled, ['telegram']);
      assert.deepEqual((await h.get('/api/channels')).json, { channels: ['telegram'], telegramBot: BOT });
      await until(() => h.tg.of('getUpdates').length > 0, 'a poll');
    });
  });

  it('accepts a bot name written with its @', async () => {
    await withHarness({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: `@${BOT}` } }, async (h) => {
      assert.deepEqual((await h.get('/api/channels')).json, { channels: ['telegram'], telegramBot: BOT });
      h.chain.setPublic(alice.address, '@alice_tg');
      assert.match((await h.start(alice)).url, new RegExp(`^https://t\\.me/${BOT}\\?start=`));
    });
  });

  it('is disabled without both variables: 503 on both endpoints, no key made, and no call to Telegram', async () => {
    const incomplete: Array<Record<string, string>> = [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_BOT_USERNAME: BOT }];
    for (const env of incomplete) {
      await withHarness({ env }, async (h) => {
        assert.deepEqual(h.enabled, []);
        for (const path of ['/api/telegram/start', '/api/telegram/check']) {
          const r = await h.post(path, { address: alice.address });
          assert.equal(r.status, 503);
          assert.deepEqual(r.json, { error: 'This verification is not available yet.' });
        }
        assert.deepEqual((await h.get('/api/channels')).json, { channels: [] });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(h.tg.calls.length, 0);
        assert.throws(() => statSync(join(h.stateDir, 'telegram.key')));
      });
    }
  });

  it('makes its key at startup, readable by its owner only, outside the database', async () => {
    await withHarness({}, async (h) => {
      const file = join(h.stateDir, 'telegram.key');
      const key = readFileSync(file, 'utf8').trim();
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(h.ctx.store.dump()).includes(key));
    });
  });
});

describe('telegram channel: the start on the site', () => {
  it('gives a t.me link with a short URL-safe token and a session; both are kept hashed, with the commitment and never the value', async () => {
    await withAlice(async (h) => {
      const { token, url, session } = await h.start(alice);
      assert.equal(url, `https://t.me/${BOT}?start=${token}`);
      for (const secret of [token, session]) {
        assert.match(secret, /^[A-Za-z0-9_-]+$/);
        assert.ok(secret.length >= 22 && secret.length <= 64, secret);
      }
      assert.notEqual(token, session);
      const rows = rowsOf(h, 'telegram-start');
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.id, sha256(token));
      assert.equal(row.expires, h.clock.t + START_TTL_MS);
      assert.deepEqual(JSON.parse(row.data), { address: alice.address, field: 'Telegram', commitment: publicCommitment(stringToU8a('@Alice_TG')), session: sha256(session) });
      const everything = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
      assert.ok(!everything.includes(token) && !everything.includes(session));
      // two starts, two tokens, two sessions
      const again = await h.start(alice);
      assert.notEqual(again.token, token);
      assert.notEqual(again.session, session);
    });
  });

  it('answers the request in the one shape the front reads: url and session', async () => {
    await withAlice(async (h) => {
      const r = await h.post('/api/telegram/start', { address: alice.address });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['session', 'url']);
    });
  });

  it('refuses a bad address, an account without a Telegram, a blank value, and starts nothing', async () => {
    await withHarness({}, async (h) => {
      assert.equal((await h.post('/api/telegram/start', { address: 'nope' })).status, 400);
      assert.equal((await h.post('/api/telegram/start', {})).status, 400);
      assert.equal((await h.post('/api/telegram/start')).status, 400);
      const none = await h.post('/api/telegram/start', { address: alice.address });
      assert.equal(none.status, 400);
      assert.deepEqual(none.json, { error: 'Add your Telegram to your identity first.' });
      h.chain.setPublic(alice.address, '  ');
      const blank = await h.post('/api/telegram/start', { address: alice.address });
      assert.equal(blank.status, 400);
      assert.deepEqual(blank.json, { error: 'Add your Telegram to your identity first.' });
      assert.equal(rowsOf(h, 'telegram-start').length, 0);
    });
  });

  it('limits the starts per IP and hour with the shared bucket', async () => {
    await withAlice(async (h) => {
      for (let i = 0; i < 30; i++) assert.equal((await h.post('/api/telegram/start', { address: alice.address }, '203.0.113.9')).status, 200);
      const r = await h.post('/api/telegram/start', { address: alice.address }, '203.0.113.9');
      assert.equal(r.status, 429);
      assert.deepEqual(r.json, { error: 'Too many attempts. Try again later.' });
      assert.equal((await h.post('/api/telegram/start', { address: alice.address }, '203.0.113.10')).status, 200);
      h.clock.t += HOUR + 1;
      assert.equal((await h.post('/api/telegram/start', { address: alice.address }, '203.0.113.9')).status, 200);
    });
  });

  it('needs the packet of a private Telegram, takes it inline or by id, and keeps no value', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, '@secret_alice');
      const missing = await h.post('/api/telegram/start', { address: alice.address });
      assert.equal(missing.status, 400);
      assert.deepEqual(missing.json, { error: 'Unlock your identity to verify a private Telegram.' });
      assert.equal(rowsOf(h, 'telegram-start').length, 0);

      const packet = makePacket(alice, '@secret_alice');
      const inline = await h.start(alice, { packet });
      const saved = await h.post('/api/packet', { address: alice.address, packet });
      assert.equal(saved.status, 200);
      const byId = await h.start(alice, { packet: saved.json.id });
      assert.notEqual(inline.token, byId.token);

      const rows = rowsOf(h, 'telegram-start');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        assert.equal(data.commitment, commitment);
        assert.match(String(data.packet), /^[A-Za-z0-9_-]{24}$/);
      }
      const everything = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
      assert.ok(!everything.includes('secret_alice'));
      assert.ok(!everything.includes(packet.salt) && !everything.includes(packet.signature));
    });
  });

  it('refuses a packet signed by another account, for another value, or unknown, as a sentence', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, '@secret_alice');
      const other = await h.post('/api/telegram/start', { address: alice.address, packet: makePacket(mallory, '@secret_alice') });
      assert.equal(other.status, 400);
      assert.match(String(other.json.error), /another account/);
      const wrong = await h.post('/api/telegram/start', { address: alice.address, packet: makePacket(alice, '@someone_else') });
      assert.equal(wrong.status, 400);
      assert.ok(!JSON.stringify(wrong.json).includes('someone_else'));
      assert.equal((await h.post('/api/telegram/start', { address: alice.address, packet: 'AAAAAAAAAAAAAAAAAAAAAAAA' })).status, 400);
      assert.equal(rowsOf(h, 'telegram-start').length, 0);
    });
  });
});

describe('telegram channel: Start gives a code, not a verification', () => {
  it('answers one code and nothing about who it is for; nothing is attested, and no code, name or session is kept in clear', async () => {
    await withAlice(async (h) => {
      const { token, session } = await h.start(alice);
      const code = await h.open(ALICE, token);
      const sent = h.tg.of('sendMessage')[0]!.body;
      assert.equal(sent.reply_markup, undefined, 'no buttons');
      assert.ok(!String(sent.text).includes(alice.address.slice(0, 8)), 'no identity named');
      assert.equal(h.chain.attestCalls, 0, 'a tap on Start must not attest');
      // the link is spent, the code is pending under a keyed row
      assert.equal(rowsOf(h, 'telegram-start').length, 0);
      const pending = rowsOf(h, 'telegram-code');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.expires, h.clock.t + CODE_TTL_MS);
      const data = JSON.parse(pending[0]!.data) as Record<string, unknown>;
      assert.deepEqual(Object.keys(data).sort(), ['commitment', 'expires', 'handle', 'hash', 'user']);
      assert.equal(data.user, ALICE.id);
      assert.equal(data.commitment, publicCommitment(stringToU8a('@Alice_TG')));
      const everything = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
      for (const secret of [code, 'alice_tg', 'Alice_TG', session, token]) assert.ok(!everything.includes(secret), `${secret} in the state or the log`);
      // not a hash anybody could compute from what is public, nor a row id that gives the session away
      const key = readFileSync(join(h.stateDir, 'telegram.key'), 'utf8').trim();
      assert.ok(!everything.includes(key));
      const sessionHash = sha256(session);
      for (const plain of [code, `${alice.address}:${session}:${code}`, `${alice.address}:${sessionHash}:${code}`, `${session}:${code}`, 'alice_tg', '@alice_tg']) {
        for (const digest of [createHash('sha256').update(plain).digest('hex'), createHash('sha256').update(plain).digest('base64url')]) {
          assert.ok(!everything.includes(digest), plain);
        }
      }
      assert.ok(!pending[0]!.id.includes(session) && pending[0]!.id !== sessionHash);
    });
  });

  it('a link forwarded to someone else gives them a code that is of no use to them: it belongs to the browser that started', async () => {
    await withHarness({}, async (h) => {
      // Mallory writes the victim's username in her own Telegram field and sends them her link.
      h.chain.setPublic(mallory.address, '@victim');
      const mine = await h.start(mallory); // her browser, her session
      const code = await h.open(VICTIM, mine.token); // the victim taps Start: a code, and nothing attested
      assert.equal(h.chain.attestCalls, 0);
      // the victim has nowhere to type it: under another session, of another start of hers or made up, it finds nothing
      const other = await h.start(mallory);
      for (const session of [other.session, 'AAAAAAAAAAAAAAAAAAAAAA']) {
        const r = await h.check(mallory, code, session);
        assert.equal(r.status, 400);
        assert.deepEqual(r.json, { error: CODE_EXPIRED });
      }
      // nor for another account's session
      h.chain.setPublic(alice.address, '@Alice_TG');
      const hers = await h.start(alice);
      assert.deepEqual((await h.check(alice, code, mine.session)).json, { error: CODE_EXPIRED });
      assert.deepEqual((await h.check(mallory, code, hers.session)).json, { error: CODE_EXPIRED });
      assert.equal(h.chain.attestCalls, 0);
      // guessing under her own session does not work either
      assert.deepEqual((await h.check(mallory, otherThan(code), mine.session)).json, { error: 'That code is not right.' });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('the link is single-use: a second Start with it leads nowhere', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.open(ALICE, token);
      await h.send(ALICE, `/start ${token}`);
      assert.equal(h.tg.texts().at(-1), EXPIRED);
      assert.equal(h.tg.of('sendMessage').length, 2);
    });
  });

  it('compares the username without case and without the @', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, ' @ALICE_tg ');
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('another account: says which one the identity has, gives no code, and the link stays good for its owner', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.send(MALLORY, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), ["This identity's Telegram is @Alice_TG, but you are @mallory_tg."]);
      assert.equal(rowsOf(h, 'telegram-code').length, 0);
      const code = await h.open(ALICE, token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('shows the value of the chain in the refusal as one short plain line, without control or direction characters', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, `@Eve\u202E evil\u0007${'x'.repeat(120)}`);
      const { token } = await h.start(alice);
      await h.send(MALLORY, `/start ${token}`);
      const text = h.tg.texts()[0]!;
      assert.ok(!/[\u202E\u0007]/.test(text));
      assert.ok(text.includes('@Eve evilxxx'));
      assert.ok(!text.includes('x'.repeat(90)));
      assert.ok(text.endsWith(', but you are @mallory_tg.'));
    });
  });

  it('a private value is never named in the refusal', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, '@secret_alice');
      const { token } = await h.start(alice, { packet: makePacket(alice, '@secret_alice') });
      await h.send(MALLORY, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), ["This identity's Telegram is something else, but you are @mallory_tg."]);
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('a Telegram account without a username is told to set one, and can retry with the same link', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.send({ id: ALICE.id }, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), [NO_USERNAME]);
      const code = await h.open(ALICE, token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('a field changed between the site and Start is refused as stale, and gives no code', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.chain.setPublic(alice.address, '@alice_tg'); // same account, other bytes: another commitment
      await h.send(ALICE, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), [STALE]);
      assert.equal(rowsOf(h, 'telegram-code').length, 0);
    });
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.chain.clear(alice.address);
      await h.send(ALICE, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), ['Your Telegram is no longer on your identity.']);
    });
  });

  it('the start link expires after 10 minutes', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.clock.t += START_TTL_MS + 1;
      await h.send(ALICE, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), [EXPIRED]);
    });
  });
});

describe('telegram channel: typing the code on the site', () => {
  it('attests BotChallenge with the commitment of the start, tells the person in Telegram, and spends the code', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      const r = await h.check(alice, code);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { verified: true });
      assert.deepEqual(h.chain.attests, [{ address: alice.address, key: { Typed: 'Telegram' }, commitment: publicCommitment(stringToU8a('@Alice_TG')), method: 'BotChallenge' }]);
      const last = h.tg.of('sendMessage').at(-1)!.body;
      assert.deepEqual([last.chat_id, last.text], [ALICE.id, VERIFIED]);
      assert.equal(rowsOf(h, 'telegram-code').length, 0);
      // the same code again finds nothing, and nothing is attested twice
      assert.deepEqual((await h.check(alice, code)).json, { error: CODE_EXPIRED });
      assert.equal(h.chain.attests.length, 1);
      // nothing secret in the log
      assert.ok(!h.lines.join('').includes(code));
    });
  });

  it('a code typed under another session, for another account, or with the wrong shape, finds nothing and burns nothing', async () => {
    await withAlice(async (h) => {
      const first = await h.start(alice);
      const code = await h.open(ALICE, first.token);
      const second = await h.start(alice); // another browser, not opened in Telegram yet
      assert.deepEqual((await h.check(alice, code, second.session)).json, { error: CODE_EXPIRED });
      assert.deepEqual((await h.check(mallory, code, first.session)).json, { error: CODE_EXPIRED });
      for (const bad of [undefined, 42, '', 'short', 'A'.repeat(23), 'not a session']) {
        const r = await h.post('/api/telegram/check', { address: alice.address, session: bad, code });
        assert.equal(r.status, 400);
        assert.deepEqual(r.json, { error: CODE_EXPIRED });
      }
      for (const bad of ['', '12345', '1234567', 'abcdef', '12 34']) {
        const r = await h.post('/api/telegram/check', { address: alice.address, session: first.session, code: bad });
        assert.equal(r.status, 400);
        assert.deepEqual(r.json, { error: 'Enter the 6-digit code from Telegram.' });
      }
      assert.equal((await h.post('/api/telegram/check', { address: 'nope', session: first.session, code })).status, 400);
      assert.equal((await h.post('/api/telegram/check', {})).status, 400);
      assert.equal((await h.post('/api/telegram/check')).status, 400);
      assert.equal(h.chain.attestCalls, 0);
      // the owner's browser still has its 5 tries, and spaces in a pasted code do not matter
      assert.deepEqual((await h.check(alice, `${code.slice(0, 3)} ${code.slice(3)}`, first.session)).json, { verified: true });
    });
  });

  it('a wrong code is refused; 5 tries per code, then even the right one is refused and the code is gone', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const r = await h.check(alice, otherThan(code));
        assert.equal(r.status, 400);
        assert.deepEqual(r.json, { error: 'That code is not right.' });
      }
      const sixth = await h.check(alice, code);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many wrong codes. Ask for a new one.' });
      assert.equal(rowsOf(h, 'telegram-code').length, 0);
      assert.deepEqual((await h.check(alice, code)).json, { error: CODE_EXPIRED });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('wrong codes add up per account and hour across codes: a new start does not reset them', async () => {
    await withAlice(async (h) => {
      const sessions: string[] = [];
      const codes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { token, session } = await h.start(alice);
        codes.push(await h.open(ALICE, token));
        sessions.push(session);
      }
      for (const i of [0, 1]) for (let n = 0; n < MAX_WRONG_PER_HOUR / 2; n++) assert.equal((await h.check(alice, otherThan(codes[i]!), sessions[i])).status, 400);
      const blocked = await h.check(alice, codes[2]!, sessions[2]);
      assert.equal(blocked.status, 429);
      assert.deepEqual(blocked.json, { error: 'Too many wrong codes. Try again in an hour.' });
      assert.equal(h.chain.attestCalls, 0);
      // an hour later the count is gone (and a fresh code is needed: the old ones lived 10 minutes)
      h.clock.t += HOUR + 1;
      const again = await h.start(alice);
      assert.deepEqual((await h.check(alice, await h.open(ALICE, again.token))).json, { verified: true });
    });
  });

  it('a code expires after 10 minutes', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.clock.t += CODE_TTL_MS + 1;
      const r = await h.check(alice, code);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: CODE_EXPIRED });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('a field changed between Start and the check is refused as stale, before the chain is asked', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.setPublic(alice.address, '@alice_tg'); // the same account written another way: another commitment
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('a field that now names another account is refused, and so is one removed', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.setPublic(alice.address, '@someone_else');
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.chain.attestCalls, 0);
    });
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.clear(alice.address);
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'Your Telegram is no longer on your identity.' });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('even a chain that keeps the commitment but not the handle cannot verify the account that tapped Start', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.lie(alice.address, '@someone_else', publicCommitment(stringToU8a('@Alice_TG')));
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('changed after the last read, the chain refuses it: the person is told to verify again', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.failures = [{ ok: false, reason: 'stale' }];
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.tg.of('sendMessage').length, 1, 'no Verified message');
    });
  });

  it('a chain that fails to record says so without its detail, and the code stays good', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.failures = [{ ok: false, reason: 'failed', detail: 'RPC exploded 0xsecret' }];
      const r = await h.check(alice, code);
      assert.equal(r.status, 502);
      assert.deepEqual(r.json, { error: 'The verification could not be recorded. Try again in a moment.' });
      assert.ok(!JSON.stringify(r.json).includes('0xsecret') && !h.lines.join('').includes('0xsecret'));
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('two checks at once with the right code attest once', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.chain.delayMs = 30;
      const answers = await Promise.all([h.check(alice, code), h.check(alice, code)]);
      assert.deepEqual(answers.map((a) => a.status).sort(), [200, 400]);
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('a failing Verified message does not undo the verification', async () => {
    await withAlice(async (h) => {
      const code = await h.open(ALICE, (await h.start(alice)).token);
      h.tg.failures.set('sendMessage', [500]);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.ok(/"method":"sendMessage"[^}]*"status":500/.test(h.lines.join('')));
    });
  });
});

describe('telegram channel: a private Telegram', () => {
  it('works end to end on the value of the packet, with no value or username in the state, the logs or the replies to others', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, '@secret_alice');
      const { token } = await h.start(alice, { packet: makePacket(alice, '@secret_alice') });
      const code = await h.open({ id: ALICE.id, username: 'Secret_Alice' }, token);
      const state = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
      assert.ok(!state.toLowerCase().includes('secret_alice'));
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.deepEqual(h.chain.attests.map((a) => [a.commitment, a.method]), [[commitment, 'BotChallenge']]);
      const after = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
      assert.ok(!after.toLowerCase().includes('secret_alice'));
    });
  });

  it('the value stays good for the whole code: Start 9 minutes in, the check 9 minutes later', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, '@secret_alice');
      const { token } = await h.start(alice, { packet: makePacket(alice, '@secret_alice') });
      h.clock.t += 9 * MINUTE;
      const code = await h.open({ id: ALICE.id, username: 'secret_alice' }, token);
      h.clock.t += 9 * MINUTE;
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.deepEqual(h.chain.attests.map((a) => a.commitment), [commitment]);
    });
  });

  it('a packet saved a while before the start does not run out before the link does', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, '@secret_alice');
      const saved = await h.post('/api/packet', { address: alice.address, packet: makePacket(alice, '@secret_alice') });
      h.clock.t += 8 * MINUTE; // the saved packet has 2 minutes left
      const { token } = await h.start(alice, { packet: saved.json.id });
      h.clock.t += 9 * MINUTE; // the link has 1 minute left, the saved packet is gone
      const code = await h.open({ id: ALICE.id, username: 'secret_alice' }, token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.deepEqual(h.chain.attests.map((a) => a.commitment), [commitment]);
    });
  });

  it('a field changed meanwhile is refused as stale, at Start and at the check', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, '@secret_alice');
      const { token } = await h.start(alice, { packet: makePacket(alice, '@secret_alice') });
      h.chain.setPrivate(alice.address, '@secret_alice', new Uint8Array(32).fill(0x22));
      await h.send({ id: ALICE.id, username: 'secret_alice' }, `/start ${token}`);
      assert.deepEqual(h.tg.texts(), [STALE]);
    });
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, '@secret_alice');
      const { token } = await h.start(alice, { packet: makePacket(alice, '@secret_alice') });
      const code = await h.open({ id: ALICE.id, username: 'secret_alice' }, token);
      h.chain.setPrivate(alice.address, '@secret_alice', new Uint8Array(32).fill(0x22));
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.chain.attestCalls, 0);
    });
  });
});

describe('telegram channel: what the bot answers', () => {
  it('an unknown, expired, reused or malformed token is an expired link', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.send(ALICE, '/start AAAAAAAAAAAAAAAAAAAAAA');
      await h.send(ALICE, '/start not%a%token');
      await h.send(ALICE, `/start ${'A'.repeat(500)}`);
      assert.deepEqual(h.tg.texts(), [EXPIRED, EXPIRED, EXPIRED]);
      // the real one still works, once
      await h.open(ALICE, token);
      await h.send(ALICE, `/start ${token}`);
      assert.equal(h.tg.texts().at(-1), EXPIRED);
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('the same link opened twice at once gives one code', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.tg.push(textUpdate(ALICE, `/start ${token}`));
      h.tg.push(textUpdate(ALICE, `/start ${token}`));
      await h.settle();
      assert.equal(h.tg.of('sendMessage').filter((c) => CODE_MESSAGE.test(String(c.body.text))).length, 1);
      assert.equal(rowsOf(h, 'telegram-code').length, 1);
    });
  });

  it('also reads /start@bot, and explains itself to a /start without a link and to /help', async () => {
    await withAlice(async (h) => {
      await h.open(ALICE, (await h.start(alice)).token); // plain form first
      const { token } = await h.start(alice);
      await h.send(ALICE, `/start@${BOT} ${token}`);
      assert.equal(h.tg.of('sendMessage').filter((c) => CODE_MESSAGE.test(String(c.body.text))).length, 2);
      const before = h.tg.of('sendMessage').length;
      await h.send(ALICE, '/start');
      await h.send(ALICE, '/help');
      const help = h.tg.of('sendMessage').slice(before).map((c) => String(c.body.text));
      assert.equal(help.length, 2);
      for (const text of help) assert.equal(text, 'To verify your Telegram, start from your profile on identit.ee and choose Verify next to Telegram.');
      // any other text, and a command for another bot, gets no reply
      await h.send(ALICE, 'hello there');
      await h.send(ALICE, 'start');
      await h.send(ALICE, `/start@another_bot ${token}`);
      assert.equal(h.tg.of('sendMessage').length, before + 2);
    });
  });

  it('answers private chats only: a group, a supergroup, a channel or a bot get nothing and spend nothing', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      for (const type of ['group', 'supergroup', 'channel']) {
        await h.send(ALICE, `/start ${token}`, { id: -1001, type });
        await h.send(ALICE, `/start ${token}`, { id: ALICE.id, type }); // whatever its id says, the chat is not private
      }
      await h.send({ ...ALICE, is_bot: true }, `/start ${token}`);
      h.tg.push({ message: { message_id: 1, chat: privateChat(ALICE), date: 1, text: `/start ${token}` } }); // no sender
      await h.settle();
      assert.equal(h.tg.of('sendMessage').length, 0);
      const code = await h.open(ALICE, token); // the link was not spent
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('limits the starts per Telegram user and hour, says so once, then goes quiet', async () => {
    await withAlice(async (h) => {
      for (let i = 0; i < 10; i++) await h.send(ALICE, `/start ${'B'.repeat(22)}`);
      assert.equal(h.tg.of('sendMessage').length, 10);
      await h.send(ALICE, `/start ${'B'.repeat(22)}`);
      assert.equal(h.tg.texts().at(-1), 'Too many attempts. Try again later.');
      await h.send(ALICE, `/start ${'B'.repeat(22)}`);
      await h.send(ALICE, `/start ${'B'.repeat(22)}`);
      assert.equal(h.tg.of('sendMessage').length, 11);
      // another user is not affected, and the hour passes
      await h.send(MALLORY, `/start ${'B'.repeat(22)}`);
      assert.equal(h.tg.of('sendMessage').length, 12);
      h.clock.t += HOUR + 1;
      await h.send(ALICE, `/start ${'B'.repeat(22)}`);
      assert.equal(h.tg.texts().at(-1), EXPIRED);
    });
  });
});

describe('telegram channel: polling', () => {
  it('asks for updates with a 30 s timeout and only messages', async () => {
    await withAlice(async (h) => {
      await until(() => h.tg.of('getUpdates').length > 0, 'a poll');
      const body = h.tg.of('getUpdates')[0]!.body;
      assert.equal(body.timeout, 30);
      assert.deepEqual(body.allowed_updates, ['message']);
    });
  });

  it('advances the offset past what it took, keeps it in the store, and resumes from it after a restart', async () => {
    await withAlice(async (h) => {
      const a = h.tg.push(textUpdate(ALICE, '/start'));
      const b = h.tg.push(textUpdate(ALICE, 'hi'));
      await h.settle();
      assert.equal(h.tg.offsets.at(-1), b + 1);
      assert.ok(h.tg.offsets.includes(0), 'the first poll had no offset');
      // the update was taken once, not once per poll
      assert.equal(h.tg.of('sendMessage').length, 1);
      assert.deepEqual(h.ctx.store.get('telegram', 'offset'), { offset: b + 1 });
      assert.ok(a < b);
      await h.stop();
      const polls = h.tg.of('getUpdates').length;
      await h.restart();
      await until(() => h.tg.of('getUpdates').length > polls, 'a poll after the restart');
      assert.equal(h.tg.of('getUpdates')[polls]!.body.offset, b + 1, 'the first poll resumes from the stored offset');
      assert.equal(h.tg.of('sendMessage').length, 1, 'nothing taken twice');
    });
  });

  it('backs off on API errors, doubling up to 60 s, and goes on without crashing', async () => {
    await withAlice(async (h) => {
      h.tg.failures.set('getUpdates', [500, 'network', 502, 500, 500, 500, 500, 500, 500]);
      await until(() => h.sleeps.length === 9, 'nine retries');
      assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
      h.tg.push(textUpdate(ALICE, '/start'));
      await h.settle();
      assert.equal(h.tg.of('sendMessage').length, 1, 'the update came through after the errors');
      // a success resets the pause
      h.tg.failures.set('getUpdates', [500]);
      await until(() => h.sleeps.length === 10, 'one more retry');
      assert.equal(h.sleeps[9], 1000);
    });
  });

  it('treats an answer that is not a list of updates as an error, with the same pauses', async () => {
    await withAlice(async (h) => {
      h.tg.failures.set('getUpdates', ['garbage', 'garbage', 'garbage']);
      await until(() => h.sleeps.length === 3, 'three retries');
      assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
    });
  });

  it('waits at least what Telegram asks for when it limits the calls', async () => {
    await withAlice(async (h) => {
      h.tg.failures.set('getUpdates', [{ status: 429, retryAfter: 7 }, { status: 429, retryAfter: 600 }]);
      await until(() => h.sleeps.length === 2, 'two retries');
      assert.deepEqual(h.sleeps, [7000, 60000]);
    });
  });

  it('pauses after a poll that gave nothing and came back at once, so that a misbehaving API cannot make it spin', async () => {
    await withHarness({ minPollMs: 1000 }, async (h) => {
      await until(() => h.sleeps.length >= 3, 'three floor pauses');
      for (const ms of h.sleeps) assert.ok(ms > 900 && ms <= 1000, `pause of ${ms} ms`);
      // an update that advances the offset is no reason to wait: it is answered
      h.chain.setPublic(alice.address, '@Alice_TG');
      await h.send(ALICE, '/start');
      assert.equal(h.tg.of('sendMessage').length, 1);
    });
  });

  it('removes a webhook once at start, before anything else, and goes on if that fails', async () => {
    await withAlice(async (h) => {
      await until(() => h.tg.of('getUpdates').length > 0, 'a poll');
      assert.deepEqual(h.tg.calls.slice(0, 3).map((c) => c.method), ['deleteWebhook', 'getMe', 'getUpdates']);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.tg.of('deleteWebhook').length, 1, 'once, not at every poll');
      await h.stop();
      const polls = h.tg.of('getUpdates').length;
      h.tg.failures.set('deleteWebhook', [409]);
      await h.restart();
      await until(() => h.tg.of('getUpdates').length > polls, 'a poll after the restart');
      assert.equal(h.tg.of('deleteWebhook').length, 2);
      assert.ok(/"method":"deleteWebhook"[^}]*"status":409/.test(h.lines.join('')));
    });
  });

  it('never logs the token, an address of the API, a message text or a body: methods and status codes only', async () => {
    await withAlice(async (h) => {
      h.tg.failures.set('getUpdates', [500, 'network', { status: 429, retryAfter: 1 }]);
      await until(() => h.sleeps.length === 3, 'three retries');
      h.tg.failures.set('sendMessage', [400, 'network']);
      h.tg.push(textUpdate(ALICE, '/start'));
      h.tg.push(textUpdate(ALICE, '/start'));
      await h.settle();
      const { token, session } = await h.start(alice);
      const code = await h.open(ALICE, token);
      h.tg.failures.set('sendMessage', [500]);
      await h.check(alice, code);
      const all = h.lines.join('');
      assert.ok(all.includes('getUpdates') && all.includes('sendMessage'));
      assert.ok(/"status":500/.test(all) && /"status":400/.test(all));
      for (const secret of [TOKEN, '123456:', 'AAH-bot', BASE, 'api.telegram', 'Boom', 'ECONNREFUSED', 'secret']) assert.ok(!all.includes(secret), `${secret} in the log`);
      // nor a person, a code or a session: no Telegram name, no id, no text
      for (const secret of ['alice_tg', String(ALICE.id), 'Your identitee code', code, token, session]) assert.ok(!all.includes(secret), `${secret} in the log`);
    });
  });

  it('survives an API error while answering and a malformed update', async () => {
    await withAlice(async (h) => {
      h.tg.failures.set('sendMessage', [500]);
      await h.send(ALICE, '/start');
      h.tg.push({});
      h.tg.push({ message: {} });
      h.tg.push({ message: { text: '/start abc', chat: 'x', from: 3 } });
      h.tg.push({ callback_query: { id: 'c1', data: 'ok:AAAAAAAAAAAAAAAAAAAAAA' } }); // not asked for, ignored
      h.tg.push({ message: { message_id: 1, from: fromOf(ALICE), chat: privateChat(ALICE), text: 42 } });
      await h.settle();
      const code = await h.open(ALICE, (await h.start(alice)).token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('warns when the configured bot name is not the token\'s bot', async () => {
    await withAlice(async (h) => {
      await until(() => h.tg.of('getUpdates').length > 0, 'the first poll, which follows the check');
      assert.equal(h.tg.of('getMe').length, 1);
      assert.ok(!h.lines.join('').includes('telegram-bot-name'));
    });
    await withHarness({}, async (h) => {
      h.tg.username = 'another_bot';
      await h.restart();
      await until(() => h.lines.join('').includes('telegram-bot-name'), 'the warning');
      assert.ok(!h.lines.join('').includes(TOKEN));
    });
  });

  it('stops cleanly: the pending poll is aborted and no other starts', async () => {
    await withAlice(async (h) => {
      h.tg.hold = true;
      await h.restart();
      const aborted = h.tg.aborted;
      await until(() => h.tg.waiting === 1, 'a long poll');
      const polls = h.tg.of('getUpdates').length;
      const started = Date.now();
      await h.stop();
      assert.ok(Date.now() - started < 1000, 'stop did not wait for the long poll');
      assert.equal(h.tg.aborted, aborted + 1);
      assert.equal(h.tg.waiting, 0);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.tg.of('getUpdates').length, polls, 'no poll after stop');
      assert.ok(h.tg.of('getUpdates').at(-1)!.signal?.aborted);
    });
  });

  it('stop waits for the message being sent', async () => {
    await withAlice(async (h) => {
      const { token, session } = await h.start(alice);
      const code = await h.open(ALICE, token);
      const sends = h.tg.of('sendMessage').length;
      const answer = await h.post('/api/telegram/check', { address: alice.address, session, code });
      assert.equal(answer.status, 200);
      await h.stop();
      assert.equal(h.tg.of('sendMessage').length, sends + 1);
      assert.equal(h.tg.of('sendMessage').at(-1)!.body.text, VERIFIED);
    });
  });
});

describe('telegram channel: in the service', () => {
  it('SIGTERM aborts the long poll and the service exits 0, without the token in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-telegram-main-'));
    try {
      const tg = new FakeTelegram();
      tg.hold = true;
      const lines: string[] = [];
      const api = {
        genesisHash: { toHex: () => GENESIS },
        runtimeVersion: { specName: { toString: () => 'identitee' } },
        query: { identitee: { agents: async () => ({ toJSON: () => [0, 3] }) } },
        disconnect: async () => undefined,
      } as unknown as ApiPromise;
      const done = main(
        { IDENTITEE_VERIFIER_SURI: '//Alice//verifier', STATE_DIRECTORY: dir, VERIFIER_PORT: '0', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: BOT },
        {
          connect: async () => api,
          write: (line) => void lines.push(line),
          exit: () => assert.fail('no second signal'),
          channels: [telegramChannel({ fetch: tg.fetch, apiBase: BASE })],
        },
      );
      await until(() => lines.some((l) => l.includes('"listening"')) && tg.waiting === 1, 'the service listening and a long poll held');
      assert.ok(lines.some((l) => l.includes('"telegram"')), 'the channel is listed as enabled');
      process.emit('SIGTERM');
      assert.equal(await done, 0);
      assert.equal(tg.aborted, 1);
      assert.equal(tg.waiting, 0);
      assert.ok(!lines.join('').includes(TOKEN));
      assert.ok(lines.at(-1)!.includes('"stopped"'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
