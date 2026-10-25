// Tests of the explorer API (src/explorer/api.ts), its configuration (src/explorer/config.ts) and the
// indexer restart loop of src/explorer/main.ts: an in-memory store filled with rows, a fake live
// state, the server on a loopback port. No chain, no network beyond 127.0.0.1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { callSummary, digestLogs, ExplorerApi, palletsOf, type HeadSource, type Live } from '../src/explorer/api.ts';
import { DEFAULT_ORIGIN, DEV_ORIGIN, parseConfig, parseLabels, profileUrl, RESERVED_PATHS } from '../src/explorer/config.ts';
import type { Heads } from '../src/explorer/indexer.ts';
import { keepIndexing, main } from '../src/explorer/main.ts';
import type { AuthorityState } from '../src/explorer/state.ts';
import { ExplorerStore, type AccountLink, type BlockRow, type EventRow, type ExtrinsicRow, type Extras } from '../src/explorer/store.ts';
import type { Logger } from '../src/migrator.ts';

await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519' });
const alice = keyring.addFromUri('//Alice');
const bob = keyring.addFromUri('//Bob');
const ALICE = encodeAddress(alice.publicKey, 2426);
const BOB = encodeAddress(bob.publicKey, 2426);
const ALICE_HEX = u8aToHex(alice.publicKey);
const BOB_HEX = u8aToHex(bob.publicKey);
const CAROL_HEX = `0x${'ca'.repeat(32)}`;
const LABELS = { [ALICE_HEX]: 'identitee-01', [CAROL_HEX]: 'identitee-02' };
const ALICE_GENERIC = encodeAddress(alice.publicKey, 42);

const GENESIS = `0x${'ab'.repeat(32)}`;
const T0 = 1_700_000_000_000;
const hash = (tag: number, n: number): string => `0x${tag.toString(16).padStart(2, '0')}${n.toString(16).padStart(62, '0')}`;
const DUP = `0x${'dd'.repeat(32)}`;
const LAST = 120;
const quiet: Logger = () => undefined;

function fill(store: ExplorerStore): void {
  store.openForGenesis(GENESIS);
  store.recordRuntime(1, 0, 'identitee');
  store.recordRuntime(2, 20, 'identitee');
  for (let n = 0; n <= LAST; n++) {
    const xts: ExtrinsicRow[] = [];
    const evs: EventRow[] = [];
    const links: AccountLink[] = [];
    const extras: Extras = { transfers: [], attestations: [], migrations: [], usernames: [] };
    const xt = (over: Partial<ExtrinsicRow>): void => {
      const index = xts.length;
      xts.push({ id: `${n}-${index}`, block: n, index, hash: hash(0xa0 + index, n), pallet: 'system', method: 'remark', args: {}, signer: null, nonce: null, tip: null, fee: null, success: true, error: null, ...over });
    };
    const ev = (xi: number | null, pallet: string, method: string, data: unknown, sentence: string | null = null): string => {
      const index = evs.length;
      evs.push({ id: `${n}-${index}`, block: n, index, extrinsicIndex: xi, pallet, method, data, sentence });
      return `${n}-${index}`;
    };
    if (n > 0) {
      xt({ pallet: 'timestamp', method: 'set', args: { now: String(T0 + n * 6000) } });
      ev(0, 'system', 'ExtrinsicSuccess', {});
      if (n === 5) {
        xt({
          pallet: 'sudo',
          method: 'sudo',
          args: { call: { pallet: 'identitee', method: 'set_username_for', args: { who: BOB, name: 'bob', note: 'x'.repeat(3000) } } },
          signer: ALICE, nonce: 0, tip: '0', fee: '0',
        });
      } else {
        xt({ pallet: 'balances', method: 'transfer_keep_alive', args: { dest: BOB, value: '1000000000000' }, signer: ALICE, nonce: n, tip: '0', fee: '125000', hash: n === 10 || n === 11 ? DUP : hash(0xa1, n) });
        const id = ev(1, 'balances', 'Transfer', { from: ALICE, to: BOB, amount: '1000000000000' }, 'alice sent 1 IDT to bob');
        extras.transfers.push({ from: ALICE, to: BOB, amount: '1000000000000', block: n, extrinsicId: `${n}-1`, eventId: id });
        links.push({ address: ALICE, itemKind: 'extrinsic', itemId: `${n}-1`, block: n }, { address: BOB, itemKind: 'event', itemId: id, block: n });
      }
      if (n === 4 || n === 6) {
        const id = ev(null, 'identitee', 'AttestationRequested', { who: BOB, authority: n === 4 ? 0 : 1 }, 'bob asked for a check');
        extras.attestations.push({ who: BOB, authorityId: n === 4 ? 0 : 1, kind: 'requested', target: { Field: 'Email' }, data: null, block: n, eventId: id });
      }
      if (n === 7) {
        const id = ev(null, 'identitee', 'MigrationFulfilled', { who: BOB }, 'bob migrated an identity');
        extras.migrations.push({ who: BOB, kind: 'fulfilled', data: { agent: ALICE }, block: n, eventId: id });
      }
      if (n === 8 || n === 9) {
        const name = n === 8 ? 'alice' : '010';
        const id = ev(null, 'identitee', 'NameClaimed', { who: ALICE, name }, `claimed ${name}`);
        extras.usernames.push({ name, who: n === 8 ? ALICE : BOB, kind: 'claimed', block: n, eventId: id });
      }
    }
    const block: BlockRow = {
      number: n, hash: hash(0x10, n), parentHash: hash(0x10, n - 1), stateRoot: hash(0x20, n), extrinsicsRoot: hash(0x30, n),
      timestamp: n === 0 ? null : T0 + n * 6000, specVersion: n >= 20 ? 2 : 1, author: n % 2 === 0 ? ALICE_HEX : BOB_HEX, authoritySetId: n < 100 ? 0 : 1,
      justificationSigners: n === 10 ? [ALICE_HEX, BOB_HEX] : null, extrinsicCount: xts.length, eventCount: evs.length,
    };
    store.writeBlock(block, xts, evs, links, extras);
  }
}

