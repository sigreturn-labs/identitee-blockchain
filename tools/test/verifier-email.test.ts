// Tests of the email channel (src/verifier/email.ts, disposable.ts): a fake chain, a stubbed
// Resend and a stubbed MX resolver, no network. The HTTP server is the real one.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import { publicCommitment, publicKeyOf, type AttestResult, type Chain, type FieldKey, type FieldOnChain, type Method } from '../src/verifier/chain.ts';
import { channelRegistry } from '../src/verifier/channels.ts';
import { parseConfig } from '../src/verifier/config.ts';
import type { Ctx } from '../src/verifier/ctx.ts';
import { isDisposableEmail, type MxResolver } from '../src/verifier/disposable.ts';
import { emailChannel, normalizeMailbox } from '../src/verifier/email.ts';
import { HttpServer } from '../src/verifier/http.ts';
import { verifierLogger } from '../src/verifier/log.ts';
import { PacketMemory, privateCommitment, registerPacketRoute } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_KEY = 're_SECRETKEY_123';
const SALT = new Uint8Array(32).fill(0x11);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let alice: KeyringPair;
let bob: KeyringPair;
let keyring: Keyring;
before(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});

// --- A fake chain --------------------------------------------------------------------------------------

/** What the chain holds, and what the agent attested. `attest` refuses like the runtime does. */
class FakeChain implements Chain {
  readonly genesis = GENESIS;
  readonly fields = new Map<string, FieldOnChain>();
  readonly attests: Array<{ address: string; key: FieldKey; commitment: string; method: Method }> = [];
  /** Answer the next attestations with this, once each, instead of working. */
  failures: AttestResult[] = [];
  delayMs = 0;
  /** Called when an attestation starts (a test acts "meanwhile"). */
  onAttest: (() => void) | undefined;

  private slot = (address: string, key: FieldKey): string => `${u8aToHex(publicKeyOf(address))}/${key.Typed}`;

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  setPublic(address: string, kind: 'Email', value: string): void {
    this.fields.set(this.slot(address, { Typed: kind }), { value, private: false, commitment: publicCommitment(stringToU8a(value)) });
  }

  setPrivate(address: string, kind: 'Email', value: string, salt = SALT): string {
    const commitment = privateCommitment(salt, stringToU8a(value));
    this.fields.set(this.slot(address, { Typed: kind }), { value: null, private: true, commitment });
    return commitment;
  }

  clear(address: string, kind: 'Email'): void {
    this.fields.delete(this.slot(address, { Typed: kind }));
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    return this.fields.get(this.slot(address, key)) ?? null;
  }

  async attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
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

/** A packet as the web builds it, signed as a wallet does (copy of the core test's helper). */
function makePacket(pair: KeyringPair, value: string, overrides: { salt?: Uint8Array } = {}) {
  const salt = overrides.salt ?? SALT;
  const content = {
    type: 'identitee-verification-packet',
    version: 1,
    chain: GENESIS,
    address: pair.address,
    field: { typed: 'Email' },
    value,
    salt: u8aToHex(salt),
    commitment: privateCommitment(salt, stringToU8a(value)),
  };
  return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
}

// --- The harness ---------------------------------------------------------------------------------------

interface SentMail {
  url: string;
  headers: Headers;
  body: { from: string; to: string[]; subject: string; text: string; html: string };
}

const defaultMx: MxResolver = async () => [{ exchange: 'mx.example.org', priority: 10 }];

interface Options {
  /** What Resend answers to the nth call (0-based); default 200. */
  resend?: (n: number) => Response | Promise<Response>;
  mx?: MxResolver;
  env?: Record<string, string>;
}

type Answer = { status: number; json: Record<string, unknown> };

async function withHarness(options: Options, run: (h: Harness) => Promise<void>): Promise<void> {
  const clock = { t: 1_800_000_000_000 };
  const chain = new FakeChain();
  const stateDir = mkdtempSync(join(tmpdir(), 'verifier-email-'));
  const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', VERIFIER_DEV: '1', STATE_DIRECTORY: stateDir, ...(options.env ?? { RESEND_API_KEY: RESEND_KEY }) });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const sent: SentMail[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as SentMail['body'] });
    return options.resend ? options.resend(sent.length - 1) : new Response('{"id":"msg_1"}', { status: 200 });
  }) as typeof fetch;

  let server: HttpServer | undefined;
  let registry: ReturnType<typeof channelRegistry> | undefined;
  let port = 0;
  let enabled: string[] = [];
  /** (Re)start the service: a new channel instance and a new server over the same state directory and store. */
  const start = async (): Promise<void> => {
    server = new HttpServer({ dev: false, log });
    registerPacketRoute(server, ctx);
    registry = channelRegistry([emailChannel({ fetch: fakeFetch, resolveMx: options.mx ?? defaultMx })], ctx, server);
    await registry.start();
    enabled = registry.enabled;
    port = await server.listen(0, '127.0.0.1');
  };
  const stop = async (): Promise<void> => {
    await registry?.stop();
    await server?.close();
  };
  await start();

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, ip = '198.51.100.1'): Promise<Answer> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  /** The session of the last send each account was given. */
  const lastSession = new Map<string, string>();
  const h: Harness = {
    clock,
    chain,
    ctx,
    lines,
    sent,
    stateDir,
    get enabled() {
      return enabled;
    },
    restart: async () => {
      await stop();
      await start();
    },
    post: (path, body, ip) => call('POST', path, body, ip),
    get: (path) => call('GET', path),
    send: async (who, extra = {}, ip) => {
      const r = await call('POST', '/api/email/send', { address: who.address, ...extra }, ip);
      if (typeof r.json.session === 'string') lastSession.set(who.address, r.json.session);
      return r;
    },
    check: (who, code, session) => call('POST', '/api/email/check', { address: who.address, code, session: session ?? lastSession.get(who.address) }),
    codeOf: (n) => {
      const text = sent[n]?.body.text ?? '';
      const found = /\b(\d{6})\b/.exec(text);
      assert.ok(found, `no code in mail ${n}`);
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

interface Harness {
  clock: { t: number };
  chain: FakeChain;
  ctx: Ctx;
  lines: string[];
  sent: SentMail[];
  stateDir: string;
  readonly enabled: string[];
  restart(): Promise<void>;
  post(path: string, body?: unknown, ip?: string): Promise<Answer>;
  get(path: string): Promise<Answer>;
  send(who: KeyringPair, extra?: Record<string, unknown>, ip?: string): Promise<Answer>;
  /** `session`: the one of this account's last send by default. */
  check(who: KeyringPair, code: string, session?: string): Promise<Answer>;
  codeOf(n: number): string;
}

/** A 6-digit code that is not `code`. */
const otherThan = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

// --- The channel ---------------------------------------------------------------------------------------

describe('email channel: availability', () => {
  it('is enabled only with RESEND_API_KEY, and otherwise answers 503', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(h.enabled, ['email']);
      assert.deepEqual((await h.get('/api/channels')).json, { channels: ['email'] });
    });
    await withHarness({ env: {} }, async (h) => {
      assert.deepEqual(h.enabled, []);
      const r = await h.send(alice);
      assert.equal(r.status, 503);
      assert.deepEqual(r.json, { error: 'This verification is not available yet.' });
      assert.equal((await h.check(alice, '123456')).status, 503);
      assert.equal(h.sent.length, 0);
    });
  });
});

