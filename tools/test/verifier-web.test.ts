// Tests of the website channel (src/verifier/web.ts): a fake chain, a local HTTPS server that answers
// for several names (the resolver is injected, and a checked address is dialled on 127.0.0.1), and an
// injected TXT resolver. No network.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { blockedAddress, fetchPublic, websiteHost, webChannel, type NetOptions, type TxtResolver } from '../src/verifier/web.ts';
import { FakeWeb, TEST_CERT, withChannel, type Harness } from './helpers/web-pgp.ts';

const PUBLIC_IP = '93.184.216.34';
const NOT_FOUND = 'Neither the file nor the DNS record was found.';
const FILE = '/.well-known/identitee.txt';

let alice: KeyringPair;
let bob: KeyringPair;
const web = new FakeWeb();
before(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 2426 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
  await web.start();
});
after(() => web.stop());

/** Names to addresses, as the system resolver would give them; the test dials 127.0.0.1 for every checked address. */
function net(names: Record<string, string[]>, calls: string[] = []): NetOptions {
  return {
    lookup: async (host) => {
      calls.push(host);
      const all = names[host];
      if (all === undefined) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return all.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    dial: () => ({ host: '127.0.0.1', port: web.port }),
    ca: TEST_CERT,
  };
}

/** The names whose TXT records were asked for. */
const txtAsked: string[] = [];
const txt = (records: Record<string, string[][]>): TxtResolver => async (name) => {
  txtAsked.push(name);
  const found = records[name];
  if (found === undefined) throw Object.assign(new Error('no data'), { code: 'ENODATA' });
  return found;
};

interface Setup {
  names?: Record<string, string[]>;
  records?: Record<string, string[][]>;
  timeoutMs?: number;
}

const withWeb = (setup: Setup, run: (h: Harness) => Promise<void>): Promise<void> => {
  web.sites.clear();
  web.seen.length = 0;
  txtAsked.length = 0;
  const channel = webChannel({ net: net(setup.names ?? { 'site.test': [PUBLIC_IP] }), resolveTxt: txt(setup.records ?? {}), timeoutMs: setup.timeoutMs });
  return withChannel(channel, run);
};

const check = (h: Harness, who: KeyringPair, ip?: string) => h.post('/api/web/check', { address: who.address }, ip);

describe('web: hosts and addresses', () => {
  it('takes the host of a plain URL on chain, lowercased and punycoded, https when there is no scheme', () => {
    assert.equal(websiteHost('example.org'), 'example.org');
    assert.equal(websiteHost('  https://Example.ORG/about '), 'example.org');
    assert.equal(websiteHost('https://www.example.org:443/a/b'), 'www.example.org');
    assert.equal(websiteHost('example.org:443'), 'example.org');
    assert.equal(websiteHost('https://bücher.example/'), 'xn--bcher-kva.example');
    assert.equal(websiteHost('BÜCHER.example'), 'xn--bcher-kva.example');
    assert.equal(websiteHost('https://xn--bcher-kva.example'), 'xn--bcher-kva.example');
    assert.equal(websiteHost('example.org.'), 'example.org');
    assert.equal(websiteHost('example.org/@alice'), 'example.org');
    assert.equal(websiteHost('https://10.0.0.1/'), 'ip');
    assert.equal(websiteHost('https://[::1]/'), 'ip');
    assert.equal(websiteHost('https://2130706433/'), 'ip');
  });

  it('refuses a value a parser and a reader could see as two different hosts', () => {
    for (const bad of [
      'https://victim.example@evil.example',
      'victim.example@evil.example',
      'https://victim.example:pw@evil.example/',
      'https://@evil.example',
      'https://evil.example\\@victim.example',
      'https://evil.example\\victim.example',
      'evil.example\\.victim.example',
      'https://evil%2Eexample',
      'https://ex%61mple.org/',
      'https://evil.example%40victim.example',
      'https://example.org:8443/',
      'example.org:80',
      'http://example.org/',
      'ftp://example.org',
      'javascript:alert(1)',
      'https://example.org/?next=evil.example',
      'https://example.org/#evil.example',
      'https://example.org.:443:443',
      '',
      'localhost',
      'https://',
      'exa mple.org',
      'exa\tmple.org',
      'https://example.org/a b',
    ]) {
      assert.equal(websiteHost(bad), null, bad);
    }
  });

  it('refuses loopback, private, link-local, CGNAT, unspecified, multicast addresses and their mapped forms', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '100.127.255.254',
      '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1',
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'not-an-ip',
      '::ffff:0:127.0.0.1', '::ffff:0:a00:1', '64:ff9b:1::1', '64:ff9b:1:5db8:d822::', '2002:7f00:1::', '2002:c0a8:11a::1',
      '192.0.2.1', '198.51.100.7', '203.0.113.9', '2001:db8::1',
    ]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
    for (const ip of [PUBLIC_IP, '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:93.184.216.34', '::ffff:0:93.184.216.34', '2002:5db8:d822::1', '64:ff9b::5db8:d822']) assert.equal(blockedAddress(ip), false, ip);
  });
});

