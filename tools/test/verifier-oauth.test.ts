// Tests of the OAuth channels (src/verifier/oauth.ts): X, Discord and GitHub against a fake provider
// server on 127.0.0.1 (authorize, token and user endpoints), a fake chain, the real HTTP server. No
// network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { before, describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import { publicCommitment, publicKeyOf, type AttestResult, type Chain, type FieldKey, type FieldKind, type FieldOnChain, type Method } from '../src/verifier/chain.ts';
import { channelRegistry } from '../src/verifier/channels.ts';
import { parseConfig } from '../src/verifier/config.ts';
import type { Ctx } from '../src/verifier/ctx.ts';
import { HttpServer } from '../src/verifier/http.ts';
import { verifierLogger } from '../src/verifier/log.ts';
import { oauthChannels, type Provider } from '../src/verifier/oauth.ts';
import { PacketMemory, privateCommitment, registerPacketRoute } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const SALT = new Uint8Array(32).fill(0x22);
const MINUTE = 60_000;
const FRONT = 'https://identit.ee';
const PUBLIC = 'https://verify.identit.ee';
const SECRETS = { X_CLIENT_SECRET: 'x-SECRET-1', DISCORD_CLIENT_SECRET: 'd-SECRET-2', GITHUB_CLIENT_SECRET: 'g-SECRET-3' };
const ALL_ENV = { X_CLIENT_ID: 'x-id', DISCORD_CLIENT_ID: 'd-id', GITHUB_CLIENT_ID: 'g-id', ...SECRETS };
const KIND: Record<Provider, FieldKind> = { x: 'X', discord: 'Discord', github: 'GitHub' };

let alice: KeyringPair;
let bob: KeyringPair;
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});

class FakeChain implements Chain {
  readonly genesis = GENESIS;
  readonly fields = new Map<string, FieldOnChain>();
  readonly attests: Array<{ address: string; key: FieldKey; commitment: string; method: Method }> = [];
  failures: AttestResult[] = [];

  private slot = (address: string, kind: FieldKind): string => `${u8aToHex(publicKeyOf(address))}/${kind}`;

  decodeAddress(address: string): Uint8Array {
    return publicKeyOf(address);
  }

  setPublic(address: string, kind: FieldKind, value: string): string {
    const commitment = publicCommitment(stringToU8a(value));
    this.fields.set(this.slot(address, kind), { value, private: false, commitment });
    return commitment;
  }

  setPrivate(address: string, kind: FieldKind, value: string): string {
    const commitment = privateCommitment(SALT, stringToU8a(value));
    this.fields.set(this.slot(address, kind), { value: null, private: true, commitment });
    return commitment;
  }

  async field(address: string, key: FieldKey): Promise<FieldOnChain | null> {
    return this.fields.get(this.slot(address, key.Typed)) ?? null;
  }