describe('email channel: sending the code', () => {
  it('sends to the email the chain holds, never one from the request, and never answers the code', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const r = await h.send(alice, { email: 'attacker@evil.example', to: 'attacker@evil.example' });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['sent', 'session']);
      assert.equal(r.json.sent, true);
      assert.match(String(r.json.session), /^[A-Za-z0-9_-]{22}$/);
      assert.equal(h.sent.length, 1);
      const mail = h.sent[0]!;
      assert.equal(mail.url, RESEND_URL);
      assert.equal(mail.headers.get('authorization'), `Bearer ${RESEND_KEY}`);
      assert.match(mail.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(mail.body.from, 'identitee <verify@identit.ee>');
      assert.deepEqual(mail.body.to, ['alice@example.org']);
      assert.equal(mail.body.subject, 'Your identitee code');
      const code = h.codeOf(0);
      assert.match(code, /^\d{6}$/);
      assert.ok(mail.body.text.includes(code) && mail.body.html.includes(code));
      assert.ok(mail.body.html.includes('<'), 'a simple HTML part');
      assert.ok(!JSON.stringify(r.json).includes(code));
      assert.ok(!JSON.stringify(mail.body).includes(String(r.json.session)), 'the session is not in the email');
      assert.deepEqual(Object.keys(mail.body).sort(), ['from', 'html', 'subject', 'text', 'to']);
    });
  });

  it('an account without an email on chain, or a bad address, sends nothing', async () => {
    await withHarness({}, async (h) => {
      const none = await h.send(alice);
      assert.equal(none.status, 400);
      assert.deepEqual(none.json, { error: 'Add an email to your identity first.' });
      assert.equal((await h.post('/api/email/send', { address: 'nope' })).status, 400);
      assert.equal((await h.post('/api/email/send', {})).status, 400);
      assert.equal((await h.post('/api/email/send')).status, 400);
      h.chain.setPublic(alice.address, 'Email', 'not an email');
      const bad = await h.send(alice);
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.json, { error: 'The email on your identity is not a valid address.' });
      assert.equal(h.sent.length, 0);
    });
  });

  it('keeps the code under a key outside the database: no code, no email, no session, no plain hash in the rows', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const { json } = await h.send(alice);
      const session = String(json.session);
      const code = h.codeOf(0);
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(rows.includes('email-code'), rows);
      for (const secret of [code, 'alice@example.org', session]) assert.ok(!rows.includes(secret), `${secret} in ${rows}`);
      // not a hash anybody could compute from what is public
      for (const plain of [`${h.ctx.store.dump().items.length}`, `${alice.address}:${session}:${code}`, `${session}:${alice.address}:${code}`, code, `${alice.address}:${code}`]) {
        assert.ok(!rows.includes(createHash('sha256').update(plain).digest('hex')), plain);
      }
      // the key lives in a file of the state directory, readable by its owner only, and not in the database
      const file = join(h.stateDir, 'email.key');
      const key = readFileSync(file, 'utf8').trim();
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.ok(!rows.includes(key));
      assert.ok(!h.lines.join('').includes(key));
    });
  });

  it('several codes can be pending for one account: a send never replaces another one', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const first = String((await h.send(alice)).json.session);
      const second = String((await h.send(alice)).json.session);
      assert.notEqual(first, second);
      assert.equal(h.ctx.store.dump().items.length, 2);
      assert.deepEqual((await h.check(alice, h.codeOf(1), second)).json, { verified: true });
      assert.deepEqual((await h.check(alice, h.codeOf(0), first)).json, { verified: true });
    });
  });

  it('refuses a disposable email, and sends nothing', async () => {
    const mx: MxResolver = async () => [{ exchange: 'mx.Mailinator.com.', priority: 10 }];
    await withHarness({ mx }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'someone@throwaway.example');
      const r = await h.send(alice);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'Disposable email addresses cannot be verified.' });
      assert.equal(h.sent.length, 0);
      assert.equal(h.ctx.store.dump().items.length, 0);
    });
  });

  it('a failing MX lookup lets the email through', async () => {
    const mx: MxResolver = async () => {
      throw Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' });
    };
    await withHarness({ mx }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      assert.equal((await h.send(alice)).json.sent, true);
    });
  });

  it('answers a sentence when Resend refuses or cannot be reached, and keeps no code', async () => {
    const sentence = { error: 'The email could not be sent. Try again in a moment.' };
    await withHarness({ resend: () => new Response('{"message":"to alice@example.org is invalid"}', { status: 422 }) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const r = await h.send(alice);
      assert.equal(r.status, 502);
      assert.deepEqual(r.json, sentence);
      assert.equal(h.ctx.store.dump().items.length, 0);
      assert.equal((await h.check(alice, '123456')).status, 400);
      assert.ok(!h.lines.join('').includes('alice@example.org'), 'a Resend answer is not logged');
    });
    await withHarness({
      resend: () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED re_SECRETKEY_123');
      },
    }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const r = await h.send(alice);
      assert.equal(r.status, 502);
      assert.deepEqual(r.json, sentence);
      assert.ok(!h.lines.join('').includes('ECONNREFUSED'), 'an error message is not logged');
    });
  });

  it('a failed send leaves the earlier code usable', async () => {
    await withHarness({ resend: (n) => (n === 1 ? new Response('{}', { status: 500 }) : new Response('{}', { status: 200 })) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      assert.equal((await h.send(alice)).status, 502);
      assert.deepEqual((await h.check(alice, h.codeOf(0))).json, { verified: true });
    });
  });
});