describe('web: the file', () => {
  it('attests WebFile when the file holds the address, in any SS58 prefix, among other words', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'https://Site.test/blog');
      web.file('site.test', FILE, `identitee\n  ${encodeAddress(alice.publicKey, 0)}  \nother words\n`);
      const r = await check(h, alice);
      assert.deepEqual(r, { status: 200, json: { verified: true, method: 'WebFile' } });
      assert.equal(h.chain.attests.length, 1);
      assert.equal(h.chain.attests[0]!.method, 'WebFile');
      assert.equal(h.chain.attests[0]!.commitment, (await h.chain.field(alice.address, { Typed: 'Web' }))!.commitment);
      const seen = web.seen[0]!;
      assert.equal(seen.host, 'site.test');
      assert.equal(seen.path, FILE);
      assert.equal(seen.headers['user-agent'], 'identitee-verifier');
      assert.equal(seen.headers.cookie, undefined);
      assert.ok(h.lines.some((l) => l.includes('"web-verified"') && l.includes('WebFile')));
    });
  });

  it('does not attest a file that holds another address, or only part of it, or the address as hex', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      for (const body of [bob.address, alice.address.slice(0, -1), `x${alice.address}`, Buffer.from(alice.publicKey).toString('hex'), '']) {
        web.file('site.test', FILE, body);
        const r = await check(h, alice);
        assert.deepEqual(r, { status: 400, json: { error: NOT_FOUND } }, body);
      }
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('reads 4 KB at most', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      web.file('site.test', FILE, `${'x '.repeat(2100)}${alice.address}`);
      assert.equal((await check(h, alice)).status, 400);
      web.file('site.test', FILE, `${'x '.repeat(1900)}${alice.address}`);
      assert.equal((await check(h, alice)).status, 200);
    });
  });

  it('follows a redirect on the same host over https, at most 3 times', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      let hops = 0;
      web.sites.set('site.test', (req, res) => {
        if (req.url === '/final') return void res.writeHead(200).end(alice.address);
        hops++;
        res.writeHead(302, { location: hops < 3 ? `/hop${hops}` : 'https://site.test/final' }).end();
      });
      assert.equal((await check(h, alice)).status, 200);
      hops = 0;
      web.seen.length = 0;
      web.sites.set('site.test', (req, res) => {
        if (req.url === '/final') return void res.writeHead(200).end(alice.address);
        hops++;
        res.writeHead(301, { location: hops < 4 ? `/hop${hops}` : '/final' }).end();
      });
      assert.deepEqual(await check(h, alice), { status: 400, json: { error: NOT_FOUND } });
      assert.deepEqual(web.seen.map((s) => s.path), [FILE, '/hop1', '/hop2', '/hop3']);
    });
  });

  it('refuses a redirect to another host, to http, or to another port, and never contacts them', async () => {
    await withWeb({ names: { 'site.test': [PUBLIC_IP], 'other.test': [PUBLIC_IP], 'www.site.test': [PUBLIC_IP] } }, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      web.file('other.test', FILE, alice.address);
      web.file('www.site.test', FILE, alice.address);
      for (const location of [`https://other.test${FILE}`, `https://www.site.test${FILE}`, `http://site.test/x`, 'https://site.test:8443/x', '//other.test/x']) {
        web.sites.set('site.test', (req, res) => {
          if (req.url === '/x') return void res.writeHead(200).end(alice.address);
          res.writeHead(302, { location }).end();
        });
        web.seen.length = 0;
        assert.deepEqual(await check(h, alice), { status: 400, json: { error: NOT_FOUND } }, location);
        assert.deepEqual(web.seen.map((s) => `${s.host}${s.path}`), [`site.test${FILE}`], location);
      }
      assert.equal(h.chain.attests.length, 0);
    });
  });

  it('refuses a host that resolves to a private or loopback address, even once among public ones, without connecting', async () => {
    for (const addresses of [['10.0.0.5'], ['127.0.0.1'], [PUBLIC_IP, '192.168.0.10'], ['::1'], ['::ffff:169.254.169.254'], []]) {
      await withWeb({ names: { 'site.test': addresses } }, async (h) => {
        h.chain.setPublic(alice.address, 'Web', 'site.test');
        web.file('site.test', FILE, alice.address);
        assert.deepEqual(await check(h, alice), { status: 400, json: { error: NOT_FOUND } }, addresses.join(','));
        assert.equal(web.seen.length, 0, addresses.join(','));
      });
    }
  });

  it('checks the address of every hop: a redirect whose host now resolves to a private address is not followed', async () => {
    let calls = 0;
    const channel = webChannel({
      net: {
        lookup: async () => (calls++ === 0 ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
        dial: () => ({ host: '127.0.0.1', port: web.port }),
        ca: TEST_CERT,
      },
      resolveTxt: txt({}),
    });
    web.sites.clear();
    web.seen.length = 0;
    await withChannel(channel, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      web.sites.set('site.test', (req, res) => {
        if (req.url === '/next') return void res.writeHead(200).end(alice.address);
        res.writeHead(302, { location: '/next' }).end();
      });
      assert.equal((await check(h, alice)).status, 400);
      assert.deepEqual(web.seen.map((s) => s.path), [FILE]);
      assert.equal(calls, 2);
    });
  });

  it('gives up after the timeout on a server that does not answer', async () => {
    await withWeb({ timeoutMs: 300 }, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      web.sites.set('site.test', () => undefined); // never answers
      const started = Date.now();
      assert.deepEqual(await check(h, alice), { status: 400, json: { error: NOT_FOUND } });
      assert.ok(Date.now() - started < 3000);
    });
  });

  it('refuses a certificate that is not trusted', async () => {
    const r = await fetchPublic(`https://site.test${FILE}`, { lookup: async () => [{ address: PUBLIC_IP, family: 4 }], dial: () => ({ host: '127.0.0.1', port: web.port }) });
    assert.deepEqual(r, { ok: false, reason: 'network' });
  });
});