const AUTHORITIES: AuthorityState[] = [
  { id: 0, name: 'identitee', active: true, agents: [{ address: BOB, capabilities: 15, capabilityNames: ['attest_fields', 'person_facts', 'manage_names', 'migrate'] }] },
  { id: 1, name: 'example.com', active: true, agents: [] },
];

const LOGS = [
  { type: 'PreRuntime', engine: 'aura', data: '0x0a0b0c0d00000000' },
  { type: 'Seal', engine: 'aura', data: `0x${'11'.repeat(64)}` },
];

function fakeLive(): Live & { up: boolean; failLogs: boolean; failMembers: boolean; hang: boolean; reads: string[] } {
  const f = {
    up: true,
    failLogs: false,
    failMembers: false,
    hang: false,
    reads: [] as string[],
    connected: () => f.up,
    specVersion: () => 2,
    guard<T>(v: T): Promise<T> {
      return f.up ? Promise.resolve(v) : Promise.reject(new Error('disconnected'));
    },
    account: (address: string) => f.guard({ free: address === ALICE ? '5000000000000' : '0', reserved: '0', frozen: '0', nonce: 3 }),
    identitySummary: (address: string) => f.guard({ display: address === ALICE ? 'Alice' : null, username: address === ALICE ? 'alice' : address === BOB ? 'me' : null, trust: 'Unknown' }),
    roles: (address: string) => f.guard({ sudo: address === ALICE, validator: address === ALICE, agent: [] }),
    authorities: () => f.guard(AUTHORITIES),
    validators: () => f.guard({ aura: [{ key: ALICE_HEX, label: 'identitee-01' }], grandpa: [{ key: ALICE_HEX, weight: 1, label: 'identitee-01' }], setId: 0 }),
    health: () => f.guard({ peers: 2, isSyncing: false, shouldHavePeers: true }),
    nameOwner: (name: string) => f.guard(name === 'alice' ? ALICE : name === '010' ? BOB : null),
    blockLogs(blockHash: string) {
      f.reads.push(`logs ${blockHash}`);
      if (f.hang) return new Promise<never>(() => undefined);
      return f.failLogs ? Promise.reject(new Error('header not found')) : f.guard(LOGS);
    },
    grandpaAuthorities(blockHash: string) {
      f.reads.push(`grandpa ${blockHash}`);
      return f.failMembers ? Promise.reject(new Error('state discarded')) : f.guard([ALICE_HEX, BOB_HEX]);
    },
    runtime: () => ({ specName: 'identitee', specVersion: 2, pallets: [{ name: 'System', index: 0, calls: [{ name: 'remark', docs: 'Make some on-chain remark.' }], events: [], errors: [], storage: [], constants: [] }] }),
  };
  return f;
}

function fakeHeads(): HeadSource & { fire(h: Heads): void } {
  let current: Heads = { best: LAST + 2, finalized: LAST };
  const cbs: Array<(h: Heads) => void> = [];
  return {
    heads: () => current,
    onHead: (cb) => void cbs.push(cb),
    fire(h) {
      current = h;
      for (const cb of cbs) cb(h);
    },
  };
}

const store = new ExplorerStore(':memory:');
fill(store);
const live = fakeLive();
const heads = fakeHeads();
const server = new ExplorerApi({ store, live, heads, origins: [DEFAULT_ORIGIN, DEV_ORIGIN], labels: LABELS, log: quiet, pingMs: 50, pollMs: 20, liveTimeoutMs: 200 });
let base = '';

before(async () => {
  base = `http://127.0.0.1:${await server.listen(0, '127.0.0.1')}`;
});
after(async () => {
  await server.close();
  store.close();
});

async function get(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text), headers: res.headers };
}

const ok = async (path: string): Promise<any> => {
  const r = await get(path);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
  return r.body;
};

describe('status and stats', () => {
  it('reports heads, index, node, runtime and genesis', async () => {
    assert.deepEqual(await ok('/api/status'), { best: LAST + 2, finalized: LAST, indexed: LAST, node: 'up', specVersion: 2, genesis: GENESIS });
  });

  it('has unknown heads before the node was ever reached', async () => {
    const offline = new ExplorerApi({ store, origins: [], log: quiet });
    const port = await offline.listen(0, '127.0.0.1');
    try {
      const st = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as Record<string, unknown>;
      assert.deepEqual([st.best, st.finalized, st.indexed, st.node], [null, null, LAST, 'down']);
    } finally {
      await offline.close();
    }
  });

  it('gives the counts and the number of authorities', async () => {
    const s = await ok('/api/stats');
    assert.equal(s.blocks, LAST + 1);
    assert.equal(s.transfers, LAST - 1);
    assert.equal(s.attestations, 2);
    assert.equal(s.authorities, 2);
  });
});