describe('email channel: checking the code', () => {
  it('a right code attests with the commitment of the start, by EmailCode, and only once', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      const r = await h.check(alice, h.codeOf(0));
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { verified: true });
      assert.deepEqual(h.chain.attests, [{ address: alice.address, key: { Typed: 'Email' }, commitment: publicCommitment(stringToU8a('alice@example.org')), method: 'EmailCode' }]);
      const again = await h.check(alice, h.codeOf(0));
      assert.equal(again.status, 400);
      assert.deepEqual(again.json, { error: 'This code has expired. Ask for a new one.' });
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('takes the code with spaces around it, and an address of another prefix', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const { json } = await h.send(alice);
      const other = keyring.encodeAddress(alice.publicKey, 0);
      const r = await h.post('/api/email/check', { address: other, session: json.session, code: ` ${h.codeOf(0).slice(0, 3)} ${h.codeOf(0).slice(3)} ` });
      assert.deepEqual(r.json, { verified: true });
    });
  });

  it('wrong codes count attempts: five are answered, the sixth is refused even if right', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      const code = h.codeOf(0);
      for (let i = 1; i <= 5; i++) {
        const r = await h.check(alice, otherThan(code));
        assert.equal(r.status, 400, `attempt ${i}`);
        assert.deepEqual(r.json, { error: 'That code is not right.' });
      }
      const sixth = await h.check(alice, code);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many wrong codes. Ask for a new one.' });
      assert.equal(h.chain.attests.length, 0);
      assert.equal((await h.check(alice, code)).status, 400, 'the code is gone');
      // a new code starts again
      await h.send(alice);
      assert.deepEqual((await h.check(alice, h.codeOf(1))).json, { verified: true });
    });
  });

  it('the fifth attempt can still be the right one', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      const code = h.codeOf(0);
      for (let i = 0; i < 4; i++) await h.check(alice, otherThan(code));
      assert.deepEqual((await h.check(alice, code)).json, { verified: true });
    });
  });

  it('something that is not a six-digit code is refused without using an attempt', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      for (const bad of ['', '12345', '1234567', 'abcdef', '12 34']) {
        const r = await h.check(alice, bad);
        assert.equal(r.status, 400, bad);
        assert.deepEqual(r.json, { error: 'Enter the 6-digit code from the email.' });
      }
      assert.equal((await h.post('/api/email/check', { address: alice.address, code: 123456 })).status, 400);
      assert.equal((await h.post('/api/email/check', { address: alice.address })).status, 400);
      assert.equal((await h.post('/api/email/check', { address: 'nope', code: '123456' })).status, 400);
      for (let i = 0; i < 4; i++) await h.check(alice, otherThan(h.codeOf(0)));
      assert.deepEqual((await h.check(alice, h.codeOf(0))).json, { verified: true });
    });
  });

  it('a code is refused after ten minutes, accepted just before', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      h.clock.t += 10 * MINUTE - 1;
      assert.deepEqual((await h.check(alice, h.codeOf(0))).json, { verified: true });
      await h.send(alice);
      h.clock.t += 10 * MINUTE;
      const r = await h.check(alice, h.codeOf(1));
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'This code has expired. Ask for a new one.' });
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('no code was asked for: refused', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const r = await h.check(alice, '123456');
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'This code has expired. Ask for a new one.' });
    });
  });

  it('a code for one account does not work for another', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      h.chain.setPublic(bob.address, 'Email', 'bob@example.org');
      const aliceSession = String((await h.send(alice)).json.session);
      await h.send(bob);
      const aliceCode = h.codeOf(0);
      const bobCode = h.codeOf(1);
      if (aliceCode !== bobCode) assert.equal((await h.check(bob, aliceCode)).status, 400);
      // nor does a session of one account work for the other
      assert.equal((await h.check(bob, bobCode, aliceSession)).status, 400);
      assert.equal((await h.check(bob, aliceCode, aliceSession)).status, 400);
      assert.equal(h.chain.attests.length, 0);
      assert.deepEqual((await h.check(alice, aliceCode, aliceSession)).json, { verified: true });
    });
  });

  it('the field changed since the code was sent: "Your Email changed. Verify it again."', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'old@example.org');
      await h.send(alice);
      h.chain.setPublic(alice.address, 'Email', 'new@example.org');
      const r = await h.check(alice, h.codeOf(0));
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'Your Email changed. Verify it again.' });
      assert.equal(h.chain.attests.length, 0);
      // the new email gets its own code
      await h.send(alice);
      assert.deepEqual(h.sent[1]!.body.to, ['new@example.org']);
      assert.deepEqual((await h.check(alice, h.codeOf(1))).json, { verified: true });
      assert.equal(h.chain.attests[0]!.commitment, publicCommitment(stringToU8a('new@example.org')));
    });
  });

  it('the field was removed since: it says so', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      h.chain.clear(alice.address, 'Email');
      const r = await h.check(alice, h.codeOf(0));
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'Your Email is no longer on your identity.' });
    });
  });

  it('a chain failure says so and keeps the code for a retry', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      h.chain.failures = [{ ok: false, reason: 'failed', detail: 'node down' }];
      const r = await h.check(alice, h.codeOf(0));
      assert.equal(r.status, 502);
      assert.deepEqual(r.json, { error: 'The verification could not be recorded. Try again in a moment.' });
      assert.ok(!JSON.stringify(r.json).includes('node down'));
      assert.deepEqual((await h.check(alice, h.codeOf(0))).json, { verified: true });
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('two checks with the right code at once attest once', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      h.chain.delayMs = 30;
      const code = h.codeOf(0);
      const [a, b] = await Promise.all([h.check(alice, code), h.check(alice, code)]);
      assert.deepEqual([a.status, b.status].sort(), [200, 400]);
      assert.equal(h.chain.attests.length, 1);
    });
  });
});