describe('web: DNS', () => {
  it('attests Dns from a TXT record on _identitee.<host>, or on <host>, in any prefix', async () => {
    for (const name of ['_identitee.site.test', 'site.test']) {
      await withWeb({ records: { [name]: [['v=spf1 -all'], ['identitee=', encodeAddress(alice.publicKey, 42)]] } }, async (h) => {
        h.chain.setPublic(alice.address, 'Web', 'https://site.test');
        const r = await check(h, alice);
        assert.deepEqual(r, { status: 200, json: { verified: true, method: 'Dns' } }, name);
        assert.equal(h.chain.attests[0]!.method, 'Dns');
      });
    }
  });

  it('tries DNS when the host has no address or only private ones', async () => {
    await withWeb({ names: { 'site.test': ['10.0.0.1'] }, records: { '_identitee.site.test': [[`identitee=${alice.address}`]] } }, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      assert.equal((await check(h, alice)).json.method, 'Dns');
      assert.equal(web.seen.length, 0);
    });
  });

  it('does not attest a record for another address or without the prefix', async () => {
    await withWeb({ records: { '_identitee.site.test': [[`identitee=${bob.address}`]], 'site.test': [[alice.address]] } }, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      assert.deepEqual(await check(h, alice), { status: 400, json: { error: NOT_FOUND } });
    });
  });
});