describe('blocks', () => {
  it('pages blocks newest first with a numeric cursor', async () => {
    const p1 = await ok('/api/blocks?limit=10');
    assert.deepEqual(p1.items.map((b: BlockRow) => b.number), [120, 119, 118, 117, 116, 115, 114, 113, 112, 111]);
    assert.equal(p1.next, 111);
    assert.equal(p1.items[0].timestamp, T0 + 120 * 6000);
    const p3 = await ok('/api/blocks?limit=10&cursor=10');
    assert.equal(p3.items.length, 10);
    assert.equal(p3.next, null);
  });

  it('caps the limit at 100 and defaults it to 25', async () => {
    assert.equal((await ok('/api/blocks')).items.length, 25);
    assert.equal((await ok('/api/blocks?limit=5000')).items.length, 100);
    assert.equal((await ok('/api/blocks?limit=1000000')).items.length, 100);
    assert.equal((await ok(`/api/blocks?limit=${'9'.repeat(400)}`)).items.length, 100);
    assert.equal((await ok('/api/blocks?limit=007')).items.length, 7);
    // leading zeros are zeros, however many digits there are
    assert.equal((await ok('/api/blocks?limit=0005')).items.length, 5);
    assert.equal((await ok('/api/blocks?limit=00000010')).items.length, 10);
    assert.equal((await ok(`/api/blocks?limit=${'0'.repeat(400)}5`)).items.length, 5);
    assert.equal((await ok('/api/extrinsics?limit=0003')).items.length, 3);
    assert.equal((await ok('/api/blocks?limit=0100')).items.length, 100);
    assert.equal((await ok('/api/blocks?limit=0101')).items.length, 100);
  });

  it('refuses a bad limit or cursor with 400', async () => {
    for (const q of ['limit=0', 'limit=000', 'limit=-1', 'limit=abc', 'limit=1e3', 'limit=', 'cursor=abc', 'cursor=-3', `cursor=${'9'.repeat(30)}`]) {
      const r = await get(`/api/blocks?${q}`);
      assert.equal(r.status, 400, q);
      assert.match(r.body.error, /^bad_(limit|cursor)$/);
    }
    assert.deepEqual((await get('/api/extrinsics?cursor=nope')).body, { error: 'bad_cursor' });
  });

  it('shows a block by number or hash, with summarized extrinsics and its events', async () => {
    const b = await ok('/api/block/5');
    assert.equal(b.hash, hash(0x10, 5));
    assert.equal(b.extrinsics.length, 2);
    assert.equal(b.events.length, 1);
    const sudo = b.extrinsics[1];
    assert.equal(sudo.args, undefined);
    assert.deepEqual(sudo.inner, [{ pallet: 'identitee', method: 'set_username_for' }]);
    assert.equal(sudo.timestamp, T0 + 5 * 6000);
    assert.equal(b.events[0].timestamp, T0 + 5 * 6000);
    assert.equal((await ok(`/api/block/${hash(0x10, 5).toUpperCase().replace('0X', '0x')}`)).number, 5);
  });

  it('names the author of each listed block from the labels, null when it has none', async () => {
    const items = (await ok('/api/blocks?limit=4')).items;
    assert.deepEqual(items.map((b: any) => [b.number, b.author, b.authorLabel]), [
      [120, ALICE_HEX, 'identitee-01'],
      [119, BOB_HEX, null],
      [118, ALICE_HEX, 'identitee-01'],
      [117, BOB_HEX, null],
    ]);
    assert.equal(items[0].authoritySetId, 1);
    assert.ok(items[0].justificationSigners === null);
  });

  it('gives the block detail its labels, its signers, its authority set and its digest logs', async () => {
    live.reads.length = 0;
    const b = await ok('/api/block/10');
    assert.equal(b.author, ALICE_HEX);
    assert.equal(b.authorLabel, 'identitee-01');
    assert.deepEqual(b.justificationSigners, [ALICE_HEX, BOB_HEX]);
    assert.deepEqual(b.signers, [{ key: ALICE_HEX, label: 'identitee-01' }, { key: BOB_HEX, label: null }]);
    assert.equal(b.authoritySetId, 0);
    assert.deepEqual(b.authoritySet, { id: 0, members: [{ key: ALICE_HEX, label: 'identitee-01' }, { key: BOB_HEX, label: null }] });
    assert.deepEqual(b.logs, LOGS);
    // read at that block, by its hash
    assert.deepEqual([...live.reads].sort(), [`grandpa ${hash(0x10, 10)}`, `logs ${hash(0x10, 10)}`]);
    // the old fields are all still there
    for (const k of ['number', 'hash', 'parentHash', 'stateRoot', 'extrinsicsRoot', 'timestamp', 'specVersion', 'extrinsicCount', 'eventCount', 'extrinsics', 'events']) assert.ok(k in b, k);
  });

  it('has no signers without a justification, and the id of the set in force', async () => {
    const b = await ok('/api/block/105');
    assert.equal(b.signers, null);
    assert.equal(b.justificationSigners, null);
    assert.equal(b.authoritySet.id, 1);
    assert.equal(b.authorLabel, null);
  });

  it('matches labels whatever the case of the configured key', async () => {
    const mixed = new ExplorerApi({ store, live, origins: [], labels: { [ALICE_HEX.toUpperCase().replace('0X', '0x')]: 'upper' }, log: quiet });
    const port = await mixed.listen(0, '127.0.0.1');
    try {
      const b = (await (await fetch(`http://127.0.0.1:${port}/api/block/10`)).json()) as any;
      assert.equal(b.authorLabel, 'upper');
      assert.equal(b.signers[0].label, 'upper');
      assert.equal(b.authoritySet.members[0].label, 'upper');
    } finally {
      await mixed.close();
    }
  });

  it('keeps the labels, and nulls what only the node knows, when the node is down', async () => {
    live.up = false;
    try {
      const r = await get('/api/block/10');
      assert.equal(r.status, 200);
      assert.equal(r.body.authorLabel, 'identitee-01');
      assert.deepEqual(r.body.signers, [{ key: ALICE_HEX, label: 'identitee-01' }, { key: BOB_HEX, label: null }]);
      assert.deepEqual(r.body.authoritySet, { id: 0, members: null });
      assert.equal(r.body.logs, null);
      assert.equal(r.body.extrinsics.length, 2);
      // an answer without its live parts is not kept by a cache
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal((await ok('/api/blocks?limit=2')).items[0].authorLabel, 'identitee-01');
    } finally {
      live.up = true;
    }
  });

  it('drops only the part the node cannot give, and does not let a cache keep the gap', async () => {
    live.failLogs = true;
    try {
      const r = await get('/api/block/10');
      assert.equal(r.status, 200);
      assert.equal(r.body.logs, null);
      assert.equal(r.body.authoritySet.members.length, 2);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    } finally {
      live.failLogs = false;
    }
    live.failMembers = true;
    try {
      const r = await get('/api/block/10');
      assert.deepEqual(r.body.authoritySet, { id: 0, members: null });
      assert.deepEqual(r.body.logs, LOGS);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    } finally {
      live.failMembers = false;
    }
    assert.match((await get('/api/block/10')).headers.get('cache-control') ?? '', /max-age=300/);
  });

  it('gives up on a node that does not answer within the live timeout', async () => {
    live.hang = true;
    try {
      const started = Date.now();
      const r = await get('/api/block/10');
      assert.equal(r.status, 200);
      assert.equal(r.body.logs, null);
      assert.equal(r.body.authorLabel, 'identitee-01');
      assert.ok(Date.now() - started < 2000);
    } finally {
      live.hang = false;
    }
  });

  it('answers 404 not_found for an unknown block and 400 for a malformed id', async () => {
    const missing = await get('/api/block/999');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'not_found' });
    assert.equal((await get(`/api/block/0x${'ee'.repeat(32)}`)).status, 404);
    assert.equal((await get('/api/block/abc')).status, 400);
    assert.equal((await get('/api/block/%E0%A4%A')).status, 400);
  });
});