describe('email channel: limits', () => {
  it('five codes per hour per account, the sixth is refused, and the hour frees them', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      h.chain.setPublic(bob.address, 'Email', 'bob@example.org');
      for (let i = 0; i < 5; i++) assert.equal((await h.send(alice)).status, 200, `send ${i + 1}`);
      const sixth = await h.send(alice);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many codes were sent for this account. Try again in an hour.' });
      assert.equal(h.sent.length, 5);
      assert.equal((await h.send(bob)).status, 200, 'another account is not affected');
      h.clock.t += HOUR + 1;
      assert.equal((await h.send(alice)).status, 200);
    });
  });

  it('the account limit counts per IP: a third party sending to an account does not lock its owner out', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      for (let i = 0; i < 5; i++) assert.equal((await h.send(alice, {}, '203.0.113.66')).status, 200, `send ${i + 1}`);
      // the mailbox took its five codes of the hour: that limit holds for everyone
      const owner = await h.send(alice, {}, '198.51.100.7');
      assert.deepEqual(owner.json, { error: 'Too many codes were sent to this email. Try again in an hour.' });
      // with another mailbox, only the IP that sent the five is held by the account limit
      h.chain.setPublic(alice.address, 'Email', 'alice@example.net');
      const third = await h.send(alice, {}, '203.0.113.66');
      assert.equal(third.status, 429);
      assert.deepEqual(third.json, { error: 'Too many codes were sent for this account. Try again in an hour.' });
      assert.equal((await h.send(alice, {}, '198.51.100.7')).status, 200, 'the owner, from another IP, still gets a code');
    });
  });

  it('five codes per hour to one mailbox, whatever the accounts that name it', async () => {
    await withHarness({}, async (h) => {
      const accounts = Array.from({ length: 6 }, (_, i) => keyring.addFromUri(`//Mailbox${i}`));
      for (const account of accounts) h.chain.setPublic(account.address, 'Email', 'Shared@Example.org');
      for (let i = 0; i < 5; i++) assert.equal((await h.send(accounts[i]!, {}, `203.0.113.${i + 1}`)).status, 200);
      const sixth = await h.send(accounts[5]!, {}, '203.0.113.9');
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many codes were sent to this email. Try again in an hour.' });
      // the limit's key is not the address
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(!rows.toLowerCase().includes('shared@example.org'), rows);
    });
  });

  it('thirty proof starts per hour per IP', async () => {
    await withHarness({}, async (h) => {
      const accounts = Array.from({ length: 31 }, (_, i) => keyring.addFromUri(`//Start${i}`));
      accounts.forEach((account, i) => h.chain.setPublic(account.address, 'Email', `user${i}@example.org`));
      for (let i = 0; i < 30; i++) assert.equal((await h.send(accounts[i]!, {}, '192.0.2.50')).status, 200, `start ${i + 1}`);
      const refused = await h.send(accounts[30]!, {}, '192.0.2.50');
      assert.equal(refused.status, 429);
      assert.deepEqual(refused.json, { error: 'Too many attempts. Try again later.' });
      assert.equal((await h.send(accounts[30]!, {}, '192.0.2.51')).status, 200, 'another IP is not affected');
    });
  });
});

