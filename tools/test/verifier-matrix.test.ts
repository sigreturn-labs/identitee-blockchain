// Tests of the Matrix channel (src/verifier/matrix.ts): a fake chain and a fake Matrix client handed to
// the channel through its `connect` option, so no network and no native crypto module. The HTTP server is
// the real one. The fake client emits `room.message` and `room.invite` as matrix-bot-sdk does after
// decrypting an event.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { matrixChannel, MatrixCryptoMissing, sdkLogger, withoutDep0060, type MatrixClientLike, type MatrixLogin } from '../src/verifier/matrix.ts';
import { nativePath, PIN_FILE, verifyNative } from '../src/verifier/native.ts';
import { PacketMemory, privateCommitment, registerPacketRoute } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const HOMESERVER = 'https://matrix.example.org';
const BOT = '@identitee:example.org';
const PASSWORD = 'hunter2-SECRET-password';
const ENV = { MATRIX_HOMESERVER: HOMESERVER, MATRIX_USER: BOT, MATRIX_PASSWORD: PASSWORD };
const SALT = new Uint8Array(32).fill(0x11);
const MINUTE = 60_000;

const EXPIRED = 'This command has expired. Start again from identit.ee.';
const VERIFIED = 'Verified. You can go back to identit.ee.';
const CODE_EXPIRED = 'This code has expired. Ask for a new one.';
const STALE = 'Your Matrix changed. Verify it again.';
const HELP = 'To verify your Matrix, start from your profile on identit.ee and choose Verify next to Matrix.';
const SENT_PRIVATELY = 'I sent you your code in a private message.';
const UNREADABLE = 'I could not read your message. Send it again, or send it in an unencrypted chat.';
const CODE_MESSAGE = /^Your identitee code is (\d{6})\. Type it on identit\.ee where you started\. If you did not start this, ignore this message and never share the code\.$/;

const ALICE = '@alice:matrix.org';
const MALLORY = '@mallory:evil.org';
const VICTIM = '@victim:matrix.org';

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
  attestCalls = 0;
  /** Reads that fail as a node that cannot be reached does. */
  readFailures = 0;

  private slot = (address: string): string => `${u8aToHex(publicKeyOf(address))}/Matrix`;

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  setPublic(address: string, value: string): void {
    this.fields.set(this.slot(address), { value, private: false, commitment: publicCommitment(stringToU8a(value)) });
  }

  setPrivate(address: string, value: string): string {
    const commitment = privateCommitment(SALT, stringToU8a(value));
    this.fields.set(this.slot(address), { value: null, private: true, commitment });
    return commitment;
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    assert.equal(key.Typed, 'Matrix');
    if (this.readFailures > 0) {
      this.readFailures--;
      throw new Error('node unreachable');
    }
    return this.fields.get(this.slot(address)) ?? null;
  }

  async attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
    this.attestCalls++;
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

function makePacket(pair: KeyringPair, value: string) {
  const content = {
    type: 'identitee-verification-packet',
    version: 1,
    chain: GENESIS,
    address: pair.address,
    field: { typed: 'Matrix' },
    value,
    salt: u8aToHex(SALT),
    commitment: privateCommitment(SALT, stringToU8a(value)),
  };
  return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
}

// --- A fake Matrix client ------------------------------------------------------------------------------

type Listener = (roomId: string, event: unknown) => void;

class FakeClient implements MatrixClientLike {
  userId = BOT;
  started = 0;
  stopped = 0;
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: Array<{ room: string; text: string }> = [];
  readonly joined: string[] = [];
  readonly left: string[] = [];
  /** The rooms the bot made, with what it asked for. */
  readonly created: Array<{ room: string; options: Record<string, unknown> }> = [];
  /** Joined or invited members per room; a room not listed is a DM of its sender and the bot. */
  readonly members = new Map<string, number>();
  readonly memberCalls: string[] = [];
  failSend = 0;
  failCreate = 0;

