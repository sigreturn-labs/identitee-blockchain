// Tests of the verifier core (src/verifier/*) against a stub node: no network, no chain. The
// channel test files build on these helpers.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { blake2AsHex, cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { LiveChain, explain, publicCommitment, type Chain, type FieldKey } from '../src/verifier/chain.ts';
import { channelRegistry, type Channel } from '../src/verifier/channels.ts';
import { parseConfig, type Config } from '../src/verifier/config.ts';
import { clientIp, HttpError, HttpServer } from '../src/verifier/http.ts';
import { verifierLogger } from '../src/verifier/log.ts';
import { main } from '../src/verifier/main.ts';
import { sameHandle } from '../src/verifier/normalize.ts';
import { checkPacket, PacketMemory, privateCommitment, registerPacketRoute, resolvePrivate } from '../src/verifier/packet.ts';
import { Store } from '../src/verifier/store.ts';
import type { Ctx } from '../src/verifier/ctx.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const OTHER_GENESIS = `0x${'cd'.repeat(32)}`;
const SALT = new Uint8Array(32).fill(0x11);
// The runtime's frozen test vector (a Telegram handle), shared with the web tests: do not change it.
const VALUE = '@alice';
const hex = (text: string): string => u8aToHex(stringToU8a(text));

let alice: KeyringPair;
let bob: KeyringPair;
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});
const pk = (pair: KeyringPair): string => u8aToHex(pair.publicKey);

// --- Configuration and logging -------------------------------------------------------------------

