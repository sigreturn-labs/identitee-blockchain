// Tests of the PGP channel (src/verifier/pgp.ts): keys made here with openpgp (v4 and v6), a fake chain,
// and a local HTTPS server that plays keys.openpgp.org through the hardened fetch. No network.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import * as openpgp from 'openpgp';

import { pgpChannel, signedText } from '../src/verifier/pgp.ts';
import { FakeWeb, GENESIS, MINUTE, SALT, TEST_CERT, withChannel, type Harness } from './helpers/web-pgp.ts';
import { privateCommitment } from '../src/verifier/packet.ts';

const PUBLIC_IP = '93.184.216.34';
const KEYSERVER_PATH = '/vks/v1/by-fingerprint/';

let alice: KeyringPair;
let bob: KeyringPair;
const web = new FakeWeb();

interface TestKey {
  privateKey: openpgp.PrivateKey;
  publicKey: openpgp.PublicKey;
  armored: string;
  fpr: string;
}

async function makeKey(v6: boolean, more: { keyExpirationTime?: number; date?: Date } = {}): Promise<TestKey> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    userIDs: [{ name: 'Alice', email: 'alice@example.org' }],
    type: v6 ? 'curve25519' : 'ecc',
    format: 'object',
    config: { v6Keys: v6 },
    ...more,
  });
  return { privateKey, publicKey, armored: publicKey.armor(), fpr: publicKey.getFingerprint() };
}

let v4: TestKey;
let v6: TestKey;
let other: TestKey;
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
  [v4, v6, other] = await Promise.all([makeKey(false), makeKey(true), makeKey(false)]);
  await web.start();
});
after(() => web.stop());

const clearsign = async (key: TestKey, text: string, date?: Date): Promise<string> =>
  openpgp.sign({ message: await openpgp.createCleartextMessage({ text }), signingKeys: key.privateKey, date });

const detach = async (key: TestKey, text: string, binary = false): Promise<string> =>
  openpgp.sign({
    message: binary ? await openpgp.createMessage({ binary: new TextEncoder().encode(text) }) : await openpgp.createMessage({ text }),
    signingKeys: key.privateKey,
    detached: true,
  });

/** keys.openpgp.org as the fake web serves it: the armored keys by uppercase fingerprint. */
function keyserver(keys: TestKey[]): void {
  web.sites.set('keys.openpgp.org', (req, res) => {
    const found = keys.find((k) => req.url === `${KEYSERVER_PATH}${k.fpr.toUpperCase()}`);
    if (found === undefined) return void res.writeHead(404).end('No key found for fingerprint');
    res.writeHead(200, { 'content-type': 'application/pgp-keys' }).end(found.armored);
  });
}

const withPgp = (keys: TestKey[], run: (h: Harness) => Promise<void>): Promise<void> => {
  web.sites.clear();
  web.seen.length = 0;
  keyserver(keys);
  const channel = pgpChannel({ net: { lookup: async () => [{ address: PUBLIC_IP, family: 4 }], dial: () => ({ host: '127.0.0.1', port: web.port }), ca: TEST_CERT } });
  return withChannel(channel, run);
};