describe('email channel: a private email', () => {
  const EMAIL = 'secret.person@example.org';

  it('needs the packet, sends to the value in it, and keeps neither the value nor the salt', async () => {
    await withHarness({}, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, 'Email', EMAIL);
      const without = await h.send(alice);
      assert.equal(without.status, 400);
      assert.deepEqual(without.json, { error: 'Unlock your identity to verify a private email.' });
      assert.equal(h.sent.length, 0);

      const r = await h.send(alice, { packet: makePacket(alice, EMAIL) });
      assert.equal(r.json.sent, true);
      assert.deepEqual(h.sent[0]!.body.to, [EMAIL]);
      const code = h.codeOf(0);

      const rows = JSON.stringify(h.ctx.store.dump());
      for (const where of [rows, h.lines.join('')]) {
        assert.ok(!where.includes(EMAIL) && !where.includes('secret.person') && !where.includes(u8aToHex(SALT).slice(2)) && !where.includes(code), where);
      }

      const wrong = await h.check(alice, otherThan(code));
      assert.equal(wrong.status, 400);
      const ok = await h.check(alice, code);
      assert.deepEqual(ok.json, { verified: true });
      assert.deepEqual(h.chain.attests.map((a) => [a.commitment, a.method]), [[commitment, 'EmailCode']]);
    });
  });

  it('takes the packet by the id /api/packet gave', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, 'Email', EMAIL);
      const stored = await h.post('/api/packet', { address: alice.address, packet: makePacket(alice, EMAIL) });
      assert.equal(stored.status, 200);
      const r = await h.send(alice, { packet: stored.json.id });
      assert.equal(r.json.sent, true);
      assert.deepEqual(h.sent[0]!.body.to, [EMAIL]);
      assert.ok(!JSON.stringify(h.ctx.store.dump()).includes(String(stored.json.id)));
    });
  });

  it('refuses a packet of another account, of another value, or a stale one: nothing is sent', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, 'Email', EMAIL);
      const other = await h.send(alice, { packet: makePacket(bob, EMAIL) });
      assert.equal(other.status, 400);
      assert.deepEqual(other.json, { error: 'This packet is signed by another account.' });
      const value = await h.send(alice, { packet: makePacket(alice, 'someone.else@example.org') });
      assert.equal(value.status, 400);
      assert.match(String(value.json.error), /does not match your Email on chain/);
      h.chain.setPrivate(alice.address, 'Email', EMAIL, new Uint8Array(32).fill(0x12));
      const stale = await h.send(alice, { packet: makePacket(alice, EMAIL) });
      assert.equal(stale.status, 400);
      assert.match(String(stale.json.error), /does not match your Email on chain/);
      assert.equal(h.sent.length, 0);
      assert.ok(!h.lines.join('').includes(EMAIL));
    });
  });

  it('the private field changed after the code was sent: stale, nothing attested', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPrivate(alice.address, 'Email', EMAIL);
      await h.send(alice, { packet: makePacket(alice, EMAIL) });
      h.chain.setPrivate(alice.address, 'Email', 'another@example.org');
      const r = await h.check(alice, h.codeOf(0));
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'Your Email changed. Verify it again.' });
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('a packet for a public field is ignored: the chain is the only source', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice, { packet: makePacket(alice, 'forged@example.org') });
      assert.deepEqual(h.sent[0]!.body.to, ['alice@example.org']);
    });
  });
});

/** A 6-digit code that is none of `codes`. */
const wrongFor = (...codes: string[]): string => {
  for (let n = 0; ; n++) {
    const guess = String(n).padStart(6, '0');
    if (!codes.includes(guess)) return guess;
  }
};

const NOT_RIGHT = { error: 'That code is not right.' };
const EXPIRED = { error: 'This code has expired. Ask for a new one.' };
const HOUR_LIMIT = { error: 'Too many wrong codes. Try again in an hour.' };