  on(event: 'room.message' | 'room.invite' | 'room.event' | 'room.failed_decryption', listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  async start(): Promise<void> {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  async sendNotice(room: string, text: string): Promise<string> {
    if (this.failSend > 0) {
      this.failSend--;
      throw Object.assign(new Error(`send failed in ${room}: ${text}`), { errcode: 'M_FORBIDDEN', statusCode: 403 });
    }
    this.sent.push({ room, text });
    return '$event';
  }
  async joinRoom(room: string): Promise<string> {
    this.joined.push(room);
    return room;
  }
  async leaveRoom(room: string): Promise<void> {
    this.left.push(room);
  }
  async memberCount(room: string): Promise<number> {
    this.memberCalls.push(room);
    return this.members.get(room) ?? 2;
  }
  async createRoom(options: Record<string, unknown>): Promise<string> {
    if (this.failCreate > 0) {
      this.failCreate--;
      throw Object.assign(new Error('create failed'), { errcode: 'M_LIMIT_EXCEEDED', statusCode: 429 });
    }
    const room = `!code${this.created.length}:example.org`;
    this.created.push({ room, options });
    return room;
  }
  emit(event: string, room: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(room, payload);
  }
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
  /** What was said in one room. */
  in(room: string): string[] {
    return this.sent.filter((s) => s.room === room).map((s) => s.text);
  }
}

// --- The harness ---------------------------------------------------------------------------------------

type Answer = { status: number; json: Record<string, unknown> };

interface Harness {
  clock: { t: number };
  chain: FakeChain;
  ctx: Ctx;
  client: FakeClient;
  logins: MatrixLogin[];
  lines: string[];
  sleeps: number[];
  stateDir: string;
  readonly enabled: string[];
  post(path: string, body?: unknown, ip?: string): Promise<Answer>;
  get(path: string): Promise<Answer>;
  start(who: KeyringPair, extra?: Record<string, unknown>, ip?: string): Promise<{ token: string; command: string; session: string }>;
  check(who: KeyringPair, code: string, session?: string): Promise<Answer>;
  /** A message from `sender` in `room` (its DM with the bot by default); resolved once handled. */
  say(sender: string, body: string, options?: { room?: string; msgtype?: string; ts?: number }): Promise<void>;
  /** `sender` sends the command and joins the room the bot made: the code the bot posted there. */
  open(sender: string, token: string): Promise<string>;
  /** `sender` joins `room` (a membership event the bot sees). */
  join(sender: string, room: string): Promise<void>;
  invite(sender: string, room: string, direct?: boolean): Promise<void>;
  /** An encrypted message the bot could not read. */
  undecryptable(sender: string, options?: { room?: string; ts?: number }): Promise<void>;
  stop(): Promise<void>;
}

async function until(condition: () => boolean, what = 'condition', ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const dmOf = (sender: string): string => `!dm-${sender.slice(1).replace(':', '-')}:example.org`;
let eventNumber = 1;

async function withHarness(options: { env?: Record<string, string>; failConnect?: number; connectError?: () => Error }, run: (h: Harness) => Promise<void>): Promise<void> {
  const clock = { t: 1_800_000_000_000 };
  const chain = new FakeChain();
  const stateDir = mkdtempSync(join(tmpdir(), 'verifier-matrix-'));
  const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', STATE_DIRECTORY: stateDir, ...(options.env ?? ENV) });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const client = new FakeClient();
  const logins: MatrixLogin[] = [];
  const sleeps: number[] = [];
  let failures = options.failConnect ?? 0;
  const channel = matrixChannel({
    connect: async (login) => {
      logins.push(login);
      if (options.connectError !== undefined) throw options.connectError();
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error(`login failed with ${login.password}`), { errcode: 'M_FORBIDDEN', statusCode: 403 });
      }
      return client;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 1));
    },
  });
  const server = new HttpServer({ dev: false, log });
  registerPacketRoute(server, ctx);
  const registry = channelRegistry([channel], ctx, server);
  await registry.start();
  const port = await server.listen(0, '127.0.0.1');
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await registry.stop();
    await server.close();
  };

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, ip = '198.51.100.1'): Promise<Answer> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const lastSession = new Map<string, string>();
  const h: Harness = {
    clock,
    chain,
    ctx,
    client,
    logins,
    lines,
    sleeps,
    stateDir,
    enabled: registry.enabled,
    post: (path, body, ip) => call('POST', path, body, ip),
    get: (path) => call('GET', path),
    start: async (who, extra = {}, ip) => {
      const r = await call('POST', '/api/matrix/start', { address: who.address, ...extra }, ip);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const command = String(r.json.command);
      const found = /^!identitee ([A-Za-z0-9_-]+)$/.exec(command);
      assert.ok(found, command);
      const session = String(r.json.session);
      lastSession.set(who.address, session);
      return { token: found[1]!, command, session };
    },
    check: async (who, code, session) => {
      const r = await call('POST', '/api/matrix/check', { address: who.address, session: session ?? lastSession.get(who.address), code });
      await channel.idle();
      return r;
    },
    say: async (sender, body, opts = {}) => {
      client.emit('room.message', opts.room ?? dmOf(sender), {
        type: 'm.room.message',
        sender,
        event_id: `$e${eventNumber++}`,
        origin_server_ts: opts.ts ?? clock.t,
        content: { msgtype: opts.msgtype ?? 'm.text', body },
      });
      await channel.idle();
    },
    open: async (sender, token) => {
      const before = client.sent.length;
      const made = client.created.length;
      await h.say(sender, `!identitee ${token}`);
      assert.equal(client.created.length, made + 1, `no room made: ${client.texts().join(' | ')}`);
      assert.deepEqual(client.sent.slice(before), [{ room: dmOf(sender), text: SENT_PRIVATELY }]);
      const room = client.created.at(-1)!.room;
      await h.join(sender, room);
      const posted = client.in(room);
      assert.equal(posted.length, 1, `no code: ${client.texts().join(' | ')}`);
      const found = CODE_MESSAGE.exec(posted[0]!);
      assert.ok(found, `not a code message: ${posted[0]}`);
      return found[1]!;
    },
    join: async (sender, room) => {
      client.emit('room.event', room, { type: 'm.room.member', sender, state_key: sender, origin_server_ts: clock.t, content: { membership: 'join' } });
      await channel.idle();
    },
    invite: async (sender, room, direct = true) => {
      client.emit('room.invite', room, { type: 'm.room.member', sender, state_key: BOT, content: { membership: 'invite', ...(direct ? { is_direct: true } : {}) } });
      await channel.idle();
    },
    undecryptable: async (sender, opts = {}) => {
      client.emit('room.failed_decryption', opts.room ?? dmOf(sender), {
        type: 'm.room.encrypted',
        sender,
        origin_server_ts: opts.ts ?? clock.t,
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'CIPHERTEXT-secret' },
      });
      await channel.idle();
    },
    stop,
  };
  try {
    if (registry.enabled.length > 0) await until(() => client.started > 0 || (options.failConnect ?? 0) > 0 || options.connectError !== undefined, 'the client started');
    await run(h);
  } finally {
    await stop();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Alice's account with a public Matrix written the way people type it: a capital, no `@`. */
const withAlice = (run: (h: Harness) => Promise<void>) =>
  withHarness({}, async (h) => {
    h.chain.setPublic(alice.address, 'Alice:Matrix.org');
    await run(h);
  });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url');
const otherThan = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

interface Row {
  kind: string;
  id: string;
  data: string;
  expires: number;
}
const rowsOf = (h: Harness, kind: string): Row[] => (h.ctx.store.dump().items as Row[]).filter((r) => r.kind === kind);

/** Nothing secret or naming the person in the state or the log. */
function assertClean(h: Harness, secrets: string[]): void {
  const everything = JSON.stringify(h.ctx.store.dump()) + h.lines.join('');
  for (const secret of [PASSWORD, ...secrets]) assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), `${secret} in the state or the log`);
}