describe('configuration', () => {
  it('needs the key, and a state directory outside development', () => {
    assert.throws(() => parseConfig({}), /IDENTITEE_VERIFIER_SURI is not set/);
    assert.throws(() => parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice' }), /STATE_DIRECTORY is not set/);
    const dev = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', VERIFIER_DEV: '1' });
    assert.equal(dev.stateDir, './.verifier-state');
    assert.equal(dev.ws, 'ws://127.0.0.1:9944');
    assert.equal(dev.port, 8787);
    assert.equal(dev.dev, true);
    const prod = parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', STATE_DIRECTORY: '/var/lib/x', VERIFIER_PORT: '9000', IDENTITEE_WS: 'ws://n:1' });
    assert.deepEqual([prod.stateDir, prod.port, prod.ws, prod.dev], ['/var/lib/x', 9000, 'ws://n:1', false]);
    assert.throws(() => parseConfig({ IDENTITEE_VERIFIER_SURI: '//A', VERIFIER_DEV: '1', VERIFIER_PORT: 'eighty' }), /VERIFIER_PORT/);
  });

  it('keeps the channel variables, and lists every secret one for the logger', () => {
    const cfg = parseConfig({
      IDENTITEE_VERIFIER_SURI: 'phrase words',
      VERIFIER_DEV: '1',
      X_CLIENT_ID: 'xid',
      X_CLIENT_SECRET: 'xsecret',
      TELEGRAM_BOT_TOKEN: '123:tok',
      MATRIX_PASSWORD: 'mpass',
      DIDIT_WEBHOOK_SECRET: '',
      UNRELATED: 'nope',
    });
    assert.equal(cfg.env.X_CLIENT_ID, 'xid');
    assert.equal((cfg.env as Record<string, unknown>).UNRELATED, undefined);
    assert.equal(cfg.env.DIDIT_WEBHOOK_SECRET, undefined, 'an empty variable is a missing one');
    for (const secret of ['phrase words', 'xsecret', '123:tok', 'mpass']) assert.ok(cfg.secrets.includes(secret), secret);
    assert.ok(!cfg.secrets.includes('xid'));
  });

  it('the logger never prints a secret, even inside a longer text or escaped', () => {
    const cfg = parseConfig({ IDENTITEE_VERIFIER_SURI: 'my "secret" phrase', VERIFIER_DEV: '1', RESEND_API_KEY: 're_KEY123' });
    const lines: string[] = [];
    const log = verifierLogger(cfg, (l) => lines.push(l));
    log('error', 'oops', { error: 'bad key re_KEY123 for my "secret" phrase', url: 'https://x/?k=re_KEY123' });
    const out = lines.join('');
    assert.ok(!out.includes('re_KEY123') && !out.includes('secret'), out);
    assert.equal(JSON.parse(lines[0]!).event, 'oops');
  });
});

// --- Handles ---------------------------------------------------------------------------------------

describe('sameHandle', () => {
  const cases: Array<[Parameters<typeof sameHandle>[0], string, Parameters<typeof sameHandle>[2], boolean]> = [
    ['X', '@Alice', 'alice', true],
    ['X', ' alice ', '@ALICE', true],
    ['X', 'alice', 'bob', false],
    ['X', '', '', false],
    ['GitHub', 'Octo-Cat', 'octo-cat', true],
    ['GitHub', 'octocat', 'octocat2', false],
    ['Telegram', '@carol_test', 'Carol_Test', true],
    ['Telegram', '@carol test', 'caroltest', true],
    ['Discord', 'alice', { username: 'Alice', id: '42' }, true],
    ['Discord', '123456', { username: 'alice', id: '123456' }, true],
    ['Discord', '123456', { username: 'alice', id: '1234567' }, false],
    ['Discord', 'bob', { username: 'alice', id: '1' }, false],
    // an all-digit value is an id: never matched by a username of the same digits
    ['Discord', '123456789012345678', { username: '123456789012345678', id: '999' }, false],
    ['Discord', '@123456789012345678', { username: 'x', id: '123456789012345678' }, true],
    ['Discord', '123456789012345678', '123456789012345678', false],
    // a name is a name: never matched by the id
    ['Discord', 'alice', { username: 'bob', id: 'alice' }, false],
    ['Discord', 'Alice', { username: 'alice', id: '42' }, true],
    ['Matrix', '@a:matrix.org', '@A:Matrix.org', true],
    ['Matrix', 'a:matrix.org', '@a:matrix.org', true],
    ['Matrix', '@a:matrix.org', '@a:other.org', false],
    ['Matrix', 'a', '@a:matrix.org', false],
    ['Email', 'Me@Example.org ', 'me@example.org', true],
    // a profile's address, on the provider's own host only
    ['X', 'https://x.com/Carol', 'carol', true],
    ['X', 'x.com/carol', 'carol', true],
    ['X', 'twitter.com/carol/', 'carol', true],
    ['X', 'https://twitter.com/carol?s=21&t=abc', 'carol', true],
    ['X', 'https://x.com/@carol', 'carol', true],
    ['X', 'https://x.com/carol', 'bob', false],
    ['X', 'evilx.com/carol', 'carol', false],
    ['X', 'https://evilx.com/carol', 'carol', false],
    ['X', 'x.com.evil.com/carol', 'carol', false],
    ['X', 'https://x.com@evil.com/carol', 'carol', false],
    ['X', 'http://x.com/carol', 'carol', false],
    ['X', 'www.x.com/carol', 'carol', false],
    ['X', 'x.com/carol/status/1', 'carol', false],
    ['X', 'x.com/carol#top', 'carol', false],
    ['X', 'github.com/carol', 'carol', false],
    ['X', 'https://x.com/', 'x.com', false],
    ['GitHub', 'https://github.com/Octo-Cat', 'octo-cat', true],
    ['GitHub', 'github.com/octocat/', 'octocat', true],
    ['GitHub', 'gist.github.com/octocat', 'octocat', false],
    ['GitHub', 'x.com/octocat', 'octocat', false],
    ['Telegram', 't.me/carol_test', 'carol_test', true],
    ['Telegram', 'https://t.me/carol_test', 'carol_test', true],
    ['Telegram', 'https://evilt.me/carol_test', 'carol_test', false],
    ['Telegram', 'telegram.me/carol_test', 'carol_test', false],
    ['Discord', 'discord.com/users/123456', { username: 'x', id: '123456' }, false],
    ['Matrix', 'https://matrix.to/#/@a:matrix.org', '@a:matrix.org', true],
    ['Matrix', 'matrix.to/#/@a:matrix.org', '@a:matrix.org', true],
    ['Matrix', 'https://matrix.to/#/@a:matrix.org', '@a:other.org', false],
    ['Matrix', 'https://evil.to/#/@a:matrix.org', '@a:matrix.org', false],
    ['Matrix', 'https://matrix.to.evil/#/@a:matrix.org', '@a:matrix.org', false],
  ];
  for (const [channel, onChain, account, expected] of cases) {
    it(`${channel}: ${JSON.stringify(onChain)} vs ${JSON.stringify(account)} is ${expected}`, () => {
      assert.equal(sameHandle(channel, onChain, account), expected);
    });
  }
});

// --- Store -----------------------------------------------------------------------------------------

describe('store', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('keeps a row until it expires', () => {
    const c = clock();
    const store = new Store(':memory:', c.now);
    store.put('code', 'a', { code: '123456' }, 1000);
    assert.deepEqual(store.get('code', 'a'), { code: '123456' });
    c.advance(999);
    assert.deepEqual(store.get('code', 'a'), { code: '123456' });
    c.advance(1);
    assert.equal(store.get('code', 'a'), null);
    assert.equal(store.take('code', 'a'), null);
    store.close();
  });

  it('take gives a row once', () => {
    const store = new Store(':memory:', () => 0);
    store.put('tg', 't1', { who: 'x' }, 60_000);
    assert.deepEqual(store.take('tg', 't1'), { who: 'x' });
    assert.equal(store.take('tg', 't1'), null);
    assert.equal(store.get('tg', 't1'), null);
    store.close();
  });

  it('separates kinds, replaces on put, and counts attempts', () => {
    const store = new Store(':memory:', () => 0);
    store.put('a', 'id', 1, 1000);
    store.put('b', 'id', 2, 1000);
    assert.equal(store.get('a', 'id'), 1);
    assert.equal(store.get('b', 'id'), 2);
    assert.equal(store.bump('a', 'id'), 1);
    assert.equal(store.bump('a', 'id'), 2);
    assert.equal(store.bump('a', 'missing'), null);
    store.put('a', 'id', 3, 1000);
    assert.equal(store.bump('a', 'id'), 1, 'a new row starts again');
    store.close();
  });

  it('hit allows `limit` hits in a sliding window, per bucket and key', () => {
    const c = clock();
    const store = new Store(':memory:', c.now);
    for (let i = 0; i < 3; i++) assert.equal(store.hit('send', 'addr', 3, 10_000), true);
    assert.equal(store.hit('send', 'addr', 3, 10_000), false);
    assert.equal(store.hit('send', 'other', 3, 10_000), true);
    assert.equal(store.hit('start', 'addr', 3, 10_000), true);
    c.advance(10_001);
    assert.equal(store.hit('send', 'addr', 3, 10_000), true);
    store.close();
  });

  it('count reads the window without counting, record counts without a limit', () => {
    const c = clock();
    const store = new Store(':memory:', c.now);
    assert.equal(store.count('send', 'addr', 10_000), 0);
    store.record('send', 'addr', 10_000);
    store.record('send', 'addr', 10_000);
    store.record('send', 'other', 10_000);
    assert.equal(store.count('send', 'addr', 10_000), 2);
    assert.equal(store.count('send', 'addr', 10_000), 2, 'reading does not count');
    assert.equal(store.hit('send', 'addr', 3, 10_000), true, 'a recorded hit weighs as a hit');
    assert.equal(store.hit('send', 'addr', 3, 10_000), false);
    c.advance(10_001);
    assert.equal(store.count('send', 'addr', 10_000), 0);
    store.close();
  });

  it('sweep deletes what expired', () => {
    const c = clock();
    const store = new Store(':memory:', c.now);
    store.put('a', '1', 1, 1000);
    store.put('a', '2', 2, 5000);
    store.hit('b', 'k', 5, 1000);
    c.advance(2000);
    assert.equal(store.sweep(), 2);
    assert.equal(store.get('a', '2'), 2);
    store.close();
  });
});