describe('extrinsics and events', () => {
  it('pages extrinsics with summaries and timestamps', async () => {
    const p = await ok('/api/extrinsics?limit=3');
    assert.deepEqual(p.items.map((x: ExtrinsicRow) => x.id), ['120-1', '120-0', '119-1']);
    assert.equal(p.next, '119-1');
    assert.ok(p.items.every((x: any) => x.args === undefined && Array.isArray(x.inner) && x.timestamp === T0 + x.block * 6000));
    const next = await ok(`/api/extrinsics?limit=3&cursor=${p.next}`);
    assert.equal(next.items[0].id, '119-0');
  });

  it('filters extrinsics by signer (any address form) and pallet', async () => {
    const p = await ok(`/api/extrinsics?signer=${ALICE_HEX}&limit=100`);
    assert.equal(p.items.length, 100);
    assert.equal((await ok(`/api/extrinsics?signer=${ALICE}&limit=100&cursor=${p.next}`)).items.length, LAST - 100);
    assert.ok(p.items.every((x: ExtrinsicRow) => x.signer === ALICE));
    assert.equal((await ok('/api/extrinsics?pallet=sudo')).items.length, 1);
    assert.equal((await get('/api/extrinsics?signer=nobody')).status, 400);
  });

  it('lists only the signed extrinsics with signed=1, paginated like the others', async () => {
    const p = await ok('/api/extrinsics?signed=1&limit=3');
    assert.deepEqual(p.items.map((x: ExtrinsicRow) => x.id), ['120-1', '119-1', '118-1']);
    assert.equal(p.next, '118-1');
    assert.ok(p.items.every((x: any) => x.signer !== null && x.args === undefined && Array.isArray(x.inner) && x.timestamp === T0 + x.block * 6000));
    const next = await ok(`/api/extrinsics?signed=1&limit=3&cursor=${p.next}`);
    assert.deepEqual(next.items.map((x: ExtrinsicRow) => x.id), ['117-1', '116-1', '115-1']);
    const all = await ok('/api/extrinsics?signed=1&limit=100&cursor=101-0');
    assert.equal(all.items.length, 100);
    assert.equal(all.next, null);
    assert.ok(all.items.every((x: ExtrinsicRow) => x.signer !== null));
    assert.equal((await ok('/api/extrinsics?signed=1&limit=100&cursor=1-1')).items.length, 0);
    // the same list unfiltered holds the unsigned inherents too
    assert.equal((await ok('/api/extrinsics?limit=3')).items.filter((x: ExtrinsicRow) => x.signer === null).length, 1);
  });

  it('combines signed with the other filters and treats 0 or nothing as no filter', async () => {
    assert.deepEqual((await ok('/api/extrinsics?signed=1&pallet=sudo')).items.map((x: ExtrinsicRow) => x.id), ['5-1']);
    assert.deepEqual((await ok('/api/extrinsics?signed=1&pallet=timestamp')).items, []);
    assert.equal((await ok(`/api/extrinsics?signed=1&signer=${BOB}`)).items.length, 0);
    assert.equal((await ok(`/api/extrinsics?signed=1&signer=${ALICE}&limit=2`)).items.length, 2);
    for (const q of ['signed=0', 'signed=']) assert.deepEqual((await ok(`/api/extrinsics?${q}&limit=3`)).items.map((x: ExtrinsicRow) => x.id), ['120-1', '120-0', '119-1'], q);
    for (const q of ['signed=yes', 'signed=true', 'signed=2']) assert.deepEqual((await get(`/api/extrinsics?${q}`)).body, { error: 'bad_signed' }, q);
  });

  it('shows an extrinsic by id with its full args and its events', async () => {
    const x = await ok('/api/extrinsic/5-1');
    assert.equal(x.args.call.args.name, 'bob');
    assert.equal(x.timestamp, T0 + 5 * 6000);
    assert.deepEqual(x.events, []);
    const t = await ok('/api/extrinsic/3-1');
    assert.deepEqual(t.events.map((e: EventRow) => e.method), ['Transfer']);
  });

  it('shows an extrinsic by hash, or its matches when the hash is included twice', async () => {
    assert.equal((await ok(`/api/extrinsic/${hash(0xa1, 3)}`)).id, '3-1');
    const m = await ok(`/api/extrinsic/${DUP.toUpperCase().replace('0X', '0x')}`);
    assert.deepEqual(m.matches.map((x: ExtrinsicRow) => x.id), ['11-1', '10-1']);
    assert.equal(m.matches[0].args, undefined);
    assert.equal((await get('/api/extrinsic/999-0')).status, 404);
    assert.equal((await get('/api/extrinsic/x-y')).status, 400);
  });

  it('pages events and filters them', async () => {
    const p = await ok('/api/events?limit=2');
    assert.deepEqual(p.items.map((e: EventRow) => e.id), ['120-1', '120-0']);
    assert.equal(p.items[0].timestamp, T0 + 120 * 6000);
    const named = await ok('/api/events?pallet=identitee&method=NameClaimed');
    assert.deepEqual(named.items.map((e: EventRow) => e.id), ['9-2', '8-2']);
    assert.equal((await get('/api/events?pallet=a%27%20OR%201%3D1')).status, 400);
  });

  it('refuses a method filter without its pallet, which would read every event', async () => {
    const r = await get('/api/events?method=NameClaimed');
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'method_needs_pallet' });
    assert.equal((await ok('/api/events?pallet=identitee&method=')).items.length > 0, true);
  });

  it('filters extrinsics by signer and pallet together', async () => {
    assert.deepEqual((await ok(`/api/extrinsics?signer=${ALICE}&pallet=sudo`)).items.map((x: ExtrinsicRow) => x.id), ['5-1']);
    assert.deepEqual((await ok(`/api/extrinsics?signer=${BOB}&pallet=sudo`)).items, []);
  });
});