// --- The channel ---------------------------------------------------------------------------------------

describe('matrix channel: availability', () => {
  it('is enabled with the three variables, tells the front the bot, logs in under the state directory and starts', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(h.enabled, ['matrix']);
      assert.deepEqual((await h.get('/api/channels')).json, { channels: ['matrix'], matrixBot: BOT });
      assert.equal(h.logins.length, 1);
      const login = h.logins[0]!;
      assert.deepEqual({ ...login, log: undefined }, { homeserver: HOMESERVER, user: BOT, password: PASSWORD, dir: join(h.stateDir, 'matrix'), log: undefined });
      assert.equal(h.client.started, 1);
      assertClean(h, []);
    });
  });

  it('is disabled without its variables or with a bot that is not a full Matrix id: 503, no login, no key', async () => {
    const incomplete: Array<Record<string, string>> = [
      {},
      { MATRIX_HOMESERVER: HOMESERVER, MATRIX_USER: BOT },
      { MATRIX_USER: BOT, MATRIX_PASSWORD: PASSWORD },
      { ...ENV, MATRIX_USER: 'identitee' },
      { ...ENV, MATRIX_HOMESERVER: 'matrix.example.org' },
    ];
    for (const env of incomplete) {
      await withHarness({ env }, async (h) => {
        assert.deepEqual(h.enabled, []);
        for (const path of ['/api/matrix/start', '/api/matrix/check']) {
          const r = await h.post(path, { address: alice.address });
          assert.equal(r.status, 503);
          assert.deepEqual(r.json, { error: 'This verification is not available yet.' });
        }
        assert.deepEqual((await h.get('/api/channels')).json, { channels: [] });
        assert.equal(h.logins.length, 0);
        assert.throws(() => statSync(join(h.stateDir, 'matrix.key')));
      });
    }
  });

  it('makes its key at startup, readable by its owner only', async () => {
    await withHarness({}, async (h) => {
      const file = join(h.stateDir, 'matrix.key');
      assert.match(readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    });
  });

  it('retries a failed login with a growing pause, never logging the password or the error message', async () => {
    await withHarness({ failConnect: 3 }, async (h) => {
      await until(() => h.client.started === 1, 'the client started after the failures');
      assert.equal(h.logins.length, 4);
      assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
      const failed = h.lines.filter((l) => l.includes('matrix-connect-failed'));
      assert.equal(failed.length, 3);
      assert.match(failed[0]!, /"errcode":"M_FORBIDDEN"/);
      assert.ok(!h.lines.join('').includes('login failed'));
      assertClean(h, []);
    });
  });

  it('stops the client and its retries at shutdown', async () => {
    await withHarness({ failConnect: 1000 }, async (h) => {
      await until(() => h.logins.length >= 2, 'a retry');
      await h.stop();
      const tries = h.logins.length;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(h.logins.length, tries);
    });
    await withHarness({}, async (h) => {
      await h.stop();
      assert.equal(h.client.stopped, 1);
    });
  });
});