// --- A stub node -----------------------------------------------------------------------------------

interface Sent {
  call: string;
  args: unknown[];
}

function stubApi(options: {
  profiles?: Map<string, unknown>;
  dispatchError?: (call: string, args: unknown[]) => string | undefined;
  poolError?: boolean;
  delayMs?: number;
  agent?: [number, number] | null;
  spec?: string;
}) {
  const sent: Sent[] = [];
  let upgrade: ((spec: number) => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  const makeTx = (call: string) => (...args: unknown[]) => ({
    signAndSend: (_pair: unknown, callback: (result: unknown) => void) => {
      sent.push({ call, args });
      if (options.poolError) return Promise.reject(new Error('1010: Invalid Transaction: Custom error: 0'));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        const error = options.dispatchError?.(call, args);
        callback({
          isError: false,
          status: { isInBlock: true, asInBlock: { toHex: () => '0xb10c' } },
          events: error === undefined ? [{ event: { section: 'identitee', method: 'Judged' } }] : [],
          dispatchError: error !== undefined ? { isModule: true, asModule: error } : undefined,
        });
      }, options.delayMs ?? 5);
      return Promise.resolve(() => undefined);
    },
  });
  const api = {
    genesisHash: { toHex: () => GENESIS },
    runtimeVersion: { specName: { toString: () => options.spec ?? 'identitee' }, specVersion: { toNumber: () => 10 } },
    rpc: {
      state: {
        subscribeRuntimeVersion: async (callback: (v: unknown) => void) => {
          upgrade = (spec) => callback({ specVersion: { toNumber: () => spec } });
          return () => undefined;
        },
      },
    },
    registry: {
      signedExtensions: [],
      findMetaError: (error: string) => {
        const [section, name] = error.split('.');
        return { section, name };
      },
    },
    call: { identiteeApi: { profile: async (key: string) => ({ toJSON: () => options.profiles?.get(key) ?? null }) } },
    query: { identitee: { agents: async () => ({ toJSON: () => (options.agent === undefined ? [0, 3] : options.agent) }) } },
    tx: { identitee: { provideJudgement: makeTx('provideJudgement'), grantFact: makeTx('grantFact') } },
    disconnect: async () => undefined,
  } as unknown as ApiPromise;
  return { api, sent, maxInFlight: () => maxInFlight, upgrade: (spec: number) => upgrade?.(spec) };
}