const challenge = async (h: Harness, who: KeyringPair, extra: Record<string, unknown> = {}): Promise<{ challenge: string; session: string }> => {
  const r = await h.post('/api/pgp/challenge', { address: who.address, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { challenge: string; session: string };
};

const verify = (h: Harness, who: KeyringPair, session: string, signed: string, more: Record<string, unknown> = {}) =>
  h.post('/api/pgp/verify', { address: who.address, session, signed, ...more });

describe('pgp: the challenge', () => {
  it('says what is signed: the identity, the chain, a nonce, one ASCII line; a session goes with it', async () => {
    await withPgp([], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      assert.match(c.challenge, /^identitee verification: link this key to identity (\S+) on chain ([0-9a-f]{10}) nonce ([0-9a-f]{32})$/);
      assert.ok(c.challenge.includes(alice.address));
      assert.ok(c.challenge.includes(GENESIS.slice(2, 12)));
      assert.match(c.session, /^[A-Za-z0-9_-]{22}$/);
      const again = await challenge(h, alice);
      assert.notEqual(again.challenge, c.challenge);
      const rows = JSON.stringify(h.store.dump().items);
      assert.ok(!rows.includes(c.session) && !rows.includes(v4.fpr), 'neither the session nor the fingerprint is stored');
    });
  });

  it('asks for a fingerprint first, and for the packet of a private one', async () => {
    await withPgp([], async (h) => {
      assert.deepEqual((await h.post('/api/pgp/challenge', { address: alice.address })).json, { error: 'Add your PGP to your identity first.' });
      h.chain.setPrivate(alice.address, 'Pgp', v4.fpr);
      assert.deepEqual((await h.post('/api/pgp/challenge', { address: alice.address })).json, { error: 'Unlock your identity to verify a private PGP.' });
      assert.deepEqual((await h.post('/api/pgp/challenge', { address: 'x' })).json, { error: 'This is not a valid account address.' });
    });
  });
});

describe('pgp: verifying', () => {
  it('attests a v4 key from keys.openpgp.org with a clearsigned challenge', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const signed = await clearsign(v4, `${c.challenge}\n`);
      assert.deepEqual(await verify(h, alice, c.session, signed), { status: 200, json: { verified: true } });
      assert.equal(h.chain.attests.length, 1);
      assert.equal(h.chain.attests[0]!.method, 'PgpSignature');
      const asked = web.seen.find((s) => s.host === 'keys.openpgp.org')!;
      assert.equal(asked.path, `${KEYSERVER_PATH}${v4.fpr.toUpperCase()}`);
      assert.equal(asked.headers['user-agent'], 'identitee-verifier');
      // The challenge is spent.
      assert.deepEqual((await verify(h, alice, c.session, signed)).json, { error: 'This challenge has expired. Ask for a new one.' });
      const logs = h.lines.join('');
      assert.ok(logs.includes('"pgp-verified"'));
      assert.ok(!logs.includes('BEGIN PGP') && !logs.includes(c.challenge) && !logs.includes(c.session), 'nothing pasted is logged');
    });
  });

  it('attests a v6 key pasted by the person (not on the keyserver) with a detached signature', async () => {
    await withPgp([], async (h) => {
      assert.equal(v6.fpr.length, 64);
      h.chain.setPublic(alice.address, 'Pgp', v6.fpr);
      const c = await challenge(h, alice);
      const r = await verify(h, alice, c.session, await detach(v6, c.challenge));
      assert.deepEqual(r.json, { error: 'Your key is not on keys.openpgp.org. Paste your public key.' });
      assert.deepEqual(await verify(h, alice, c.session, await detach(v6, c.challenge), { key: v6.armored }), { status: 200, json: { verified: true } });
    });
  });

  it('accepts a v6 clearsigned challenge and binary or text detached signatures of the line with its newline', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v6.fpr);
      let c = await challenge(h, alice);
      assert.equal((await verify(h, alice, c.session, await clearsign(v6, c.challenge), { key: v6.armored })).status, 200);
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      c = await challenge(h, alice);
      assert.equal((await verify(h, alice, c.session, await detach(v4, `${c.challenge}\n`, true))).status, 200);
      c = await challenge(h, alice);
      assert.equal((await verify(h, alice, c.session, await detach(v4, `${c.challenge}\r\n`))).status, 200);
    });
  });

  it('refuses a key that is not the one on chain, and a signature from another key', async () => {
    await withPgp([v4, other], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      // Signed by another key, which is pasted: the key on chain comes from the keyserver, and it did not sign.
      const r = await verify(h, alice, c.session, await clearsign(other, c.challenge), { key: other.armored });
      assert.deepEqual(r, { status: 400, json: { error: 'This key is not the one on your identity.' } });
      const s = await verify(h, alice, c.session, await clearsign(other, c.challenge));
      assert.deepEqual(s, { status: 400, json: { error: 'This signature is not from your key, or not of this challenge.' } });
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('refuses a signature of another text, whatever the pasted text says', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const old = await challenge(h, alice);
      // A clearsigned other text.
      assert.deepEqual((await verify(h, alice, c.session, await clearsign(v4, old.challenge))).json, {
        error: 'The signed text is not the challenge. Sign the exact challenge shown.',
      });
      // The right text pasted around a signature of another text.
      const forged = (await clearsign(v4, old.challenge)).replace(old.challenge, c.challenge);
      assert.deepEqual((await verify(h, alice, c.session, forged)).json, { error: 'This signature is not from your key, or not of this challenge.' });
      // A detached signature of another text.
      assert.deepEqual((await verify(h, alice, c.session, await detach(v4, old.challenge))).json, { error: 'This signature is not from your key, or not of this challenge.' });
      // Something else entirely.
      assert.deepEqual((await verify(h, alice, c.session, 'hello')).json, {
        error: 'Paste the whole output of the sign command, from the first -----BEGIN PGP line to the last -----END PGP line.',
      });
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('refuses an expired challenge, an unknown session, and a session of another account', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      h.chain.setPublic(bob.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const signed = await clearsign(v4, c.challenge);
      const expired = { error: 'This challenge has expired. Ask for a new one.' };
      assert.deepEqual((await verify(h, bob, c.session, signed)).json, expired);
      assert.deepEqual((await verify(h, alice, 'A'.repeat(22), signed)).json, expired);
      assert.deepEqual((await verify(h, alice, '../x', signed)).json, expired);
      h.clock.t += 16 * MINUTE;
      assert.deepEqual((await verify(h, alice, c.session, signed)).json, expired);
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('refuses an expired key and a revoked key', async () => {
    const dayAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    const expiring = await makeKey(false, { date: dayAgo, keyExpirationTime: 24 * 3600 });
    const revoked = await makeKey(false);
    const { publicKey: revokedArmored } = await openpgp.revokeKey({ key: revoked.privateKey, format: 'armored' });
    await withPgp([], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', expiring.fpr);
      let c = await challenge(h, alice);
      // Signed while the key was valid, verified now that it expired.
      const old = await clearsign(expiring, c.challenge, new Date(dayAgo.getTime() + 3600_000));
      assert.deepEqual((await verify(h, alice, c.session, old, { key: expiring.armored })).json, { error: 'This key has expired or is not valid.' });
      h.chain.setPublic(alice.address, 'Pgp', revoked.fpr);
      c = await challenge(h, alice);
      const r = await verify(h, alice, c.session, await clearsign(revoked, c.challenge), { key: revokedArmored });
      assert.deepEqual(r.json, { error: 'This key is revoked.' });
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('keeps a revocation published on the keyserver even when an older copy is pasted', async () => {
    const revoked = await makeKey(false);
    const { publicKey: revokedArmored } = await openpgp.revokeKey({ key: revoked.privateKey, format: 'armored' });
    await withPgp([{ ...revoked, armored: revokedArmored }], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', revoked.fpr);
      const c = await challenge(h, alice);
      const r = await verify(h, alice, c.session, await clearsign(revoked, c.challenge), { key: revoked.armored });
      assert.deepEqual(r.json, { error: 'This key is revoked.' });
    });
  });

  it('refuses a pasted private key without reading further, and pasted texts over 64 KB', async () => {
    await withPgp([], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const signed = await clearsign(v4, c.challenge);
      assert.deepEqual((await verify(h, alice, c.session, signed, { key: v4.privateKey.armor() })).json, { error: 'Paste your public key, never your private key.' });
      assert.deepEqual((await verify(h, alice, c.session, signed, { key: 'x'.repeat(64 * 1024 + 1) })).json, { error: 'What you pasted is too long.' });
      assert.deepEqual((await verify(h, alice, c.session, `${signed}${' '.repeat(64 * 1024)}`)).json, { error: 'What you pasted is too long.' });
      // A key and a signature of 64 KB each fit in one request.
      const big = await h.postRaw('/api/pgp/verify', JSON.stringify({ address: alice.address, session: c.session, signed: ' '.repeat(60_000), key: ' '.repeat(60_000) }));
      assert.notEqual(big.status, 413);
      assert.ok(!h.lines.join('').includes('PRIVATE KEY'));
    });
  });

  it('says to verify again when the fingerprint changed between the challenge and the signature', async () => {
    await withPgp([v4, other], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      h.chain.setPublic(alice.address, 'Pgp', other.fpr);
      assert.deepEqual(await verify(h, alice, c.session, await clearsign(other, c.challenge)), { status: 409, json: { error: 'Your PGP changed. Verify it again.' } });
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const d = await challenge(h, alice);
      h.chain.onAttest = () => h.chain.setPublic(alice.address, 'Pgp', other.fpr);
      assert.deepEqual(await verify(h, alice, d.session, await clearsign(v4, d.challenge)), { status: 409, json: { error: 'Your PGP changed. Verify it again.' } });
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('keeps a good challenge when only the chain failed', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const signed = await clearsign(v4, c.challenge);
      h.chain.failures.push({ ok: false, reason: 'failed', detail: 'x' });
      assert.equal((await verify(h, alice, c.session, signed)).status, 502);
      assert.equal((await verify(h, alice, c.session, signed)).status, 200);
    });
  });

  it('allows 5 tries per challenge', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPublic(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice);
      const wrong = await detach(other, c.challenge);
      for (let i = 0; i < 5; i++) assert.equal((await verify(h, alice, c.session, wrong)).status, 400);
      assert.deepEqual(await verify(h, alice, c.session, await clearsign(v4, c.challenge)), { status: 429, json: { error: 'Too many tries. Ask for a new challenge.' } });
    });
  });
});

describe('pgp: a private fingerprint', () => {
  function packet(pair: KeyringPair, fpr: string) {
    const content = {
      type: 'identitee-verification-packet',
      version: 1,
      chain: GENESIS,
      address: pair.address,
      field: { typed: 'Pgp' },
      value: `0x${fpr}`,
      salt: u8aToHex(SALT),
      commitment: privateCommitment(SALT, Buffer.from(fpr, 'hex')),
    };
    return { ...content, signature: u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(JSON.stringify(content))))) };
  }

  it('verifies through the packet and the pasted key, never asks the keyserver, and keeps the fingerprint out of the database and the logs', async () => {
    await withPgp([v4], async (h) => {
      const commitment = h.chain.setPrivate(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice, { packet: packet(alice, v4.fpr) });
      const signed = await clearsign(v4, c.challenge);
      assert.deepEqual(await verify(h, alice, c.session, signed), { status: 400, json: { error: 'Paste your public key to verify a private PGP.' } });
      assert.deepEqual(await verify(h, alice, c.session, signed, { key: v4.armored }), { status: 200, json: { verified: true } });
      assert.equal(h.chain.attests[0]!.commitment, commitment);
      assert.deepEqual(web.seen, [], 'keys.openpgp.org is never asked for a private fingerprint');
      for (const where of [JSON.stringify(h.store.dump()), h.lines.join('')]) assert.ok(!where.includes(v4.fpr) && !where.includes(v4.fpr.toUpperCase()));
    });
  });

  it('checks revocation on the pasted copy of a private key, without the keyserver', async () => {
    const revoked = await makeKey(false);
    const { publicKey: revokedArmored } = await openpgp.revokeKey({ key: revoked.privateKey, format: 'armored' });
    await withPgp([revoked], async (h) => {
      h.chain.setPrivate(alice.address, 'Pgp', revoked.fpr);
      const c = await challenge(h, alice, { packet: packet(alice, revoked.fpr) });
      const r = await verify(h, alice, c.session, await clearsign(revoked, c.challenge), { key: revokedArmored });
      assert.deepEqual(r, { status: 400, json: { error: 'This key is revoked.' } });
      assert.deepEqual(web.seen, []);
    });
  });

  it('answers 400 when the packet kept at the challenge expired, and takes a new packet', async () => {
    await withPgp([], async (h) => {
      h.chain.setPrivate(alice.address, 'Pgp', v4.fpr);
      const c = await challenge(h, alice, { packet: packet(alice, v4.fpr) });
      const signed = await clearsign(v4, c.challenge);
      h.clock.t += 11 * MINUTE;
      assert.deepEqual(await verify(h, alice, c.session, signed, { key: v4.armored }), { status: 400, json: { error: 'This verification has expired. Start again.' } });
      assert.equal((await verify(h, alice, c.session, signed, { key: v4.armored, packet: packet(alice, v4.fpr) })).status, 200);
    });
  });

  it('refuses a packet of another account', async () => {
    await withPgp([v4], async (h) => {
      h.chain.setPrivate(alice.address, 'Pgp', v4.fpr);
      const r = await h.post('/api/pgp/challenge', { address: alice.address, packet: packet(bob, v4.fpr) });
      assert.deepEqual(r.json, { error: 'This packet is signed by another account.' });
    });
  });
});

describe('pgp: what the signed text is', () => {
  it('normalizes line endings and trailing white space only', () => {
    assert.equal(signedText('a b \r\nc\t\r\n\r\n'), 'a b\nc');
    assert.equal(signedText('  a'), '  a');
  });
});