describe('matrix channel: the start on the site', () => {
  it('gives the command for the bot, the bot, and a session; token and session are kept hashed, with the commitment and never the value', async () => {
    await withAlice(async (h) => {
      const r = await h.post('/api/matrix/start', { address: alice.address });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['bot', 'command', 'session']);
      assert.equal(r.json.bot, BOT);
      const token = /^!identitee ([A-Za-z0-9_-]{22})$/.exec(String(r.json.command))![1]!;
      const session = String(r.json.session);
      assert.match(session, /^[A-Za-z0-9_-]{22}$/);
      const rows = rowsOf(h, 'matrix-start');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, sha256(token));
      assert.equal(rows[0]!.expires, h.clock.t + 10 * MINUTE);
      assert.deepEqual(JSON.parse(rows[0]!.data), { address: alice.address, field: 'Matrix', commitment: publicCommitment(stringToU8a('Alice:Matrix.org')), session: sha256(session) });
      assertClean(h, [token, session]);
    });
  });

  it('refuses a bad address, an account without a Matrix, a private Matrix without its packet', async () => {
    await withHarness({}, async (h) => {
      assert.equal((await h.post('/api/matrix/start', { address: 'nope' })).status, 400);
      assert.deepEqual((await h.post('/api/matrix/start', { address: alice.address })).json, { error: 'Add your Matrix to your identity first.' });
      h.chain.setPrivate(alice.address, ALICE);
      assert.deepEqual((await h.post('/api/matrix/start', { address: alice.address })).json, { error: 'Unlock your identity to verify a private Matrix.' });
      const other = await h.post('/api/matrix/start', { address: alice.address, packet: makePacket(mallory, ALICE) });
      assert.equal(other.status, 400);
      assert.equal(rowsOf(h, 'matrix-start').length, 0);
    });
  });

  it('limits the starts per IP and hour with the shared bucket', async () => {
    await withAlice(async (h) => {
      for (let i = 0; i < 30; i++) assert.equal((await h.post('/api/matrix/start', { address: alice.address }, '203.0.113.9')).status, 200);
      const r = await h.post('/api/matrix/start', { address: alice.address }, '203.0.113.9');
      assert.equal(r.status, 429);
      assert.deepEqual(r.json, { error: 'Too many attempts. Try again later.' });
      assert.equal((await h.post('/api/matrix/start', { address: alice.address }, '203.0.113.10')).status, 200);
    });
  });
});