const profileWith = (typed: Record<string, unknown>) => ({ identity: { typed, custom: {}, links: [] }, attestations: [], facts: [] });

// --- Chain -----------------------------------------------------------------------------------------

describe('chain', () => {
  const quiet = () => undefined;
  const KEY: FieldKey = { Typed: 'Email' };

  it('reads a public field, a PGP fingerprint, a private field, and nothing', async () => {
    const pgp = `0x${'AB'.repeat(20)}`;
    const commitment = `0x${'22'.repeat(32)}`;
    const profiles = new Map<string, unknown>([[pk(alice), profileWith({ Email: { public: hex('me@example.org') }, Pgp: { public: pgp }, Telegram: { private: commitment } })]]);
    const chain = new LiveChain(stubApi({ profiles }).api, alice, quiet);
    assert.deepEqual(await chain.field(alice.address, KEY), {
      value: 'me@example.org',
      private: false,
      commitment: blake2AsHex(u8aConcat(stringToU8a('identitee:field:public:v1'), stringToU8a('me@example.org')), 256),
    });
    assert.deepEqual(await chain.field(alice.address, { Typed: 'Pgp' }), { value: 'ab'.repeat(20), private: false, commitment: publicCommitment(hexToU8a(pgp)) });
    assert.deepEqual(await chain.field(alice.address, { Typed: 'Telegram' }), { value: null, private: true, commitment });
    assert.equal(await chain.field(alice.address, { Typed: 'X' }), null);
    assert.equal(await chain.field(bob.address, KEY), null);
  });

  it('matches the public commitment of the runtime vectors', () => {
    // web/test/formulas.test.ts, from pallets/identitee/src/tests/vectors.rs
    assert.equal(publicCommitment(stringToU8a('user@example.org')), '0xdc14c71338942896bacc3cfe9c20c4f68b1150264e73dd06af1822602513ea23');
    assert.equal(privateCommitment(SALT, stringToU8a(VALUE)), '0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0');
  });

  it('accepts an address of any prefix and gives the account bytes', () => {
    const chain = new LiveChain(stubApi({}).api, alice, quiet);
    assert.deepEqual(chain.decodeAddress(encodeAddress(alice.publicKey, 0)), alice.publicKey);
    assert.deepEqual(chain.decodeAddress(alice.address), alice.publicKey);
    assert.throws(() => chain.decodeAddress('nope'));
    assert.equal(chain.genesis, GENESIS);
  });

  it('sends provide_judgement with the expected commitment and the method, as Verified without expiry', async () => {
    const stub = stubApi({});
    const chain = new LiveChain(stub.api, alice, quiet);
    assert.deepEqual(await chain.attest(bob.address, KEY, `0x${'01'.repeat(32)}`, 'EmailCode'), { ok: true });
    assert.deepEqual(stub.sent, [{ call: 'provideJudgement', args: [pk(bob), { Typed: 'Email' }, `0x${'01'.repeat(32)}`, 'Verified', 'EmailCode', null] }]);
    assert.deepEqual(await chain.grantDocument(bob.address), { ok: true });
    assert.deepEqual(stub.sent[1], { call: 'grantFact', args: [pk(bob), 'DocumentChecked', null, 'Unspecified', '0x'] });
  });

  it('maps the runtime refusals to stale, gone and failed', async () => {
    for (const [error, reason] of [
      ['identitee.StaleCommitment', 'stale'],
      ['identitee.FieldNotFound', 'gone'],
      ['identitee.NoIdentity', 'gone'],
      ['identitee.NotAgent', 'failed'],
    ] as const) {
      const chain = new LiveChain(stubApi({ dispatchError: () => error }).api, alice, quiet);
      const out = await chain.attest(bob.address, KEY, GENESIS, 'EmailCode');
      assert.equal(out.ok, false);
      assert.equal(!out.ok && out.reason, reason, error);
      if (reason === 'failed') assert.equal(!out.ok && out.detail, error);
    }
    const pool = new LiveChain(stubApi({ poolError: true }).api, alice, quiet);
    assert.deepEqual(await pool.attest(bob.address, KEY, GENESIS, 'OAuth'), { ok: false, reason: 'failed', detail: '1010: Invalid Transaction: Custom error: 0' });
  });

  it('says a stale or gone field in one sentence', () => {
    assert.equal(explain({ Typed: 'Email' }, { ok: false, reason: 'stale' }), 'Your Email changed. Verify it again.');
    assert.equal(explain({ Typed: 'Web' }, { ok: false, reason: 'gone' }), 'Your Website is no longer on your identity.');
    assert.match(explain({ Typed: 'X' }, { ok: false, reason: 'failed', detail: 'x' }), /^The verification could not be recorded\./);
  });

  it('runs two submissions one after the other', async () => {
    const stub = stubApi({ delayMs: 20 });
    const chain = new LiveChain(stub.api, alice, quiet);
    const results = await Promise.all([chain.attest(bob.address, KEY, GENESIS, 'MatrixChallenge'), chain.attest(alice.address, KEY, GENESIS, 'EmailCode')]);
    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    assert.equal(stub.maxInFlight(), 1);
    assert.deepEqual(stub.sent.map((s) => s.args[4]), ['MatrixChallenge', 'EmailCode']);
  });

  it('a failed submission does not stop the queue', async () => {
    let first = true;
    const stub = stubApi({ dispatchError: () => (first ? ((first = false), 'identitee.StaleCommitment') : undefined) });
    const chain = new LiveChain(stub.api, alice, quiet);
    const [a, b] = await Promise.all([chain.attest(bob.address, KEY, GENESIS, 'OAuth'), chain.attest(bob.address, KEY, GENESIS, 'OAuth')]);
    assert.deepEqual([a, b], [{ ok: false, reason: 'stale' }, { ok: true }]);
  });

  it('check refuses a node that is not identitee and an agent without the capabilities', async () => {
    await assert.rejects(new LiveChain(stubApi({ spec: 'polkadot' }).api, alice, quiet).check(), /not identitee/);
    await assert.rejects(new LiveChain(stubApi({ agent: null }).api, alice, quiet).check(), /not an agent/);
    await assert.rejects(new LiveChain(stubApi({ agent: [0, 1] }).api, alice, quiet).check(), /capabilities/);
    await new LiveChain(stubApi({}).api, alice, quiet).check();
  });
});