describe('accounts', () => {
  it('gives balance, nonce, identity, roles and the profile URL', async () => {
    const a = await ok(`/api/account/${ALICE_GENERIC}`);
    assert.deepEqual(a, {
      address: ALICE,
      publicKey: ALICE_HEX,
      balance: { free: '5000000000000', reserved: '0', frozen: '0' },
      nonce: 3,
      identity: { display: 'Alice', username: 'alice', trust: 'Unknown' },
      roles: { sudo: true, validator: true, agent: [] },
      profileUrl: 'https://identit.ee/alice',
      node: 'up',
    });
  });

  it('links a reserved username through the address', async () => {
    assert.equal((await ok(`/api/account/${BOB}`)).profileUrl, `https://identit.ee/a/${BOB}`);
  });

  it('refuses an invalid address', async () => {
    for (const a of ['nobody', `${ALICE.slice(0, -1)}x`, '0x1234']) assert.deepEqual((await get(`/api/account/${a}`)).body, { error: 'bad_address' });
  });

  it('pages the history of an address', async () => {
    const p = await ok(`/api/account/${ALICE}/history?limit=2`);
    assert.deepEqual(p.items.map((i: any) => [i.kind, i.item.id]), [['extrinsic', '120-1'], ['extrinsic', '119-1']]);
    assert.equal(p.next, '119-x-1');
    assert.equal(p.items[0].timestamp, T0 + 120 * 6000);
    assert.equal(p.items[0].item.args, undefined);
    const bobs = await ok(`/api/account/${BOB}/history?limit=1&cursor=120-e-1`);
    assert.deepEqual(bobs.items.map((i: any) => [i.kind, i.item.id]), [['event', '119-1']]);
    assert.equal((await get(`/api/account/${BOB}/history?cursor=28-1`)).status, 400);
  });

  it('pages the transfers of an address', async () => {
    const p = await ok(`/api/account/${BOB}/transfers?limit=2`);
    assert.deepEqual(p.items.map((t: any) => t.eventId), ['120-1', '119-1']);
    assert.equal(p.items[0].timestamp, T0 + 120 * 6000);
    assert.equal(p.items[0].sentence, 'alice sent 1 IDT to bob');
  });
});