describe('matrix channel: the command gives a code, the code verifies', () => {
  it('posts the code only in a room of its own, attests nothing until the page sends it, then attests MatrixChallenge and says so there', async () => {
    await withAlice(async (h) => {
      const { token, session } = await h.start(alice);
      const code = await h.open(ALICE, token);
      const room = h.client.created[0]!.room;
      assert.deepEqual(h.client.in(dmOf(ALICE)), [SENT_PRIVATELY], 'the command room only hears that the code went elsewhere');
      assert.ok(!h.client.in(room)[0]!.includes(alice.address.slice(0, 8)), 'no identity named');
      assert.equal(h.chain.attestCalls, 0);
      assert.equal(rowsOf(h, 'matrix-start').length, 0);
      const pending = rowsOf(h, 'matrix-code');
      assert.equal(pending.length, 1);
      assert.deepEqual(Object.keys(JSON.parse(pending[0]!.data)).sort(), ['commitment', 'expires', 'handle', 'hash']);
      assertClean(h, [code, token, session, 'alice:matrix.org', dmOf(ALICE), room]);

      const r = await h.check(alice, code);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { verified: true });
      assert.deepEqual(h.chain.attests, [{ address: alice.address, key: { Typed: 'Matrix' }, commitment: publicCommitment(stringToU8a('Alice:Matrix.org')), method: 'MatrixChallenge' }]);
      assert.deepEqual(h.client.sent.at(-1), { room, text: VERIFIED });
      assert.deepEqual(h.client.in(dmOf(ALICE)), [SENT_PRIVATELY]);
      assert.equal(rowsOf(h, 'matrix-code').length, 0);
      // the code is spent
      assert.deepEqual((await h.check(alice, code)).json, { error: CODE_EXPIRED });
    });
  });

  it('makes the code room direct, encrypted, by invitation, history from joining, with the sender as its only guest', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.open(ALICE, token);
      assert.equal(h.client.created.length, 1);
      assert.deepEqual(h.client.created[0]!.options, {
        preset: 'trusted_private_chat',
        is_direct: true,
        invite: [ALICE],
        initial_state: [
          { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
          { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
        ],
      });
      // nothing of the command's room is in it
      assert.ok(!JSON.stringify(h.client.created[0]!.options).includes(dmOf(ALICE)));
    });
  });

  it('posts the code only once the sender joined, and only to them alone: others joining, a crowded room, a late join get nothing', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(ALICE, `!identitee ${token}`);
      const room = h.client.created[0]!.room;
      assert.deepEqual(h.client.in(room), [], 'nothing before the sender joins');
      await h.join(MALLORY, room);
      await h.join(BOT, room);
      assert.deepEqual(h.client.in(room), []);
      h.client.members.set(room, 3);
      await h.join(ALICE, room);
      assert.deepEqual(h.client.in(room), [], 'a room with a third member gets no code');
      assert.deepEqual(h.client.left, [room]);
      // the code is not posted twice, nor anywhere else
      h.client.members.delete(room);
      await h.join(ALICE, room);
      assert.equal(h.client.sent.filter((m) => CODE_MESSAGE.test(m.text)).length, 0);
    });
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(ALICE, `!identitee ${token}`);
      h.clock.t += 10 * MINUTE + 1;
      await h.join(ALICE, h.client.created[0]!.room);
      assert.equal(h.client.sent.filter((m) => CODE_MESSAGE.test(m.text)).length, 0, 'a join after the code expired gets nothing');
    });
  });

  it('when the code room cannot be made, says so and spends nothing', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.client.failCreate = 1;
      await h.say(ALICE, `!identitee ${token}`);
      assert.deepEqual(h.client.texts(), ['Something went wrong. Try again in a moment.']);
      assert.equal(rowsOf(h, 'matrix-start').length, 1);
      assert.equal(rowsOf(h, 'matrix-code').length, 0);
      await h.open(ALICE, token);
    });
  });

  it('compares the full id without case and with or without the @', async () => {
    for (const onChain of ['@ALICE:matrix.ORG', ' alice:matrix.org ', 'Alice:Matrix.org']) {
      await withHarness({}, async (h) => {
        h.chain.setPublic(alice.address, onChain);
        const { token } = await h.start(alice);
        const code = await h.open('@Alice:Matrix.org', token);
        assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      });
    }
  });

  it('another account, or the same name on another server: says which one the identity has, gives no code, the command stays good', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(MALLORY, `!identitee ${token}`);
      await h.say('@alice:evil.org', `!identitee ${token}`);
      assert.deepEqual(h.client.texts(), [
        "This identity's Matrix is @Alice:Matrix.org, but you are @mallory:evil.org.",
        "This identity's Matrix is @Alice:Matrix.org, but you are @alice:evil.org.",
      ]);
      assert.equal(rowsOf(h, 'matrix-code').length, 0);
      const code = await h.open(ALICE, token);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('a command forwarded to someone else gives them a code that is of no use: it belongs to the browser that started', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(mallory.address, VICTIM);
      const mine = await h.start(mallory);
      const code = await h.open(VICTIM, mine.token);
      assert.equal(h.chain.attestCalls, 0);
      const other = await h.start(mallory);
      for (const session of [other.session, 'AAAAAAAAAAAAAAAAAAAAAA']) {
        assert.deepEqual((await h.check(mallory, code, session)).json, { error: CODE_EXPIRED });
      }
      assert.deepEqual((await h.check(mallory, otherThan(code), mine.session)).json, { error: 'That code is not right.' });
      assert.equal(h.chain.attestCalls, 0);
    });
  });

  it('an unknown, malformed or spent command, or the old address form, has expired', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(ALICE, '!identitee AAAAAAAAAAAAAAAAAAAAAA');
      await h.say(ALICE, `!identitee ${alice.address}`);
      await h.say(ALICE, '!identitee a b');
      assert.deepEqual(h.client.texts(), [EXPIRED, EXPIRED, EXPIRED]);
      await h.open(ALICE, token);
      await h.say(ALICE, `!identitee ${token}`);
      assert.equal(h.client.texts().at(-1), EXPIRED);
      const late = await h.start(alice);
      h.clock.t += 10 * MINUTE + 1;
      await h.say(ALICE, `!identitee ${late.token}`, { ts: h.clock.t });
      assert.equal(h.client.texts().at(-1), EXPIRED);
    });
  });

  it('a private Matrix: verified on its packet, the value never named, stored or logged', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, '@secret_alice:matrix.org');
      const packet = makePacket(alice, '@secret_alice:matrix.org');
      const { token, session } = await h.start(alice, { packet });
      await h.say(MALLORY, `!identitee ${token}`);
      assert.deepEqual(h.client.texts(), ["This identity's Matrix is something else, but you are @mallory:evil.org."]);
      const code = await h.open('@Secret_Alice:matrix.org', token);
      assertClean(h, ['secret_alice', code, token, session, packet.signature]);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.deepEqual(h.chain.attests.map((a) => a.commitment), [commitment]);
      assertClean(h, ['secret_alice']);
    });
  });

  it('a field changed since the start is refused at the command and at the check', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.chain.setPublic(alice.address, '@alice:matrix.org');
      await h.say(ALICE, `!identitee ${token}`);
      assert.deepEqual(h.client.texts(), [STALE]);
    });
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      h.chain.setPublic(alice.address, '@alice:matrix.org');
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
      assert.equal(h.chain.attestCalls, 0);
    });
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      h.chain.failures.push({ ok: false, reason: 'stale' });
      const r = await h.check(alice, code);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: STALE });
    });
  });

  it('a chain failure keeps the code good, and says nothing in the room', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      h.chain.failures.push({ ok: false, reason: 'failed', detail: 'boom' });
      const r = await h.check(alice, code);
      assert.equal(r.status, 502);
      assert.equal(h.client.sent.length, 2);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
      assert.equal(h.client.texts().at(-1), VERIFIED);
    });
  });

  it('a read of the chain that fails at the check keeps the code good', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      h.chain.readFailures = 1;
      assert.equal((await h.check(alice, code)).status, 500);
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('wrong codes: 5 tries per code, then the code is dropped', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const code = await h.open(ALICE, token);
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, otherThan(code))).json, { error: 'That code is not right.' });
      const r = await h.check(alice, code);
      assert.equal(r.status, 429);
      assert.deepEqual((await h.check(alice, code)).json, { error: CODE_EXPIRED });
      assert.deepEqual((await h.check(alice, 'abc')).json, { error: 'Enter the 6-digit code from Matrix.' });
    });
  });
});