// --- The packet of a private field -----------------------------------------------------------------

/** A packet as web/src/chain/packet.ts makePacket builds it, signed as a wallet does. */
function makePacket(pair: KeyringPair, overrides: { chain?: string; field?: unknown; value?: string; salt?: Uint8Array; commitment?: string; address?: string } = {}) {
  const salt = overrides.salt ?? SALT;
  const value = overrides.value ?? VALUE;
  const content = {
    type: 'identitee-verification-packet',
    version: 1,
    chain: overrides.chain ?? GENESIS,
    address: overrides.address ?? pair.address,
    field: overrides.field ?? { typed: 'Telegram' },
    value,
    salt: u8aToHex(salt),
    commitment: overrides.commitment ?? privateCommitment(salt, value.startsWith('0x') ? hexToU8a(value) : stringToU8a(value)),
  };
  return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
}

describe('checkPacket', () => {
  const TG: FieldKey = { Typed: 'Telegram' };
  const chainHolding = (typed: Record<string, unknown>, who = alice) => new LiveChain(stubApi({ profiles: new Map([[pk(who), profileWith(typed)]]) }).api, bob, () => undefined);
  const onChain = () => privateCommitment(SALT, stringToU8a(VALUE));

  it('accepts the web vector: signed by the account, for this chain and field, matching the chain', async () => {
    const packet = makePacket(alice);
    assert.equal(packet.commitment, '0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0');
    const chain = chainHolding({ Telegram: { private: onChain() } });
    assert.deepEqual(await checkPacket(packet, chain, { address: alice.address, key: TG }), { value: VALUE, commitment: onChain() });
    // also as pasted text, and with the address of another prefix
    assert.deepEqual(await checkPacket(JSON.stringify(packet), chain, { address: encodeAddress(alice.publicKey, 0), key: TG }), { value: VALUE, commitment: onChain() });
  });

  it('gives a PGP fingerprint as lowercase hex', async () => {
    const fp = new Uint8Array(20).fill(0xab);
    const packet = makePacket(alice, { field: { typed: 'Pgp' }, value: u8aToHex(fp) });
    const chain = chainHolding({ Pgp: { private: privateCommitment(SALT, fp) } });
    assert.deepEqual(await checkPacket(packet, chain, { address: alice.address, key: { Typed: 'Pgp' } }), { value: 'ab'.repeat(20), commitment: privateCommitment(SALT, fp) });
  });

  it('refuses a wrong signer, a wrong genesis, a wrong salt, another field, a public field', async () => {
    const chain = chainHolding({ Telegram: { private: onChain() } });
    const expected = { address: alice.address, key: TG };
    assert.deepEqual(await checkPacket(makePacket(bob), chain, expected), { error: 'This packet is signed by another account.' });
    // signed by bob but naming alice
    assert.deepEqual(await checkPacket(makePacket(bob, { address: alice.address }), chain, expected), { error: 'The signature of this packet does not match the account.' });
    assert.deepEqual(await checkPacket(makePacket(alice, { chain: OTHER_GENESIS }), chain, expected), { error: 'This packet was made for another chain.' });
    assert.deepEqual(await checkPacket(makePacket(alice, { salt: new Uint8Array(32).fill(0x12) }), chain, expected), {
      error: 'This packet does not match your Telegram on chain. It may have changed: verify it again.',
    });
    assert.deepEqual(await checkPacket(makePacket(alice, { field: { typed: 'Email' } }), chain, expected), { error: 'This packet is for Email, not Telegram.' });
    assert.deepEqual(await checkPacket(makePacket(alice), chainHolding({ Telegram: { public: hex(VALUE) } }), expected), { error: 'Your Telegram is public now: verify it without a packet.' });
    assert.deepEqual(await checkPacket(makePacket(alice), chainHolding({}), expected), { error: 'Your Telegram is no longer on your identity.' });
  });

  it('refuses a commitment the value and salt do not give, and anything that is not a packet', async () => {
    const chain = chainHolding({ Telegram: { private: onChain() } });
    const expected = { address: alice.address, key: TG };
    assert.deepEqual(await checkPacket(makePacket(alice, { commitment: `0x${'00'.repeat(32)}` }), chain, expected), { error: 'The value and salt do not give the commitment of the packet.' });
    for (const bad of ['', 'hello', '[]', '{}', 42, null, { ...makePacket(alice), extra: 1 }, { ...makePacket(alice), version: 2 }]) {
      const out = await checkPacket(bad, chain, expected);
      assert.ok('error' in out && out.error.endsWith('.'), JSON.stringify(out));
    }
    const tampered = { ...makePacket(alice), value: '@someone' };
    assert.deepEqual(await checkPacket(tampered, chain, expected), { error: 'The signature of this packet does not match the account.' });
  });
});