describe('identitee feeds', () => {
  it('lists the authorities', async () => {
    assert.deepEqual((await ok('/api/authorities')).items, AUTHORITIES);
  });

  it('shows an authority with its recent attestations', async () => {
    const a = await ok('/api/authority/1');
    assert.equal(a.name, 'example.com');
    assert.deepEqual(a.attestations.items.map((x: any) => x.eventId), ['6-2']);
    assert.equal((await get('/api/authority/7')).status, 404);
    assert.equal((await get('/api/authority/x')).status, 400);
  });

  it('pages attestations, migrations and usernames with timestamps', async () => {
    const at = await ok('/api/attestations');
    assert.deepEqual(at.items.map((x: any) => x.eventId), ['6-2', '4-2']);
    assert.deepEqual((await ok('/api/attestations?authority=0')).items.map((x: any) => x.eventId), ['4-2']);
    assert.equal(at.items[0].timestamp, T0 + 6 * 6000);
    const mig = await ok('/api/migrations');
    assert.deepEqual(mig.items.map((x: any) => [x.eventId, x.timestamp]), [['7-2', T0 + 7 * 6000]]);
    const names = await ok('/api/usernames?limit=1');
    assert.deepEqual(names.items.map((x: any) => x.name), ['010']);
    assert.equal(names.next, '9-2');
  });
});

describe('runtime and network', () => {
  it('gives the current runtime, its history and the pallets', async () => {
    const r = await ok('/api/runtime');
    assert.deepEqual(r.current, { specName: 'identitee', specVersion: 2 });
    assert.deepEqual(r.versions, [
      { specVersion: 1, fromBlock: 0, specName: 'identitee' },
      { specVersion: 2, fromBlock: 20, specName: 'identitee' },
    ]);
    assert.equal(r.pallets[0].calls[0].name, 'remark');
  });

  it('gives the validators, health, block time and GRANDPA set', async () => {
    const n = await ok('/api/network');
    assert.equal(n.validators.aura[0].label, 'identitee-01');
    assert.equal(n.health.peers, 2);
    assert.deepEqual(n.blockTime, { target: 6000, recent: 6000 });
    assert.equal(n.grandpaSetId, 0);
  });

  it('reads pallets with calls, events, errors, storage and constants from metadata', () => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, readFileSync(new URL('./fixtures/explorer-metadata.hex', import.meta.url), 'utf8').trim() as `0x${string}`);
    registry.setMetadata(metadata);
    const pallets = palletsOf(metadata);
    const identitee = pallets.find((p) => p.name === 'Identitee');
    assert.ok(identitee);
    assert.ok(identitee.calls.some((c) => c.name === 'claim_username'));
    assert.ok(identitee.events.some((e) => e.name === 'NameClaimed'));
    assert.ok(identitee.errors.length > 0);
    assert.ok(identitee.storage.some((s) => s.name === 'NameOwner' && s.docs !== ''));
    const system = pallets.find((p) => p.name === 'System');
    assert.ok(system?.constants.some((c) => c.name === 'BlockHashCount'));
  });
});