  async attest(address: string, key: FieldKey, commitment: string, method: Method): Promise<AttestResult> {
    const failure = this.failures.shift();
    if (failure !== undefined) return failure;
    const now = await this.field(address, key);
    if (now === null) return { ok: false, reason: 'gone' };
    if (now.commitment !== commitment) return { ok: false, reason: 'stale' };
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

function makePacket(pair: KeyringPair, kind: FieldKind, value: string) {
  const content = {
    type: 'identitee-verification-packet',
    version: 1,
    chain: GENESIS,
    address: pair.address,
    field: { typed: kind },
    value,
    salt: u8aToHex(SALT),
    commitment: privateCommitment(SALT, stringToU8a(value)),
  };
  return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
}

// --- A fake provider -----------------------------------------------------------------------------------

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  body: URLSearchParams;
}

/** Token and user endpoints of the three providers, under /<provider>/token and /<provider>/user. */
class FakeProvider {
  readonly seen: Seen[] = [];
  /** The account each provider returns. */
  users: Record<Provider, Record<string, unknown>> = {
    x: { data: { id: '1', name: 'Alice', username: 'Alice_X' } },
    discord: { id: '80351110224678912', username: 'alice', global_name: 'Alice' },
    github: { login: 'AliceGH', id: 7 },
  };
  tokenStatus = 200;
  userStatus = 200;
  readonly token = 'ACCESS-TOKEN-xyz';
  private server: Server | undefined;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]!;
        this.seen.push({ path, headers: req.headers, body: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) });
        const [, provider, what] = path.split('/') as [string, Provider, string];
        res.setHeader('content-type', 'application/json');
        if (what === 'token') {
          res.statusCode = this.tokenStatus;
          res.end(JSON.stringify(this.tokenStatus === 200 ? { access_token: this.token, token_type: 'bearer' } : { error: 'invalid_grant' }));
        } else if (what === 'user') {
          const ok = req.headers.authorization === `Bearer ${this.token}`;
          res.statusCode = ok ? this.userStatus : 401;
          res.end(JSON.stringify(ok ? this.users[provider] : { message: 'Bad credentials' }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  calls(provider: Provider, what: 'token' | 'user'): Seen[] {
    return this.seen.filter((s) => s.path === `/${provider}/${what}`);
  }
}

// --- The harness ---------------------------------------------------------------------------------------

interface Answer {
  status: number;
  location: string | null;
  headers: Headers;
  text: string;
}

interface Harness {
  clock: { t: number };
  chain: FakeChain;
  provider: FakeProvider;
  ctx: Ctx;
  lines: string[];
  enabled: string[];
  get(path: string, ip?: string, cookie?: string, extra?: Record<string, string>): Promise<Answer>;
  /** The browser's cookie of each provider, as the last start set it (`name=value`). */
  jar: Map<Provider, string>;
  post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** Start a proof; the URL the service sent the browser to. */
  start(provider: Provider, who: KeyringPair, query?: Record<string, string>): Promise<URL>;
  /** Come back from the provider with a code and the given state, with the jar's cookie unless `cookie` is given (null: none). */
  callback(provider: Provider, query: Record<string, string>, cookie?: string | null): Promise<Answer>;
}

async function withHarness(env: Record<string, string>, run: (h: Harness) => Promise<void>): Promise<void> {
  const clock = { t: 1_800_000_000_000 };
  const chain = new FakeChain();
  const provider = new FakeProvider();
  await provider.start();
  const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', VERIFIER_DEV: '1', STATE_DIRECTORY: '/nonexistent', ...env });
  const lines: string[] = [];
  const log = verifierLogger(cfg, (l) => lines.push(l));
  const store = new Store(':memory:', () => clock.t);
  const ctx: Ctx = { cfg, log, chain, store, packets: new PacketMemory(() => clock.t), now: () => clock.t };
  const endpoints = Object.fromEntries(
    (['x', 'discord', 'github'] as const).map((p) => [p, { authorize: `https://auth.example/${p}/authorize`, token: `${provider.base}/${p}/token`, user: `${provider.base}/${p}/user` }]),
  );
  const server = new HttpServer({ dev: false, log });
  registerPacketRoute(server, ctx);
  const registry = channelRegistry(oauthChannels({ endpoints }), ctx, server);
  await registry.start();
  const port = await server.listen(0, '127.0.0.1');
  const jar = new Map<Provider, string>();
  const get = async (path: string, ip = '198.51.100.7', cookie?: string, extra: Record<string, string> = {}): Promise<Answer> => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip, ...extra };
    if (cookie !== undefined) headers.cookie = cookie;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', headers });
    return { status: r.status, location: r.headers.get('location'), headers: r.headers, text: await r.text() };
  };
  const h: Harness = {
    clock,
    chain,
    provider,
    ctx,
    lines,
    enabled: registry.enabled,
    get,
    jar,
    post: async (path, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    },
    start: async (p, who, query = {}) => {
      const r = await get(`/oauth/${p}/start?${new URLSearchParams({ address: who.address, mode: 'popup', ...query })}`, undefined, undefined, {
        'sec-fetch-site': 'same-site',
        'sec-fetch-dest': 'document',
      });
      assert.equal(r.status, 302, r.text);
      const set = r.headers.get('set-cookie');
      assert.ok(set, 'a browser cookie');
      jar.set(p, set.split(';')[0]!);
      return new URL(r.location!);
    },
    callback: (p, query, cookie) => {
      const sent = cookie === null ? undefined : (cookie ?? jar.get(p));
      return get(`/oauth/${p}/callback?${new URLSearchParams(query)}`, undefined, sent);
    },
  };
  try {
    await run(h);
  } finally {
    await registry.stop();
    await server.close();
    await provider.stop();
    store.close();
  }
}