// --- HTTP ------------------------------------------------------------------------------------------

describe('http', () => {
  let server: HttpServer;
  let base: string;
  const logs: string[] = [];
  before(async () => {
    server = new HttpServer({ dev: false, log: (_l, event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
    server.route('GET', '/api/echo', (req) => ({ ip: req.ip, q: req.query.get('q') }));
    server.route('POST', '/api/echo', (req) => ({ body: req.body }));
    server.route('POST', '/api/refuse', () => {
      throw new HttpError(409, 'That is not possible now.');
    });
    server.route('GET', '/api/boom', () => {
      throw new Error('secret-123');
    });
    const port = await server.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });
  after(() => server.close());

  it('answers JSON, with errors as one sentence', async () => {
    const r = await fetch(`${base}/api/echo?q=1`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ip: '127.0.0.1', q: '1' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const post = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.deepEqual(await post.json(), { body: { a: 1 } });
    const refused = await fetch(`${base}/api/refuse`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'That is not possible now.' });
    const boom = await fetch(`${base}/api/boom`);
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'Something went wrong. Try again in a moment.' });
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/nope`)).json(), { error: 'There is nothing here.' });
    assert.equal((await fetch(`${base}/api/refuse`)).status, 405);
    const bad = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret-value' });
    assert.equal(bad.status, 400);
    assert.ok(!logs.join('').includes('secret-value'));
    assert.ok(logs.some((l) => l.includes('request-failed')));
    assert.ok(!logs.join('').includes('secret-123'), logs.join(''));
  });

  it('refuses a body over 16 KB', async () => {
    const r = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(17 * 1024) }) });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'The request is too large.' });
  });

  it('CORS lets identit.ee in and denies another origin', async () => {
    const pre = await fetch(`${base}/api/echo`, { method: 'OPTIONS', headers: { origin: 'https://identit.ee', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://identit.ee');
    const ok = await fetch(`${base}/api/echo`, { headers: { origin: 'https://identit.ee' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://identit.ee');
    for (const origin of ['https://evil.example', 'http://localhost:5173', 'https://identit.ee.evil.example']) {
      const denied = await fetch(`${base}/api/echo`, { headers: { origin } });
      assert.equal(denied.status, 403, origin);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
      const deniedPre = await fetch(`${base}/api/echo`, { method: 'OPTIONS', headers: { origin } });
      assert.equal(deniedPre.status, 403);
      assert.equal(deniedPre.headers.get('access-control-allow-origin'), null);
    }
  });

  it('lets the local origins in only in development', async () => {
    const dev = new HttpServer({ dev: true, log: () => undefined });
    dev.route('GET', '/api/x', () => ({ ok: true }));
    const port = await dev.listen(0, '127.0.0.1');
    try {
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173', 'https://identit.ee']) {
        const r = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { origin } });
        assert.equal(r.headers.get('access-control-allow-origin'), origin);
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { origin: 'http://evil.localhost:1' } })).status, 403);
    } finally {
      await dev.close();
    }
  });

  it('trusts X-Forwarded-For from 127.0.0.1 only, and only its last entry', () => {
    assert.equal(clientIp('127.0.0.1', '203.0.113.9'), '203.0.113.9');
    assert.equal(clientIp('::ffff:127.0.0.1', '1.1.1.1, 203.0.113.9'), '203.0.113.9');
    assert.equal(clientIp('::1', undefined), '::1');
    assert.equal(clientIp('198.51.100.7', '203.0.113.9'), '198.51.100.7');
  });
});

// --- Channels and the packet route -----------------------------------------------------------------

function ctxFor(chain: Chain, cfg: Partial<Config> = {}): Ctx & { lines: string[] } {
  const config = { ...parseConfig({ IDENTITEE_VERIFIER_SURI: '//Alice', VERIFIER_DEV: '1' }), ...cfg };
  const lines: string[] = [];
  return { cfg: config, log: verifierLogger(config, (l) => lines.push(l)), chain, store: new Store(':memory:', Date.now), packets: new PacketMemory(Date.now), now: Date.now, lines };
}

describe('channels', () => {
  it('lists the enabled channels, and a disabled channel answers 503', async () => {
    const started: string[] = [];
    const make = (name: string, enabled: boolean): Channel => ({
      name,
      enabled: () => enabled,
      register: (router) => router.route('POST', `/api/${name}/start`, () => ({ started: name })),
      start: async () => void started.push(name),
      publicInfo: (cfg) => (name === 'matrix' ? { matrixBot: cfg.env.MATRIX_USER ?? '@bot:matrix.org' } : {}),
    });
    const ctx = ctxFor(new LiveChain(stubApi({}).api, alice, () => undefined));
    const server = new HttpServer({ dev: false, log: ctx.log });
    const registry = channelRegistry([make('matrix', true), make('kyc', false)], ctx, server);
    await registry.start();
    assert.deepEqual(started, ['matrix']);
    const port = await server.listen(0, '127.0.0.1');
    try {
      const at = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init);
      assert.deepEqual(await (await at('/api/channels')).json(), { channels: ['matrix'], matrixBot: '@bot:matrix.org' });
      assert.deepEqual(await (await at('/api/health')).json(), { ok: true, genesis: GENESIS, channels: ['matrix'] });
      assert.deepEqual(await (await at('/api/matrix/start', { method: 'POST' })).json(), { started: 'matrix' });
      const off = await at('/api/kyc/start', { method: 'POST' });
      assert.equal(off.status, 503);
      assert.deepEqual(await off.json(), { error: 'This verification is not available yet.' });
    } finally {
      await registry.stop();
      await server.close();
    }
  });

  it('no channel module yet: an empty list', async () => {
    const ctx = ctxFor(new LiveChain(stubApi({}).api, alice, () => undefined));
    const server = new HttpServer({ dev: false, log: ctx.log });
    channelRegistry([], ctx, server);
    const port = await server.listen(0, '127.0.0.1');
    try {
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/channels`)).json(), { channels: [] });
    } finally {
      await server.close();
    }
  });
});