describe('email channel: sessions', () => {
  it("another session's wrong guesses never touch the owner's code or its attempts", async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const owner = String((await h.send(alice)).json.session);
      const third = String((await h.send(alice, {}, '203.0.113.7')).json.session);
      const [ownerCode, thirdCode] = [h.codeOf(0), h.codeOf(1)];
      const wrong = wrongFor(ownerCode, thirdCode);
      // the third party exhausts its own code
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, wrong, third)).json, NOT_RIGHT);
      const sixth = await h.check(alice, thirdCode, third);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many wrong codes. Ask for a new one.' });
      // guesses under sessions that are not the owner's find nothing
      for (let i = 0; i < 10; i++) assert.deepEqual((await h.check(alice, wrong, 'A'.repeat(22))).json, EXPIRED);
      assert.deepEqual((await h.check(alice, wrong, third)).json, EXPIRED, 'the dropped session');
      // the owner's row has all its attempts, and its code works
      for (let i = 0; i < 4; i++) assert.deepEqual((await h.check(alice, wrong, owner)).json, NOT_RIGHT);
      assert.deepEqual((await h.check(alice, ownerCode, owner)).json, { verified: true });
    });
  });

  it("a third party's send does not invalidate or replace the owner's code", async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const owner = String((await h.send(alice)).json.session);
      const third = String((await h.send(alice, {}, '203.0.113.7')).json.session);
      assert.notEqual(owner, third);
      assert.equal(h.ctx.store.dump().items.length, 2);
      if (h.codeOf(0) !== h.codeOf(1)) assert.deepEqual((await h.check(alice, h.codeOf(0), third)).json, NOT_RIGHT, 'a code works under its own session only');
      assert.deepEqual((await h.check(alice, h.codeOf(0), owner)).json, { verified: true });
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('needs the session: a missing, malformed or unknown one finds nothing and uses no attempt', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const session = String((await h.send(alice)).json.session);
      const code = h.codeOf(0);
      for (const bad of [undefined, null, '', 'short', 42, 'A'.repeat(21), 'A'.repeat(23), `${'A'.repeat(21)}!`, 'B'.repeat(22)]) {
        const r = await h.post('/api/email/check', { address: alice.address, code, session: bad });
        assert.equal(r.status, 400, String(bad));
        assert.deepEqual(r.json, EXPIRED);
      }
      assert.deepEqual((await h.post('/api/email/check', { address: alice.address, code })).json, EXPIRED);
      // a session of another address is not found either
      assert.deepEqual((await h.post('/api/email/check', { address: bob.address, code, session })).json, EXPIRED);
      for (let i = 0; i < 4; i++) await h.check(alice, wrongFor(code), session);
      assert.deepEqual((await h.check(alice, code, session)).json, { verified: true });
      // the session never reached a log or a row
      assert.ok(!h.lines.join('').includes(session));
      assert.ok(!JSON.stringify(h.ctx.store.dump()).includes(session));
    });
  });
});

describe('email channel: wrong codes across sends', () => {
  it('the 11th wrong code of an account, over several sends, is refused even with the right code, until the hour has passed', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const sessions = [] as string[];
      for (let i = 0; i < 3; i++) sessions.push(String((await h.send(alice)).json.session));
      const codes = [h.codeOf(0), h.codeOf(1), h.codeOf(2)];
      const wrong = wrongFor(...codes);
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, wrong, sessions[0])).json, NOT_RIGHT, `first send, wrong ${i + 1}`);
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, wrong, sessions[1])).json, NOT_RIGHT, `second send, wrong ${i + 6}`);
      // the 11th guess, on a code with all its attempts left, and a right code on a row that is still good
      for (const [i, code] of [[2, codes[2]!], [1, codes[1]!], [2, wrong]] as const) {
        const r = await h.check(alice, code, sessions[i]);
        assert.equal(r.status, 429);
        assert.deepEqual(r.json, HOUR_LIMIT);
      }
      assert.equal(h.chain.attests.length, 0);
      // a new send does not reset it
      const fresh = String((await h.send(alice)).json.session);
      assert.deepEqual((await h.check(alice, h.codeOf(3), fresh)).json, HOUR_LIMIT);
      // after the hour
      h.clock.t += HOUR + 1;
      const later = String((await h.send(alice)).json.session);
      assert.deepEqual((await h.check(alice, h.codeOf(4), later)).json, { verified: true });
    });
  });

  it('wrong codes also add up per mailbox, over accounts and spellings of it', async () => {
    await withHarness({}, async (h) => {
      const x = keyring.addFromUri('//Wrong0');
      const y = keyring.addFromUri('//Wrong1');
      const z = keyring.addFromUri('//Wrong2');
      h.chain.setPublic(x.address, 'Email', 'john.doe@gmail.com');
      h.chain.setPublic(y.address, 'Email', 'johndoe+a@googlemail.com');
      h.chain.setPublic(z.address, 'Email', 'JOHN.DOE+z@gmail.com.');
      const sx = String((await h.send(x)).json.session);
      const sy = String((await h.send(y)).json.session);
      const sz = String((await h.send(z)).json.session);
      const wrong = wrongFor(h.codeOf(0), h.codeOf(1), h.codeOf(2));
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(x, wrong, sx)).json, NOT_RIGHT);
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(y, wrong, sy)).json, NOT_RIGHT);
      const r = await h.check(z, h.codeOf(2), sz);
      assert.equal(r.status, 429);
      assert.deepEqual(r.json, HOUR_LIMIT);
      assert.equal(h.chain.attests.length, 0);
    });
  });
});

describe('email channel: wrong codes of an account whose email changes', () => {
  it("add up per account even when each send went to another mailbox", async () => {
    await withHarness({}, async (h) => {
      const sessions = [] as string[];
      for (const email of ['one@example.org', 'two@example.org', 'three@example.org']) {
        h.chain.setPublic(alice.address, 'Email', email);
        sessions.push(String((await h.send(alice)).json.session));
      }
      const wrong = wrongFor(h.codeOf(0), h.codeOf(1), h.codeOf(2));
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, wrong, sessions[0])).json, NOT_RIGHT);
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(alice, wrong, sessions[1])).json, NOT_RIGHT);
      const r = await h.check(alice, h.codeOf(2), sessions[2]);
      assert.equal(r.status, 429);
      assert.deepEqual(r.json, HOUR_LIMIT);
    });
  });
});