/** What the popup page posts, read from its script; and the page's checks (CSP nonce, escaping). */
function popup(a: Answer): { message: Record<string, unknown>; origin: string; back: string } {
  assert.match(a.headers.get('content-type') ?? '', /^text\/html/);
  const csp = a.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
  assert.ok(nonce && nonce.length >= 16, csp);
  assert.match(csp, /default-src 'none'/);
  assert.ok(!csp.includes('unsafe-inline'), csp);
  const scripts = [...a.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, a.text);
  assert.equal(scripts[0]![1], ` nonce="${nonce}"`);
  const data = /const data = (.*);\n/.exec(scripts[0]![2]!)?.[1];
  assert.ok(data, scripts[0]![2]);
  assert.ok(!/[<>]/.test(data), 'no raw < or > in the script data');
  // with no opener the page stays where it is: it never sends the answer to the site in an address
  assert.ok(!/location/.test(scripts[0]![2]!), scripts[0]![2]);
  const back = /<a href="([^"]*)">Back to identit\.ee<\/a>/.exec(a.text)?.[1];
  assert.ok(back, a.text);
  return { ...(JSON.parse(data) as { message: Record<string, unknown>; origin: string }), back };
}

/** Run a whole proof: start, then the provider sends the browser back with a code. */
async function prove(h: Harness, p: Provider, who: KeyringPair, query: Record<string, string> = {}): Promise<Answer> {
  const to = await h.start(p, who, query);
  return h.callback(p, { code: 'CODE-abc', state: to.searchParams.get('state')! });
}

// --- Tests ---------------------------------------------------------------------------------------------

describe('oauth: availability', () => {
  it('each provider is enabled only with its id and secret, and otherwise answers 503', async () => {
    await withHarness(ALL_ENV, async (h) => {
      assert.deepEqual(h.enabled, ['x', 'discord', 'github']);
    });
    await withHarness({ X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-SECRET-1', GITHUB_CLIENT_ID: 'g-id' }, async (h) => {
      assert.deepEqual(h.enabled, ['x']);
      for (const p of ['discord', 'github']) {
        for (const path of [`/oauth/${p}/start?address=${alice.address}`, `/oauth/${p}/callback?state=s&code=c`]) {
          const r = await h.get(path);
          assert.equal(r.status, 503);
          assert.deepEqual(JSON.parse(r.text), { error: 'This verification is not available yet.' });
        }
      }
      assert.equal(h.provider.seen.length, 0);
    });
  });
});

describe('oauth: start', () => {
  it('sends the browser to the provider with a random state and a real PKCE challenge', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', '@alice_x');
      const to = await h.start('x', alice);
      assert.equal(`${to.origin}${to.pathname}`, 'https://auth.example/x/authorize');
      const q = to.searchParams;
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('client_id'), 'x-id');
      assert.equal(q.get('redirect_uri'), `${PUBLIC}/oauth/x/callback`);
      assert.equal(q.get('scope'), 'users.read tweet.read');
      assert.equal(q.get('code_challenge_method'), 'S256');
      assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
      assert.match(q.get('state')!, /^[A-Za-z0-9_-]{43}$/);
      const again = await h.start('x', alice);
      assert.notEqual(again.searchParams.get('state'), q.get('state'));
      assert.notEqual(again.searchParams.get('code_challenge'), q.get('code_challenge'));
      // the state is not kept in clear: whoever reads the database cannot finish someone's proof
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(!rows.includes(q.get('state')!), rows);
    });
  });

  it('Discord asks for identify and GitHub for no scope', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'Discord', 'alice');
      h.chain.setPublic(alice.address, 'GitHub', 'AliceGH');
      const d = await h.start('discord', alice);
      assert.equal(d.searchParams.get('scope'), 'identify');
      assert.equal(d.searchParams.get('redirect_uri'), `${PUBLIC}/oauth/discord/callback`);
      assert.equal(d.searchParams.get('client_id'), 'd-id');
      const g = await h.start('github', alice);
      assert.equal(g.searchParams.get('scope'), null);
      assert.equal(g.searchParams.get('redirect_uri'), `${PUBLIC}/oauth/github/callback`);
      assert.equal(g.searchParams.get('client_id'), 'g-id');
    });
  });

  it('refuses a bad mode, and answers an account without the field in the chosen mode', async () => {
    await withHarness(ALL_ENV, async (h) => {
      const bad = await h.get(`/oauth/x/start?address=${alice.address}&mode=iframe`);
      assert.equal(bad.status, 400);
      assert.deepEqual(JSON.parse(bad.text), { error: 'This is not a valid verification mode.' });
      const none = await h.get(`/oauth/x/start?address=${alice.address}&mode=redirect`);
      assert.equal(none.status, 302);
      assert.equal(none.location, `${FRONT}/me?verify_error=${encodeURIComponent('Add your X account to your identity first.')}`);
      const page = popup(await h.get(`/oauth/x/start?address=nope&mode=popup`));
      assert.deepEqual(page.message, { type: 'identitee-verify-error', message: 'This is not a valid account address.' });
      assert.equal(h.ctx.store.dump().items.length, 0);
    });
  });

  it('limits starts to 30 per IP and hour', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      for (let i = 0; i < 30; i++) await h.start('x', alice);
      const r = await h.get(`/oauth/x/start?address=${alice.address}&mode=redirect`);
      assert.equal(r.location, `${FRONT}/me?verify_error=${encodeURIComponent('Too many attempts. Try again later.')}`);
      const other = await h.get(`/oauth/x/start?address=${alice.address}&mode=redirect`, '198.51.100.8');
      assert.equal(other.status, 302);
      assert.ok(other.location!.startsWith('https://auth.example/'));
      h.clock.t += 61 * MINUTE;
      await h.start('x', alice);
    });
  });
});