describe('matrix channel: what the bot reads', () => {
  it('a room with more than two members gets no answer, the bot leaves, and the command stays good', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      const room = '!group:example.org';
      h.client.members.set(room, 3);
      await h.say(ALICE, `!identitee ${token}`, { room });
      assert.deepEqual(h.client.sent, []);
      assert.deepEqual(h.client.left, [room]);
      assert.equal(rowsOf(h, 'matrix-start').length, 1);
      await h.open(ALICE, token);
    });
  });

  it('ignores its own messages, notices, other texts, and anything older than its start', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(BOT, `!identitee ${token}`);
      await h.say(BOT.toUpperCase(), `!identitee ${token}`);
      await h.say(ALICE, `!identitee ${token}`, { msgtype: 'm.notice' });
      await h.say(ALICE, 'hello');
      await h.say(ALICE, `!identitee ${token}`, { ts: h.clock.t - 1 });
      assert.deepEqual(h.client.sent, []);
      assert.equal(rowsOf(h, 'matrix-start').length, 1);
      await h.say(ALICE, '!identitee');
      assert.deepEqual(h.client.texts(), [HELP]);
    });
  });

  it('limits the commands per sender and hour: the 11th is told once, then silence', async () => {
    await withAlice(async (h) => {
      for (let i = 0; i < 10; i++) await h.say(MALLORY, '!identitee AAAAAAAAAAAAAAAAAAAAAA');
      await h.say(MALLORY, '!identitee AAAAAAAAAAAAAAAAAAAAAA');
      await h.say(MALLORY, '!identitee AAAAAAAAAAAAAAAAAAAAAA');
      assert.deepEqual(h.client.texts(), [...Array(10).fill(EXPIRED), 'Too many attempts. Try again later.']);
      // beyond the limit, a flood costs the homeserver nothing: no member count per message
      const calls = h.client.memberCalls.length;
      for (let i = 0; i < 20; i++) await h.say(MALLORY, '!identitee AAAAAAAAAAAAAAAAAAAAAA');
      assert.equal(h.client.memberCalls.length, calls);
      assert.equal(h.client.texts().length, 11);
      // another sender is not limited, and the limit keys keep no Matrix id
      const { token } = await h.start(alice);
      await h.open(ALICE, token);
      assertClean(h, ['mallory', 'evil.org']);
    });
  });

  it('joins the rooms it is invited to, never its own invite, and at most 20 per inviter and hour', async () => {
    await withHarness({}, async (h) => {
      await h.invite(ALICE, '!a:example.org');
      await h.invite(BOT, '!self:example.org');
      assert.deepEqual(h.client.joined, ['!a:example.org']);
      for (let i = 0; i < 25; i++) await h.invite(MALLORY, `!m${i}:example.org`);
      assert.equal(h.client.joined.length, 21);
      assertClean(h, ['mallory', '!m0:example.org']);
    });
  });

  it('declines an invite that is not a direct one, and leaves a room of more than two members right after joining', async () => {
    await withHarness({}, async (h) => {
      await h.invite(ALICE, '!notdirect:example.org', false);
      assert.deepEqual(h.client.joined, []);
      assert.deepEqual(h.client.left, ['!notdirect:example.org']);
      h.client.members.set('!crowd:example.org', 3);
      await h.invite(ALICE, '!crowd:example.org');
      assert.deepEqual(h.client.joined, ['!crowd:example.org']);
      assert.deepEqual(h.client.left, ['!notdirect:example.org', '!crowd:example.org']);
      await h.invite(ALICE, '!dm:example.org');
      assert.deepEqual(h.client.left.length, 2);
    });
  });

  it('a message it cannot decrypt gets a short answer, 3 per sender and hour, and only the class is logged', async () => {
    await withHarness({}, async (h) => {
      for (let i = 0; i < 5; i++) await h.undecryptable(ALICE);
      await h.undecryptable(BOT);
      await h.undecryptable(MALLORY, { ts: h.clock.t - 1 });
      assert.deepEqual(h.client.texts(), [UNREADABLE, UNREADABLE, UNREADABLE]);
      assert.ok(h.lines.some((l) => l.includes('matrix-undecryptable')));
      assertClean(h, ['CIPHERTEXT', 'alice']);
    });
  });

  it('a failed answer is logged without its message and does not stop the bot', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      h.client.failSend = 1;
      await h.say(ALICE, `!identitee ${token}`);
      const failed = h.lines.filter((l) => l.includes('matrix-api-failed'));
      assert.equal(failed.length, 1);
      assert.match(failed[0]!, /"errcode":"M_FORBIDDEN"/);
      assert.ok(!h.lines.join('').includes('send failed'));
      const again = await h.start(alice);
      await h.open(ALICE, again.token);
    });
  });

  it('logs a code as delivered only once the homeserver took it; a failed send says so, with its class only', async () => {
    await withAlice(async (h) => {
      const { token } = await h.start(alice);
      await h.say(ALICE, `!identitee ${token}`);
      const room = h.client.created[0]!.room;
      h.client.failSend = 1;
      await h.join(ALICE, room);
      assert.deepEqual(h.client.in(room), []);
      assert.ok(!h.lines.some((l) => l.includes('matrix-code-delivered')), h.lines.join('\n'));
      const failed = h.lines.filter((l) => l.includes('matrix-code-send-failed'));
      assert.equal(failed.length, 1, h.lines.join('\n'));
      assert.match(failed[0]!, /"error":"Error"/);
      assert.match(failed[0]!, /"errcode":"M_FORBIDDEN"/);
      assert.ok(!h.lines.join('').includes('send failed'), 'never the message, which holds the code');
      const again = await h.start(alice);
      await h.open(ALICE, again.token);
      assert.equal(h.lines.filter((l) => l.includes('matrix-code-delivered')).length, 1);
    });
  });
});