describe('email channel: the mailbox', () => {
  it('normalizeMailbox: case, spaces, trailing dot, +tag, and Gmail dots', () => {
    const cases: Array<[string, string]> = [
      ['John.Doe+tag@Gmail.com.', 'johndoe@gmail.com'],
      ['j.o.h.n@googlemail.com', 'john@gmail.com'],
      ['a.b+x@example.org', 'a.b@example.org'],
      [' Me@Example.ORG ', 'me@example.org'],
      ['+tag@example.org', '+tag@example.org'],
      ['a+b+c@example.org', 'a@example.org'],
      ['x.y@sub.gmail.com', 'x.y@sub.gmail.com'],
      ['a.b@example.org', 'a.b@example.org'],
    ];
    for (const [email, expected] of cases) assert.equal(normalizeMailbox(email), expected, email);
    assert.notEqual(normalizeMailbox('a.b@example.org'), normalizeMailbox('ab@example.org'), 'dots count outside Gmail');
  });

  it('spellings of one mailbox share the limit of five codes an hour', async () => {
    await withHarness({}, async (h) => {
      const spellings = ['a.b@gmail.com', 'ab+1@gmail.com', 'AB@googlemail.com', 'a.b+2@gmail.com.', 'ab@gmail.com', 'a.b+zz@GMAIL.com'];
      const accounts = spellings.map((_, i) => keyring.addFromUri(`//Spelling${i}`));
      accounts.forEach((account, i) => h.chain.setPublic(account.address, 'Email', spellings[i]!));
      for (let i = 0; i < 5; i++) assert.equal((await h.send(accounts[i]!)).status, 200, spellings[i]);
      const sixth = await h.send(accounts[5]!);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many codes were sent to this email. Try again in an hour.' });
      // another mailbox is not affected
      h.chain.setPublic(alice.address, 'Email', 'someone.else@gmail.com');
      assert.equal((await h.send(alice)).status, 200);
    });
  });

  it('the key survives a restart: pending codes, the mailbox send limit and the wrong-code limit all hold', async () => {
    await withHarness({}, async (h) => {
      const accounts = Array.from({ length: 6 }, (_, i) => keyring.addFromUri(`//Restart${i}`));
      accounts.forEach((account) => h.chain.setPublic(account.address, 'Email', 'shared@example.org'));
      const sessions = [] as string[];
      for (let i = 0; i < 3; i++) sessions.push(String((await h.send(accounts[i]!)).json.session));
      const wrong = wrongFor(h.codeOf(0), h.codeOf(1), h.codeOf(2));
      for (let i = 0; i < 5; i++) await h.check(accounts[0]!, wrong, sessions[0]);
      const keyBefore = readFileSync(join(h.stateDir, 'email.key'), 'utf8');

      await h.restart();
      assert.equal(readFileSync(join(h.stateDir, 'email.key'), 'utf8'), keyBefore, 'the key is read again, not made again');

      // a code sent before the restart still checks
      assert.deepEqual((await h.check(accounts[1]!, h.codeOf(1), sessions[1])).json, { verified: true });
      // the mailbox limit counts the 3 sent before: two more, then the sixth is refused
      for (const i of [3, 4]) sessions.push(String((await h.send(accounts[i]!)).json.session));
      const sixth = await h.send(accounts[5]!);
      assert.equal(sixth.status, 429);
      assert.deepEqual(sixth.json, { error: 'Too many codes were sent to this email. Try again in an hour.' });
      // and so do the 5 wrong codes of before: 5 more reach the limit of 10
      const wrong2 = wrongFor(h.codeOf(3), h.codeOf(4));
      for (let i = 0; i < 5; i++) assert.deepEqual((await h.check(accounts[3]!, wrong2, sessions[3])).json, NOT_RIGHT);
      assert.deepEqual((await h.check(accounts[4]!, h.codeOf(4), sessions[4])).json, HOUR_LIMIT);
    });
  });

  it('a lost key file makes a new key: pending codes are then not found', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      await h.send(alice);
      rmSync(join(h.stateDir, 'email.key'));
      await h.restart();
      assert.deepEqual((await h.check(alice, h.codeOf(0))).json, EXPIRED);
    });
  });
});

describe('email channel: what counts against the send limits', () => {
  it('failed deliveries are not counted: the 429 comes after five delivered codes', async () => {
    await withHarness({ resend: (n) => new Response('{}', { status: n < 7 ? 500 : 200 }) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      for (let i = 0; i < 7; i++) assert.equal((await h.send(alice)).status, 502, `failure ${i + 1}`);
      for (let i = 0; i < 5; i++) assert.equal((await h.send(alice)).status, 200, `delivery ${i + 1}`);
      const next = await h.send(alice);
      assert.equal(next.status, 429);
      assert.deepEqual(next.json, { error: 'Too many codes were sent for this account. Try again in an hour.' });
      assert.equal(h.sent.length, 12);
      assert.equal(h.ctx.store.dump().hits.filter((row) => (row as { bucket: string }).bucket === 'email-send').length, 5);
    });
  });

  it('the IP limit counts every attempt, delivered or not', async () => {
    await withHarness({ resend: () => new Response('{}', { status: 500 }) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      for (let i = 0; i < 30; i++) assert.equal((await h.send(alice, {}, '192.0.2.77')).status, 502);
      const next = await h.send(alice, {}, '192.0.2.77');
      assert.equal(next.status, 429);
      assert.deepEqual(next.json, { error: 'Too many attempts. Try again later.' });
    });
  });

  it('sends under way count too: ten at once deliver five', async () => {
    const slow = async (): Promise<Response> => {
      await new Promise((r) => setTimeout(r, 40));
      return new Response('{}', { status: 200 });
    };
    await withHarness({ resend: slow }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const answers = await Promise.all(Array.from({ length: 10 }, () => h.send(alice)));
      assert.equal(answers.filter((a) => a.status === 200).length, 5);
      assert.equal(answers.filter((a) => a.status === 429).length, 5);
      assert.equal(h.sent.length, 5);
    });
  });

  it('a failed delivery frees what it held: the next send is allowed', async () => {
    await withHarness({ resend: (n) => new Response('{}', { status: n === 0 ? 500 : 200 }) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      assert.equal((await h.send(alice)).status, 502);
      for (let i = 0; i < 5; i++) assert.equal((await h.send(alice)).status, 200);
      assert.equal((await h.send(alice)).status, 429);
    });
  });
});