describe('private field packets', () => {
  const TG: FieldKey = { Typed: 'Telegram' };
  const onChain = () => privateCommitment(SALT, stringToU8a(VALUE));

  it('POST /api/packet checks and keeps the packet in memory only; resolvePrivate takes it by id or inline', async () => {
    const profiles = new Map<string, unknown>([[pk(alice), profileWith({ Telegram: { private: onChain() } })]]);
    const ctx = ctxFor(new LiveChain(stubApi({ profiles }).api, bob, () => undefined));
    const server = new HttpServer({ dev: false, log: ctx.log });
    registerPacketRoute(server, ctx);
    const port = await server.listen(0, '127.0.0.1');
    try {
      const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/packet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await post({ address: alice.address, packet: makePacket(alice) });
      assert.equal(r.status, 200);
      const { id } = (await r.json()) as { id: string };
      assert.match(id, /^[A-Za-z0-9_-]{20,}$/);
      assert.deepEqual(await resolvePrivate(ctx, alice.address, TG, id), { value: VALUE, commitment: onChain() });
      assert.deepEqual(await resolvePrivate(ctx, alice.address, TG, makePacket(alice)), { value: VALUE, commitment: onChain() });
      assert.deepEqual(await resolvePrivate(ctx, bob.address, TG, id), { error: 'This verification has expired. Start again.' });
      assert.deepEqual(await resolvePrivate(ctx, alice.address, { Typed: 'Email' }, id), { error: 'This verification has expired. Start again.' });
      assert.deepEqual(await resolvePrivate(ctx, alice.address, TG, 'unknown-id-unknown-id'), { error: 'This verification has expired. Start again.' });

      const wrong = await post({ address: alice.address, packet: makePacket(bob) });
      assert.equal(wrong.status, 400);
      assert.deepEqual(await wrong.json(), { error: 'This packet is signed by another account.' });
      const salt = await post({ address: alice.address, packet: makePacket(alice, { salt: new Uint8Array(32).fill(0x12) }) });
      assert.equal(salt.status, 400);
      const name = await post({ address: alice.address, packet: makePacket(alice, { field: { typed: 'DisplayName' } }) });
      assert.deepEqual(await name.json(), { error: 'This field cannot be verified automatically.' });
      assert.equal((await post({ address: 'nope', packet: makePacket(alice) })).status, 400);

      // the field changes on chain after the packet was stored
      profiles.set(pk(alice), profileWith({ Telegram: { private: `0x${'33'.repeat(32)}` } }));
      assert.deepEqual(await resolvePrivate(ctx, alice.address, TG, id), { error: 'Your Telegram changed. Verify it again.' });

      // nothing of the value reached the logs or the database
      const rows = JSON.stringify(ctx.store.dump());
      for (const where of [ctx.lines.join(''), rows]) {
        assert.ok(!where.includes(VALUE) && !where.includes('alice') && !where.includes(u8aToHex(SALT).slice(2)), where);
      }
    } finally {
      await server.close();
    }
  });

  it('a stored packet expires after 10 minutes', async () => {
    let t = 0;
    const memory = new PacketMemory(() => t);
    const id = memory.put({ address: alice.address, key: TG, value: VALUE, commitment: onChain() });
    assert.equal(memory.get(id)?.value, VALUE);
    t += 10 * 60_000;
    assert.equal(memory.get(id), null);
    memory.put({ address: alice.address, key: TG, value: VALUE, commitment: onChain() });
    t += 10 * 60_000 + 1;
    assert.equal(memory.sweep(), 1);
  });
});