describe('matrix channel: the native crypto module', () => {
  const native = nativePath();
  it('the downloaded binary is the pinned one (npm run verify:native)', { skip: native === null || !existsSync(native) ? 'the native module is not installed here' : false }, () => {
    assert.match(readFileSync(PIN_FILE, 'utf8'), /^[0-9a-f]{64}  matrix-sdk-crypto\.linux-x64-gnu\.node\n$/);
    assert.equal(verifyNative().ok, true);
  });

  it('verifyNative refuses a missing, altered or unpinned binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-native-'));
    try {
      const file = join(dir, 'lib.node');
      const pin = join(dir, 'pin.sha256');
      writeFileSync(file, 'the real bytes');
      writeFileSync(pin, `${createHash('sha256').update('the real bytes').digest('hex')}  lib.node\n`);
      assert.equal(verifyNative(file, pin).ok, true);
      assert.deepEqual(verifyNative(join(dir, 'absent.node'), pin), { ok: false, reason: 'missing' });
      assert.deepEqual(verifyNative(null, pin), { ok: false, reason: 'missing' });
      writeFileSync(file, 'other bytes');
      assert.deepEqual(verifyNative(file, pin), { ok: false, reason: 'mismatch' });
      assert.deepEqual(verifyNative(file, join(dir, 'no-pin')), { ok: false, reason: 'no-pin' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing crypto module is logged once as matrix-crypto-missing, and not retried', async () => {
    await withHarness({ connectError: () => new MatrixCryptoMissing('mismatch') }, async (h) => {
      await until(() => h.lines.some((l) => l.includes('matrix-crypto-missing')), 'the error');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(h.logins.length, 1);
      assert.deepEqual(h.sleeps, []);
      const line = JSON.parse(h.lines.find((l) => l.includes('matrix-crypto-missing'))!) as Record<string, unknown>;
      assert.equal(line.level, 'error');
      assert.equal(line.reason, 'mismatch');
      assert.ok(!h.lines.some((l) => l.includes('matrix-connect-failed')));
    });
  });

  it("the SDK's log lines keep the module and the Matrix error code only, and its missing m.direct is info", () => {
    const lines: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const logger = sdkLogger((level, event, fields) => void lines.push([level, event, fields]));
    logger.error('MatrixHttpClient', '(REQ-1)', { errcode: 'M_NOT_FOUND', error: 'Account data not found for @alice:matrix.org' });
    logger.error('MatrixHttpClient', '(REQ-2)', { errcode: 'M_FORBIDDEN', error: 'secret room !abc:x' });
    logger.warn('DMs', 'Error getting m.direct account data: ', new Error('@alice:matrix.org'));
    logger.info('MatrixClientLite', 'room !abc:x');
    assert.deepEqual(lines, [
      ['info', 'matrix-sdk', { module: 'MatrixHttpClient', errcode: 'M_NOT_FOUND' }],
      ['error', 'matrix-sdk', { module: 'MatrixHttpClient', errcode: 'M_FORBIDDEN' }],
      ['warn', 'matrix-sdk', { module: 'DMs' }],
    ]);
  });

  it('only the util._extend deprecation is silenced', () => {
    const seen: unknown[][] = [];
    const emit = withoutDep0060(((...args: unknown[]) => void seen.push(args)) as typeof process.emitWarning);
    emit('The `util._extend` API is deprecated.', 'DeprecationWarning', 'DEP0060');
    emit('The `util._extend` API is deprecated.', { type: 'DeprecationWarning', code: 'DEP0060' });
    emit('Buffer() is deprecated', 'DeprecationWarning', 'DEP0005');
    emit('something else');
    assert.deepEqual(seen, [['Buffer() is deprecated', 'DeprecationWarning', 'DEP0005'], ['something else']]);
  });
});