describe('search', () => {
  const cases: Array<[string, string, string, Array<{ kind: string; target: string }>?]> = [
    ['12', 'block', '12'],
    ['010', 'block', '10', [{ kind: 'username', target: BOB }]],
    ['500', 'none', ''],
    [hash(0x10, 7), 'block', '7'],
    [hash(0x10, 7).toUpperCase().replace('0X', '0x'), 'block', '7'],
    [hash(0xa1, 3), 'extrinsic', '3-1'],
    [hash(0xa1, 3).toUpperCase().replace('0X', '0x'), 'extrinsic', '3-1'],
    [DUP, 'extrinsic', DUP],
    ['3-1', 'extrinsic', '3-1'],
    ['999-1', 'none', ''],
    [ALICE_GENERIC, 'account', ALICE],
    [ALICE_HEX, 'account', ALICE],
    ['alice', 'username', ALICE],
    ['@Alice', 'username', ALICE],
    ['carol', 'none', ''],
    [`0x${'a'.repeat(63)}`, 'none', ''],
    [`${ALICE.slice(0, -1)}${ALICE.endsWith('a') ? 'b' : 'a'}`, 'none', ''],
    ["'; DROP TABLE blocks; --", 'none', ''],
    ['%_*', 'none', ''],
  ];
  for (const [q, kind, target, alternatives] of cases) {
    it(`resolves ${JSON.stringify(q.slice(0, 30))} to ${kind}`, async () => {
      const r = await ok(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(r.kind, kind);
      assert.equal(r.target, target);
      assert.deepEqual(r.alternatives.map((a: any) => ({ kind: a.kind, target: a.target })), alternatives ?? []);
    });
  }

  it('names the username of an alternative', async () => {
    assert.equal((await ok('/api/search?q=010')).alternatives[0].name, '010');
  });

  it('refuses an empty or oversized query with 400', async () => {
    for (const q of ['', '   ', 'x'.repeat(10_000)]) assert.deepEqual((await get(`/api/search?q=${q}`)).body, { error: 'bad_query' });
    assert.equal((await get('/api/search')).status, 400);
  });
});

describe('http', () => {
  it('sets CORS for an allowed origin only', async () => {
    assert.equal((await get('/api/status', { headers: { origin: DEFAULT_ORIGIN } })).headers.get('access-control-allow-origin'), DEFAULT_ORIGIN);
    assert.equal((await get('/api/status', { headers: { origin: DEV_ORIGIN } })).headers.get('access-control-allow-origin'), DEV_ORIGIN);
    const other = await get('/api/status', { headers: { origin: 'https://example.com' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('varies on Origin on every answer, cacheable ones included', async () => {
    for (const init of [{}, { headers: { origin: DEFAULT_ORIGIN } }, { headers: { origin: 'https://example.com' } }]) {
      const block = await get('/api/block/3', init);
      assert.match(block.headers.get('cache-control') ?? '', /max-age/);
      assert.equal(block.headers.get('vary'), 'Origin');
      assert.equal((await get('/api/extrinsic/3-1', init)).headers.get('vary'), 'Origin');
      assert.equal((await get('/api/nothing', init)).headers.get('vary'), 'Origin');
    }
  });

  it('answers 405 to anything but GET and 404 to an unknown path', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await get('/api/blocks', { method });
      assert.equal(r.status, 405, method);
      assert.deepEqual(r.body, { error: 'method_not_allowed' });
    }
    assert.deepEqual((await get('/api/nothing')).body, { error: 'not_found' });
    assert.equal((await get('/')).status, 404);
  });

  it('sends JSON with nosniff', async () => {
    const r = await get('/api/blocks');
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('live', () => {
  it('streams a head event on each change, and pings', { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/live`, { signal: controller.signal, headers: { origin: DEFAULT_ORIGIN } });
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(res.headers.get('access-control-allow-origin'), DEFAULT_ORIGIN);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (pred: (t: string) => boolean): Promise<void> => {
      while (!pred(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        text += decoder.decode(value);
      }
    };
    await until((t) => t.includes('event: head'));
    assert.match(text, new RegExp(`data: \\{"best":${LAST + 2},"finalized":${LAST},"indexed":${LAST}\\}`));
    heads.fire({ best: LAST + 5, finalized: LAST + 3 });
    await until((t) => t.includes(`"best":${LAST + 5}`));
    assert.match(text, new RegExp(`event: head\\ndata: \\{"best":${LAST + 5},"finalized":${LAST + 3},"indexed":${LAST}\\}\\n\\n`));
    await until((t) => t.includes(': ping'));
    // the node goes away: the next check of the stream sends unknown heads, the index stays
    live.up = false;
    try {
      await until((t) => t.includes('"best":null'));
      assert.match(text, new RegExp(`event: head\\ndata: \\{"best":null,"finalized":null,"indexed":${LAST}\\}\\n\\n`));
    } finally {
      live.up = true;
    }
    await until((t) => t.split('event: head').length > 4);
    controller.abort();
    heads.fire({ best: LAST + 2, finalized: LAST });
  });
});

describe('live clients cap', () => {
  it('refuses a stream over the cap with 503 too_many_clients, and takes one again when a client leaves', { timeout: 5000 }, async () => {
    const capped = new ExplorerApi({ store, live, heads: fakeHeads(), origins: [DEFAULT_ORIGIN], log: quiet, maxClients: 1 });
    const url = `http://127.0.0.1:${await capped.listen(0, '127.0.0.1')}/api/live`;
    try {
      const first = new AbortController();
      const res = await fetch(url, { signal: first.signal });
      assert.equal(res.status, 200);
      await res.body!.getReader().read();
      const refused = await fetch(url);
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: 'too_many_clients' });
      first.abort();
      for (let i = 0; i < 50; i++) {
        const again = await fetch(url);
        if (again.status === 200) {
          await again.body!.cancel();
          return;
        }
        await again.text();
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail('the slot of the closed client was never freed');
    } finally {
      await capped.close();
    }
  });
});

describe('node down', () => {
  it('keeps serving the index and says the node is down', async () => {
    live.up = false;
    try {
      const s = await ok('/api/status');
      assert.equal(s.node, 'down');
      assert.equal(s.best, null, 'the last heads seen are not the node\'s current ones');
      assert.equal(s.finalized, null);
      assert.equal(s.indexed, LAST);
      assert.equal(s.specVersion, 2);
      assert.equal((await ok('/api/blocks')).items.length, 25);
      assert.equal((await ok('/api/block/3')).number, 3);
      assert.equal((await ok('/api/stats')).authorities, null);
      const a = await ok(`/api/account/${ALICE}`);
      assert.equal(a.node, 'down');
      assert.equal(a.balance, null);
      assert.equal(a.profileUrl, `https://identit.ee/a/${ALICE}`);
      assert.deepEqual((await get('/api/network')).body, { error: 'node_down' });
      assert.equal((await get('/api/authorities')).status, 503);
      assert.equal((await ok('/api/search?q=12')).kind, 'block');
      assert.equal((await ok('/api/search?q=alice')).kind, 'none');
    } finally {
      live.up = true;
    }
  });
});

describe('connected guard', () => {
  it('does not read from a node that says it is disconnected', async () => {
    const stale = { ...fakeLive(), connected: () => false };
    const guarded = new ExplorerApi({ store, live: stale, heads: fakeHeads(), origins: [], log: quiet });
    const port = await guarded.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/network`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'node_down' });
      const account = (await (await fetch(`http://127.0.0.1:${port}/api/account/${ALICE}`)).json()) as { balance: unknown };
      assert.equal(account.balance, null);
    } finally {
      await guarded.close();
    }
  });
});

describe('digest logs', () => {
  it('reads the type, the engine and the bytes of each digest item of a header', () => {
    const registry = new TypeRegistry();
    const header = registry.createType('Header', {
      parentHash: hash(1, 1),
      number: 7,
      stateRoot: hash(2, 1),
      extrinsicsRoot: hash(3, 1),
      digest: {
        logs: [
          { PreRuntime: ['0x61757261', '0x0a0b0c0d00000000'] },
          { Consensus: ['0x46524e4b', '0x01'] },
          { Seal: ['0x61757261', `0x${'11'.repeat(64)}`] },
          { Other: '0xdeadbeef' },
          { RuntimeEnvironmentUpdated: null },
          { PreRuntime: ['0xff00ff7f', '0x'] },
        ],
      },
    });
    assert.deepEqual(digestLogs(header), [
      { type: 'PreRuntime', engine: 'aura', data: '0x0a0b0c0d00000000' },
      { type: 'Consensus', engine: 'FRNK', data: '0x01' },
      { type: 'Seal', engine: 'aura', data: `0x${'11'.repeat(64)}` },
      { type: 'Other', engine: null, data: '0xdeadbeef' },
      { type: 'RuntimeEnvironmentUpdated', engine: null, data: '0x' },
      { type: 'PreRuntime', engine: '0xff00ff7f', data: '0x' },
    ]);
  });

  it('gives an empty list for a header without logs', () => {
    const header = new TypeRegistry().createType('Header', { number: 1 });
    assert.deepEqual(digestLogs(header), []);
  });
});

describe('call summary', () => {
  it('lists nested calls depth first', () => {
    const args = { calls: [{ pallet: 'sudo', method: 'sudo', args: { call: { pallet: 'balances', method: 'transfer', args: {} } } }, { pallet: 'system', method: 'remark', args: { remark: 'hi' } }] };
    assert.deepEqual(callSummary(args), [
      { pallet: 'sudo', method: 'sudo' },
      { pallet: 'balances', method: 'transfer' },
      { pallet: 'system', method: 'remark' },
    ]);
    assert.deepEqual(callSummary({ dest: BOB, value: '1' }), []);
  });
});

describe('config', () => {
  it('has the defaults of the brief', () => {
    const c = parseConfig({});
    assert.deepEqual(c, {
      db: '/var/lib/identitee-explorer/explorer.db',
      node: 'ws://127.0.0.1:9944',
      port: 8788,
      host: '127.0.0.1',
      origins: [DEFAULT_ORIGIN],
      dev: false,
      labels: {},
    });
    assert.deepEqual(parseConfig({ EXPLORER_DEV: '1' }).origins, ['https://explorer.identit.ee', 'http://localhost:5174']);
    assert.throws(() => parseConfig({ EXPLORER_PORT: 'x' }), /EXPLORER_PORT/);
  });

  it('reads validator labels, keys lowercased, and refuses bad ones', () => {
    const key = `0x${'AB'.repeat(32)}`;
    assert.deepEqual(parseConfig({ EXPLORER_LABELS: '/labels.json' }, () => JSON.stringify({ [key]: 'identitee-01' })).labels, { [key.toLowerCase()]: 'identitee-01' });
    assert.throws(() => parseLabels('[]'), /object/);
    assert.throws(() => parseLabels('{"alice":"x"}'), /hex key/);
    assert.throws(() => parseLabels(`{"${key}":3}`), /label/);
    assert.throws(() => parseLabels('{'), /JSON/);
  });

  it('keeps the reserved paths equal to the identit.ee app', () => {
    const source = readFileSync(new URL('../../web/src/routes.ts', import.meta.url), 'utf8');
    const m = /export const RESERVED_PATHS: readonly string\[\] = \[([^\]]*)\]/.exec(source);
    assert.ok(m, 'RESERVED_PATHS not found in web/src/routes.ts');
    assert.deepEqual([...RESERVED_PATHS], JSON.parse(`[${m[1]}]`));
  });

  it('builds profile URLs like the app', () => {
    assert.equal(profileUrl('alice', ALICE), 'https://identit.ee/alice');
    assert.equal(profileUrl(null, ALICE), `https://identit.ee/a/${ALICE}`);
    assert.equal(profileUrl('', ALICE), `https://identit.ee/a/${ALICE}`);
    for (const name of RESERVED_PATHS) assert.equal(profileUrl(name, ALICE), `https://identit.ee/a/${ALICE}`);
  });
});

describe('main', () => {
  it('refuses a bad configuration with exit code 2', async () => {
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      assert.equal(await main({ EXPLORER_PORT: 'x' }), 2);
    } finally {
      process.stderr.write = stderr;
    }
  });
});

describe('keepIndexing', () => {
  it('starts again after a rejection, waiting longer each time', async () => {
    let calls = 0;
    const waits: number[] = [];
    const logged: string[] = [];
    const log: Logger = (_level, event) => void logged.push(event);
    const loop = keepIndexing(
      async () => {
        calls++;
        if (calls <= 2) throw new Error(`down ${calls}`);
      },
      log,
      { retryMs: 1000, maxRetryMs: 30_000, sleep: async (ms) => void waits.push(ms) },
    );
    await loop.done;
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(logged.filter((e) => e === 'indexer_failed').length, 2);
  });

  it('caps the wait and stops retrying once stopped', async () => {
    let calls = 0;
    const waits: number[] = [];
    let loop: ReturnType<typeof keepIndexing> | undefined;
    loop = keepIndexing(
      async () => {
        calls++;
        throw new Error('down');
      },
      quiet,
      {
        retryMs: 1000,
        maxRetryMs: 4000,
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 5) loop?.stop();
        },
      },
    );
    await loop.done;
    assert.deepEqual(waits, [1000, 2000, 4000, 4000, 4000]);
    assert.equal(calls, 5);
  });
});