describe('web: the field on chain', () => {
  it('asks for a website first, refuses a private one, an IP address, a malformed one', async () => {
    await withWeb({}, async (h) => {
      assert.deepEqual((await check(h, alice)).json, { error: 'Add your Website to your identity first.' });
      h.chain.setPrivate(alice.address, 'Web', 'site.test');
      assert.deepEqual((await check(h, alice)).json, { error: 'Make your website public to verify it.' });
      assert.deepEqual(txtAsked, [], 'a private website is not looked up in DNS');
      h.chain.setPublic(alice.address, 'Web', 'https://192.0.2.1/');
      assert.deepEqual((await check(h, alice)).json, { error: 'Use a domain name for your website, not an IP address.' });
      for (const value of ['not a site', 'https://site.test@other.test', 'https://other.test\\@site.test']) {
        h.chain.setPublic(alice.address, 'Web', value);
        assert.deepEqual((await check(h, alice)).json, { error: 'Write your website as a plain address, like example.com.' }, value);
      }
      assert.deepEqual(txtAsked, []);
      assert.deepEqual((await h.post('/api/web/check', { address: 'nope' })).json, { error: 'This is not a valid account address.' });
      assert.equal(web.seen.length, 0);
    });
  });

  it('says to verify again when the field changed meanwhile, and tells a chain failure apart', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      web.file('site.test', FILE, alice.address);
      h.chain.onAttest = () => h.chain.setPublic(alice.address, 'Web', 'other.test');
      assert.deepEqual(await check(h, alice), { status: 409, json: { error: 'Your Website changed. Verify it again.' } });
      h.chain.onAttest = undefined;
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      h.chain.failures.push({ ok: false, reason: 'failed', detail: 'x' });
      assert.deepEqual(await check(h, alice), { status: 502, json: { error: 'The verification could not be recorded. Try again in a moment.' } });
    });
  });

  it('allows 10 checks per hour for an account from one IP, without locking the owner out from another', async () => {
    await withWeb({}, async (h) => {
      h.chain.setPublic(alice.address, 'Web', 'site.test');
      for (let i = 0; i < 10; i++) assert.equal((await check(h, alice, '203.0.113.5')).status, 400);
      assert.deepEqual(await check(h, alice, '203.0.113.5'), { status: 429, json: { error: 'Too many checks for this website. Try again in an hour.' } });
      // The owner, from another IP, is not locked out by someone else's checks.
      web.file('site.test', FILE, alice.address);
      assert.deepEqual(await check(h, alice, '198.51.100.20'), { status: 200, json: { verified: true, method: 'WebFile' } });
      h.clock.t += 61 * 60_000;
      assert.equal((await check(h, alice, '203.0.113.5')).status, 200);
      h.chain.setPublic(bob.address, 'Web', 'site.test');
      for (let i = 0; i < 29; i++) await h.store.hit('start', '198.51.100.7', 30, 3_600_000);
      assert.equal((await check(h, bob, '198.51.100.7')).status, 400);
      assert.deepEqual(await check(h, bob, '198.51.100.7'), { status: 429, json: { error: 'Too many attempts. Try again later.' } });
    });
  });
});