describe('matrix channel: in the service', () => {
  it('SIGTERM stops the client and the service exits 0, without the password in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-matrix-main-'));
    try {
      const client = new FakeClient();
      const lines: string[] = [];
      const api = {
        genesisHash: { toHex: () => GENESIS },
        runtimeVersion: { specName: { toString: () => 'identitee' } },
        query: { identitee: { agents: async () => ({ toJSON: () => [0, 3] }) } },
        disconnect: async () => undefined,
      } as unknown as ApiPromise;
      const done = main(
        { IDENTITEE_VERIFIER_SURI: '//Alice//verifier', STATE_DIRECTORY: dir, VERIFIER_PORT: '0', ...ENV },
        {
          connect: async () => api,
          write: (line) => void lines.push(line),
          exit: () => assert.fail('no second signal'),
          channels: [matrixChannel({ connect: async () => client })],
        },
      );
      await until(() => lines.some((l) => l.includes('"listening"')) && client.started === 1, 'the service listening and the client started');
      assert.ok(lines.some((l) => l.includes('"matrix"')));
      process.emit('SIGTERM');
      assert.equal(await done, 0);
      assert.equal(client.stopped, 1);
      assert.ok(!lines.join('').includes(PASSWORD));
      assert.ok(lines.at(-1)!.includes('"stopped"'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