describe('oauth: a start comes from the site only', () => {
  const FROM_PROFILE = 'Start the verification from your profile on identit.ee.';
  const PROD = { ...ALL_ENV, VERIFIER_DEV: '0' };
  const startWith = (h: Harness, extra: Record<string, string>, mode = 'redirect'): Promise<Answer> =>
    h.get(`/oauth/github/start?address=${alice.address}&mode=${mode}`, undefined, undefined, extra);
  const refused = (h: Harness, r: Answer): void => {
    assert.equal(r.status, 302);
    assert.equal(r.location, `${FRONT}/me?verify_error=${encodeURIComponent(FROM_PROFILE)}`);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(h.ctx.store.dump().items.length, 0);
  };
  const accepted = (r: Answer): void => {
    assert.equal(r.status, 302);
    assert.ok(r.location!.startsWith('https://auth.example/github/authorize'), r.location!);
    assert.ok(r.headers.get('set-cookie'));
  };

  it('refuses cross-site, none (a mailed or typed link) and a missing header in production', async () => {
    await withHarness(PROD, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      refused(h, await startWith(h, { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' }));
      refused(h, await startWith(h, { 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' }));
      refused(h, await startWith(h, {}));
      refused(h, await startWith(h, { 'sec-fetch-dest': 'document' }));
      // a fetch or an image from the site is not a navigation
      refused(h, await startWith(h, { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty' }));
      refused(h, await startWith(h, { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'image' }));
      const page = popup(await startWith(h, { 'sec-fetch-site': 'cross-site' }, 'popup'));
      assert.deepEqual(page.message, { type: 'identitee-verify-error', message: FROM_PROFILE });
      assert.equal(h.ctx.store.dump().items.length, 0);
      assert.equal(h.ctx.store.dump().hits.length, 0, 'a refused start does not count against the limit');
    });
  });

  it('accepts same-site and same-origin navigations in production', async () => {
    await withHarness(PROD, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      accepted(await startWith(h, { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'document' }));
      accepted(await startWith(h, { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }));
      accepted(await startWith(h, { 'sec-fetch-site': 'same-site' }));
    });
  });

  it('accepts a missing header in dev only, never a cross-site one', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      refused(h, await startWith(h, { 'sec-fetch-site': 'cross-site' }));
      accepted(await startWith(h, {}));
    });
  });
});

describe('oauth: callback', () => {
  it('X: the right account attests with OAuth and the popup tells the site, and only the site', async () => {
    await withHarness(ALL_ENV, async (h) => {
      const commitment = h.chain.setPublic(alice.address, 'X', ' @alice_x ');
      const to = await h.start('x', alice);
      const r = await h.callback('x', { code: 'CODE-abc', state: to.searchParams.get('state')! });
      assert.equal(r.status, 200);
      const page = popup(r);
      assert.deepEqual(page.message, { type: 'identitee-verified', channel: 'x' });
      assert.equal(page.origin, FRONT);
      assert.equal(page.back, `${FRONT}/me`);
      assert.ok(r.text.includes('<p>Your X account is verified. You can close this window.</p>'), r.text);
      assert.ok(r.text.includes('window.opener.postMessage(data.message, data.origin)'), r.text);
      assert.ok(r.text.includes('window.close()'));
      assert.ok(!r.text.includes("'*'") && !r.text.includes('"*"'));
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.deepEqual(h.chain.attests, [{ address: alice.address, key: { Typed: 'X' }, commitment, method: 'OAuth' }]);
      // token exchange: Basic auth, PKCE verifier matching the challenge
      const [token] = h.provider.calls('x', 'token');
      assert.ok(token);
      assert.equal(token.headers.authorization, `Basic ${Buffer.from('x-id:x-SECRET-1').toString('base64')}`);
      assert.equal(token.body.get('grant_type'), 'authorization_code');
      assert.equal(token.body.get('code'), 'CODE-abc');
      assert.equal(token.body.get('redirect_uri'), `${PUBLIC}/oauth/x/callback`);
      const verifier = token.body.get('code_verifier')!;
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), to.searchParams.get('code_challenge'));
      assert.equal(token.body.get('client_secret'), null, 'the secret goes in the header for X');
      const [user] = h.provider.calls('x', 'user');
      assert.equal(user!.headers.authorization, `Bearer ${h.provider.token}`);
      assert.equal(h.ctx.store.dump().items.length, 0, 'the state is gone');
    });
  });

  it('redirect mode goes back to /me?verified=<channel>', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      const r = await prove(h, 'github', alice, { mode: 'redirect' });
      assert.equal(r.status, 302);
      assert.equal(r.location, `${FRONT}/me?verified=github`);
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('another account: nothing attested, one sentence naming both accounts', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', '@alice');
      h.provider.users.x = { data: { username: 'bob' } };
      const page = popup(await prove(h, 'x', alice));
      assert.deepEqual(page.message, { type: 'identitee-verify-error', message: 'You signed in to X as @bob, but this identity says @alice.' });
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      h.provider.users.github = { login: 'bobgh' };
      const r = await prove(h, 'github', alice, { mode: 'redirect' });
      assert.equal(r.location, `${FRONT}/me?verify_error=${encodeURIComponent('You signed in to GitHub as @bobgh, but this identity says @alicegh.')}`);
      h.chain.setPublic(alice.address, 'Discord', 'alice');
      h.provider.users.discord = { id: '42', username: 'bob' };
      const d = popup(await prove(h, 'discord', alice));
      assert.equal(d.message.message, 'You signed in to Discord as bob, but this identity says alice.');
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('Discord: matches the username, or the numeric id when the identity holds digits', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'Discord', '80351110224678912');
      assert.equal(popup(await prove(h, 'discord', alice)).message.type, 'identitee-verified');
      h.chain.setPublic(bob.address, 'Discord', 'Alice');
      assert.equal(popup(await prove(h, 'discord', bob)).message.type, 'identitee-verified');
      // a username made of someone's id digits does not pass for that id
      h.chain.setPublic(alice.address, 'Discord', '999');
      h.provider.users.discord = { id: '1', username: '999' };
      assert.equal(popup(await prove(h, 'discord', alice)).message.type, 'identitee-verify-error');
      const [token] = h.provider.calls('discord', 'token');
      assert.equal(token!.body.get('client_id'), 'd-id');
      assert.equal(token!.body.get('client_secret'), 'd-SECRET-2');
      assert.ok(token!.body.get('code_verifier'));
      assert.equal(h.chain.attests.length, 2);
    });
  });

  it('GitHub: asks for JSON from the token endpoint and sends a User-Agent to the API', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', '@AliceGH');
      assert.equal(popup(await prove(h, 'github', alice)).message.type, 'identitee-verified');
      const [token] = h.provider.calls('github', 'token');
      assert.match(String(token!.headers.accept), /application\/json/);
      assert.equal(token!.body.get('client_secret'), 'g-SECRET-3');
      const [user] = h.provider.calls('github', 'user');
      assert.ok(user!.headers['user-agent']);
    });
  });

  it('a state is taken once: a replay, a missing or unknown state, or an expired one are refused', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const to = await h.start('x', alice);
      const state = to.searchParams.get('state')!;
      assert.equal(popup(await h.callback('x', { code: 'CODE-abc', state })).message.type, 'identitee-verified');
      const replay = popup(await h.callback('x', { code: 'CODE-abc', state }));
      assert.deepEqual(replay.message, { type: 'identitee-verify-error', message: 'This verification has expired. Start again.' });
      const missing = popup(await h.callback('x', { code: 'CODE-abc' }));
      assert.equal(missing.message.message, 'This verification has expired. Start again.');
      assert.equal(missing.back, `${FRONT}/me`);
      assert.equal(popup(await h.callback('x', { code: 'c', state: 'A'.repeat(43) })).message.type, 'identitee-verify-error');
      const late = await h.start('x', alice);
      h.clock.t += 11 * MINUTE;
      assert.equal(popup(await h.callback('x', { code: 'c', state: late.searchParams.get('state')! })).message.message, 'This verification has expired. Start again.');
      // a state of another provider does not work here, and nothing is asked of that provider
      const other = await h.start('x', alice);
      const cross = popup(await h.callback('github', { code: 'c', state: other.searchParams.get('state')! }, h.jar.get('x')!.replace('-x=', '-github=')));
      assert.deepEqual(cross.message, { type: 'identitee-verify-error', message: 'This verification has expired. Start again.' });
      assert.equal(h.provider.calls('github', 'token').length, 0);
      assert.equal(h.provider.calls('github', 'user').length, 0);
      assert.equal(h.chain.attests.length, 1);
      assert.equal(h.provider.calls('x', 'token').length, 1);
    });
  });

  it('the provider refused or failed: an error, no token call after a refusal, nothing attested', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const to = await h.start('x', alice, { mode: 'redirect' });
      const denied = await h.callback('x', { error: 'access_denied', error_description: '<b>no</b>', state: to.searchParams.get('state')! });
      assert.equal(denied.location, `${FRONT}/me?verify_error=${encodeURIComponent('The sign-in to X was cancelled.')}`);
      assert.equal(h.provider.seen.length, 0);
      h.provider.tokenStatus = 400;
      assert.equal(popup(await prove(h, 'x', alice)).message.message, 'X did not confirm the sign-in. Try again.');
      h.provider.tokenStatus = 200;
      h.provider.userStatus = 500;
      assert.equal(popup(await prove(h, 'x', alice)).message.message, 'X did not confirm the sign-in. Try again.');
      h.provider.userStatus = 200;
      h.provider.users.x = { data: {} };
      assert.equal(popup(await prove(h, 'x', alice)).message.message, 'X did not confirm the sign-in. Try again.');
      assert.equal(popup(await h.callback('x', { state: (await h.start('x', alice)).searchParams.get('state')! })).message.type, 'identitee-verify-error');
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('the field changed between start and callback: "Your X changed. Verify it again."', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const to = await h.start('x', alice);
      h.chain.setPublic(alice.address, 'X', 'Alice_X ');
      const page = popup(await h.callback('x', { code: 'c', state: to.searchParams.get('state')! }));
      assert.equal(page.message.message, 'Your X changed. Verify it again.');
      // changed to another account: still "changed", not a mismatch with a value the person did not prove against
      const again = await h.start('x', alice);
      h.chain.setPublic(alice.address, 'X', 'carol');
      assert.equal(popup(await h.callback('x', { code: 'c', state: again.searchParams.get('state')! })).message.message, 'Your X changed. Verify it again.');
      h.chain.setPublic(alice.address, 'X', 'Alice_X ');
      // and when the chain itself refuses as stale
      h.chain.failures.push({ ok: false, reason: 'stale' });
      assert.equal(popup(await prove(h, 'x', alice)).message.message, 'Your X changed. Verify it again.');
      h.chain.failures.push({ ok: false, reason: 'failed' });
      assert.equal(popup(await prove(h, 'x', alice)).message.message, 'The verification could not be recorded. Try again in a moment.');
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('a private field: proved by its packet id, attests the private commitment, never shows or keeps the value', async () => {
    await withHarness(ALL_ENV, async (h) => {
      const commitment = h.chain.setPrivate(alice.address, 'GitHub', 'secret-alicegh');
      h.provider.users.github = { login: 'Secret-AliceGH' };
      const without = popup(await h.get(`/oauth/github/start?address=${alice.address}&mode=popup`));
      assert.equal(without.message.message, 'Unlock your identity to verify a private GitHub account.');
      const inline = popup(await h.get(`/oauth/github/start?${new URLSearchParams({ address: alice.address, mode: 'popup', packet: JSON.stringify(makePacket(alice, 'GitHub', 'secret-alicegh')) })}`));
      assert.equal(inline.message.message, 'This verification has expired. Start again.');
      const { json } = await h.post('/api/packet', { address: alice.address, packet: makePacket(alice, 'GitHub', 'secret-alicegh') });
      const id = String(json.id);
      const to = await h.start('github', alice, { packet: id });
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(rows.includes(id) && !rows.toLowerCase().includes('secret-alicegh'), rows);
      assert.equal(popup(await h.callback('github', { code: 'c', state: to.searchParams.get('state')! })).message.type, 'identitee-verified');
      assert.deepEqual(h.chain.attests, [{ address: alice.address, key: { Typed: 'GitHub' }, commitment, method: 'OAuth' }]);
      // another account: the sentence does not echo the private value
      h.provider.users.github = { login: 'bobgh' };
      const r = await prove(h, 'github', alice, { packet: id });
      const page = popup(r);
      assert.equal(page.message.message, 'You signed in to GitHub as @bobgh, but this identity says something else.');
      assert.ok(!r.text.toLowerCase().includes('secret-alicegh'));
      assert.ok(!h.lines.join('').toLowerCase().includes('secret-alicegh'));
      // a packet id for another field or another account is refused
      const x = popup(await h.get(`/oauth/x/start?${new URLSearchParams({ address: alice.address, mode: 'popup', packet: id })}`));
      assert.equal(x.message.type, 'identitee-verify-error');
    });
  });

  it('escapes what the provider and the chain say in the page and the script', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', '<img src=x onerror=alert(1)>');
      h.provider.users.x = { data: { username: '</script><script>alert(2)</script>' } };
      const r = await prove(h, 'x', alice);
      const page = popup(r);
      assert.equal(page.message.message, 'You signed in to X as @</script><script>alert(2)</script>, but this identity says @<img src=x onerror=alert(1)>.');
      assert.ok(!r.text.includes('<img'), r.text);
      assert.ok(!r.text.includes('<script>alert'), r.text);
      assert.ok(r.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });
  });

  it('posts only to the configured front origin, a local one only in dev', async () => {
    await withHarness({ ...ALL_ENV, VERIFIER_FRONT_ORIGIN: 'http://localhost:5173', VERIFIER_PUBLIC_URL: 'http://127.0.0.1:8787' }, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const to = await h.start('x', alice);
      assert.equal(to.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/oauth/x/callback');
      const page = popup(await h.callback('x', { code: 'c', state: to.searchParams.get('state')! }));
      assert.equal(page.origin, 'http://localhost:5173');
      assert.equal(page.back, 'http://localhost:5173/me');
    });
    assert.throws(() => parseConfig({ IDENTITEE_VERIFIER_SURI: '//A', STATE_DIRECTORY: '/x', VERIFIER_FRONT_ORIGIN: 'http://localhost:5173' }), /VERIFIER_FRONT_ORIGIN/);
    assert.throws(() => parseConfig({ IDENTITEE_VERIFIER_SURI: '//A', STATE_DIRECTORY: '/x', VERIFIER_FRONT_ORIGIN: 'https://identit.ee/me' }), /VERIFIER_FRONT_ORIGIN/);
    assert.throws(() => parseConfig({ IDENTITEE_VERIFIER_SURI: '//A', STATE_DIRECTORY: '/x', VERIFIER_PUBLIC_URL: 'http://verify.identit.ee' }), /VERIFIER_PUBLIC_URL/);
    const prod = parseConfig({ IDENTITEE_VERIFIER_SURI: '//A', STATE_DIRECTORY: '/x' });
    assert.deepEqual([prod.frontOrigin, prod.publicUrl], [FRONT, PUBLIC]);
  });

  it('binds the flow to the browser that started it: a forwarded link finishes nothing', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'GitHub', 'alicegh');
      // the cookie set at the start
      const first = await h.get(`/oauth/github/start?address=${alice.address}&mode=popup`);
      const set = first.headers.get('set-cookie')!;
      const [pair, ...attrs] = set.split(';').map((a) => a.trim());
      assert.match(pair!, /^__Host-identitee-oauth-github=[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(attrs.sort(), ['HttpOnly', 'Max-Age=600', 'Path=/', 'SameSite=Lax', 'Secure']);
      const value = pair!.split('=')[1]!;
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(!rows.includes(value), 'only a hash of the cookie is kept');
      const state = (s: Answer): string => new URL(s.location!).searchParams.get('state')!;
      // no cookie: refused, nothing asked of the provider, nothing attested, the state is gone
      const none = popup(await h.callback('github', { code: 'c', state: state(first) }, null));
      assert.deepEqual(none.message, { type: 'identitee-verify-error', message: 'This verification was started in another browser. Start again.' });
      assert.equal(popup(await h.callback('github', { code: 'c', state: state(first) }, pair)).message.message, 'This verification has expired. Start again.');
      // the cookie of another flow (Mallory forwards her link; the victim's browser has its own flow's cookie)
      const mallory = await h.get(`/oauth/github/start?address=${alice.address}&mode=redirect`);
      const victim = await h.get(`/oauth/github/start?address=${alice.address}&mode=redirect`);
      const victimCookie = victim.headers.get('set-cookie')!.split(';')[0]!;
      const other = await h.callback('github', { code: 'c', state: state(mallory) }, victimCookie);
      assert.equal(other.location, `${FRONT}/me?verify_error=${encodeURIComponent('This verification was started in another browser. Start again.')}`);
      assert.match(other.headers.get('set-cookie') ?? '', /^__Host-identitee-oauth-github=; .*Max-Age=0/);
      // a cookie of another name with the right value does not count either
      const third = await h.get(`/oauth/github/start?address=${alice.address}&mode=popup`);
      const thirdValue = third.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
      assert.equal(popup(await h.callback('github', { code: 'c', state: state(third) }, `identitee-oauth-github=${thirdValue}`)).message.type, 'identitee-verify-error');
      assert.equal(h.provider.seen.length, 0);
      assert.equal(h.chain.attests.length, 0);
      // the matching cookie: attested, and the cookie is cleared
      const ok = await h.callback('github', { code: 'c', state: state(victim) }, `other=1; ${victimCookie}`);
      assert.equal(ok.location, `${FRONT}/me?verified=github`);
      assert.match(ok.headers.get('set-cookie') ?? '', /^__Host-identitee-oauth-github=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
      assert.equal(h.chain.attests.length, 1);
    });
  });

  it('in dev over plain http the cookie is not Secure (a browser would drop it), and still required', async () => {
    await withHarness({ ...ALL_ENV, VERIFIER_PUBLIC_URL: 'http://127.0.0.1:8787' }, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const r = await h.get(`/oauth/x/start?address=${alice.address}&mode=popup`);
      const set = r.headers.get('set-cookie')!;
      assert.match(set, /^identitee-oauth-x=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
      const state = new URL(r.location!).searchParams.get('state')!;
      assert.equal(popup(await h.callback('x', { code: 'c', state }, null)).message.type, 'identitee-verify-error');
      assert.equal(popup(await prove(h, 'x', alice)).message.type, 'identitee-verified');
    });
  });

  it('a chain that fails ends on the person\'s page, with the error class only in the log', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      const field = h.chain.field.bind(h.chain);
      h.chain.field = async () => {
        throw new TypeError('boom secret-detail');
      };
      const started = await h.get(`/oauth/x/start?address=${alice.address}&mode=redirect`);
      assert.equal(started.location, `${FRONT}/me?verify_error=${encodeURIComponent('The verification could not be recorded. Try again in a moment.')}`);
      h.chain.field = field;
      const to = await h.start('x', alice);
      h.chain.field = async () => {
        throw new TypeError('boom secret-detail');
      };
      const r = await h.callback('x', { code: 'c', state: to.searchParams.get('state')! });
      assert.equal(popup(r).message.message, 'The verification could not be recorded. Try again in a moment.');
      assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
      const out = h.lines.join('');
      assert.ok(out.includes('oauth-failed') && out.includes('TypeError'), out);
      assert.ok(!out.includes('secret-detail'), out);
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('never logs or keeps a token, a code, a secret or a PKCE verifier', async () => {
    await withHarness(ALL_ENV, async (h) => {
      h.chain.setPublic(alice.address, 'X', 'alice_x');
      await prove(h, 'x', alice);
      h.provider.users.x = { data: { username: 'bob' } };
      await prove(h, 'x', alice);
      h.provider.tokenStatus = 500;
      await prove(h, 'x', alice);
      const verifiers = h.provider.calls('x', 'token').map((t) => t.body.get('code_verifier')!);
      const out = h.lines.join('');
      for (const secret of [h.provider.token, 'CODE-abc', ...Object.values(SECRETS), ...verifiers]) assert.ok(!out.includes(secret), secret);
      assert.ok(out.includes('oauth-verified') && out.includes('oauth-refused'), out);
      const rows = JSON.stringify(h.ctx.store.dump());
      assert.ok(!rows.includes(h.provider.token) && !rows.includes('CODE-abc'));
    });
  });
});