describe('email channel: putting a code back after a chain failure', () => {
  it('never over a row that was put there meanwhile', async () => {
    await withHarness({}, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      const session = String((await h.send(alice)).json.session);
      const row = h.ctx.store.dump().items[0] as { kind: string; id: string; data: string };
      const newer = { ...(JSON.parse(row.data) as Record<string, unknown>), hash: 'f'.repeat(64) };
      h.chain.failures = [{ ok: false, reason: 'failed', detail: 'node down' }];
      h.chain.onAttest = () => h.ctx.store.put(row.kind, row.id, newer, 10 * MINUTE);
      const r = await h.check(alice, h.codeOf(0), session);
      assert.equal(r.status, 502);
      const rows = h.ctx.store.dump().items as Array<{ data: string }>;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]!.data), newer);
    });
  });
});

describe('email channel: what the logs say', () => {
  it('never holds a code, the key, an email or a packet, whatever happens', async () => {
    await withHarness({ resend: (n) => (n === 2 ? new Response('{}', { status: 500 }) : new Response('{}', { status: 200 })) }, async (h) => {
      h.chain.setPublic(alice.address, 'Email', 'alice@example.org');
      h.chain.setPrivate(bob.address, 'Email', 'bob.private@example.org');
      const aliceSession = String((await h.send(alice)).json.session);
      const aliceCode = h.codeOf(0);
      await h.check(alice, otherThan(aliceCode));
      const bobSession = String((await h.send(bob, { packet: makePacket(bob, 'bob.private@example.org') })).json.session);
      const bobCode = h.codeOf(1);
      await h.send(bob, { packet: makePacket(bob, 'bob.private@example.org') }); // Resend 500
      await h.check(bob, otherThan(bobCode));
      await h.check(alice, aliceCode);
      h.chain.setPublic(bob.address, 'Email', 'changed@example.org');
      await h.check(bob, bobCode);
      const text = h.lines.join('');
      for (const secret of [aliceCode, bobCode, otherThan(aliceCode), RESEND_KEY, 'alice@example.org', 'bob.private', 'changed@example.org', 'Bearer', aliceSession, bobSession]) {
        assert.ok(!text.includes(secret), `${secret} in the logs`);
      }
      assert.ok(text.includes('email-send-failed'), 'a failure is logged, without its detail');
    });
  });
});

// --- The disposable list ---------------------------------------------------------------------------------

describe('isDisposableEmail', () => {
  const mx = (...hosts: string[]): MxResolver => async () => hosts.map((exchange, i) => ({ exchange, priority: i }));

  it('is true when an MX is a listed provider or one of its subdomains, without case or trailing dot', async () => {
    for (const host of ['mailinator.com', 'mx1.guerrillamail.com', 'MX.YOPMAIL.COM.', 'in.maildrop.cc', 'fakeinbox.com']) {
      assert.equal(await isDisposableEmail('x@some-domain.example', mx('mx.example.org', host)), true, host);
    }
  });

  it('is false for a real provider, a lookalike suffix, or no MX', async () => {
    for (const host of ['aspmx.l.google.com', 'mx.notmailinator.com', 'mailinator.com.evil.example', 'mail.protonmail.ch']) {
      assert.equal(await isDisposableEmail('x@some-domain.example', mx(host)), false, host);
    }
    assert.equal(await isDisposableEmail('x@some-domain.example', mx()), false);
  });

  it('is true when the address itself is at a listed provider, without a lookup', async () => {
    const never: MxResolver = async () => assert.fail('no lookup needed');
    assert.equal(await isDisposableEmail('someone@Mailinator.com', never), true);
    assert.equal(await isDisposableEmail('someone@sub.trashmail.de', never), true);
  });

  it('fails open when the lookup fails or takes too long', async () => {
    const broken: MxResolver = async () => {
      throw new Error('ESERVFAIL');
    };
    assert.equal(await isDisposableEmail('x@example.org', broken), false);
    const slow: MxResolver = () => new Promise(() => undefined);
    assert.equal(await isDisposableEmail('x@example.org', slow, 20), false);
  });

  it('is false for text without a domain', async () => {
    assert.equal(await isDisposableEmail('nobody', mx('mailinator.com')), false);
    assert.equal(await isDisposableEmail('nobody@', mx('mailinator.com')), false);
  });
});