// --- The program -----------------------------------------------------------------------------------

describe('main', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'verifier-test-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const capture = () => {
    const lines: string[] = [];
    return { lines, write: (l: string) => void lines.push(l), events: () => lines.map((l) => JSON.parse(l) as { event: string; [k: string]: unknown }) };
  };
  const waitFor = async (check: () => unknown, what: string) => {
    for (let i = 0; i < 200; i++) {
      const v = check();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${what}: not after 2 s`);
  };

  it('starts, serves /api/health, and exits 0 on SIGTERM without printing the key', async () => {
    const out = capture();
    const SURI = '//Alice//verifier';
    const done = main({ IDENTITEE_VERIFIER_SURI: SURI, STATE_DIRECTORY: dir, VERIFIER_PORT: '0', TELEGRAM_BOT_TOKEN: 'tok:SECRET' }, {
      connect: async () => stubApi({}).api,
      write: out.write,
      exit: () => assert.fail('no second signal'),
      channels: [],
    });
    const listening = (await waitFor(() => out.events().find((e) => e.event === 'listening'), 'listening')) as { port: number };
    const health = await fetch(`http://127.0.0.1:${listening.port}/api/health`);
    assert.deepEqual(await health.json(), { ok: true, genesis: GENESIS, channels: [] });
    process.emit('SIGTERM');
    assert.equal(await done, 0);
    const text = out.lines.join('');
    assert.ok(!text.includes(SURI) && !text.includes('tok:SECRET'));
    assert.deepEqual(out.events().map((e) => e.event).slice(-2), ['stopping', 'stopped']);
  });

  it('stops with exit 1 when the node upgrades its runtime, so that systemd starts it again', async () => {
    const out = capture();
    const stub = stubApi({});
    const done = main({ IDENTITEE_VERIFIER_SURI: '//Alice//verifier', STATE_DIRECTORY: dir, VERIFIER_PORT: '0' }, {
      connect: async () => stub.api,
      write: out.write,
      exit: () => assert.fail('no second signal'),
      channels: [],
    });
    await waitFor(() => out.events().find((e) => e.event === 'listening'), 'listening');
    stub.upgrade(10);
    stub.upgrade(11);
    assert.equal(await done, 1);
    const stopping = out.events().find((e) => e.event === 'stopping') as unknown as { level: string; reason: string; specVersion: number };
    assert.deepEqual([stopping.level, stopping.reason, stopping.specVersion], ['warn', 'runtime_upgraded', 11]);
  });

  it('exits 2 on a bad configuration and 1 on a node that is not identitee', async () => {
    const out = capture();
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      assert.equal(await main({ IDENTITEE_VERIFIER_SURI: '//Alice' }, { write: out.write, channels: [] }), 2);
    } finally {
      process.stderr.write = write;
    }
    const code = await main({ IDENTITEE_VERIFIER_SURI: '//Alice', STATE_DIRECTORY: dir, VERIFIER_PORT: '0' }, {
      connect: async () => stubApi({ spec: 'polkadot' }).api,
      write: out.write,
      channels: [],
    });
    assert.equal(code, 1);
    assert.ok(out.events().some((e) => e.event === 'fatal' && String(e.error).includes('not identitee')));
  });
});
