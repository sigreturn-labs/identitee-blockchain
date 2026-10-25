// Tests of the explorer's SQLite store (src/explorer/store.ts): no network, no chain.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BadCursorError,
  ExplorerStore,
  migrate,
  type AccountLink,
  type BlockRow,
  type EventRow,
  type ExtrinsicRow,
  type Extras,
  type Page,
} from '../src/explorer/store.ts';

const GENESIS = `0x${'ab'.repeat(32)}`;
const OTHER_GENESIS = `0x${'cd'.repeat(32)}`;
const ALICE = 'alice';
const BOB = 'bob';
const hash = (tag: number, n: number): string => `0x${tag.toString(16).padStart(2, '0')}${n.toString(16).padStart(62, '0')}`;
const empty = (): Extras => ({ transfers: [], attestations: [], migrations: [], usernames: [] });

interface Fixture {
  block: BlockRow;
  xts: ExtrinsicRow[];
  evs: EventRow[];
  links: AccountLink[];
  extras: Extras;
}

function xt(n: number, index: number, over: Partial<ExtrinsicRow> = {}): ExtrinsicRow {
  return {
    id: `${n}-${index}`,
    block: n,
    index,
    hash: hash(0xa0 + index, n),
    pallet: 'system',
    method: 'remark',
    args: {},
    signer: null,
    nonce: null,
    tip: null,
    fee: null,
    success: true,
    error: null,
    ...over,
  };
}

function ev(n: number, index: number, extrinsicIndex: number | null, pallet: string, method: string, data: unknown = {}, sentence: string | null = null): EventRow {
  return { id: `${n}-${index}`, block: n, index, extrinsicIndex, pallet, method, data, sentence };
}

/**
 * Block `n`: a timestamp inherent, a transfer by alice to bob, and an attestation request by bob
 * (failed on even blocks). Events: 0 success of the inherent, 1 the transfer, 2 the request or its
 * failure; `migration` and `username` add one more event each, with their feed row.
 */
function fixture(n: number, o: { migration?: boolean; username?: boolean } = {}): Fixture {
  const failed = n % 2 === 0;
  const xts = [
    xt(n, 0, { pallet: 'timestamp', method: 'set', args: { now: String(1_700_000_000_000 + n * 6000) } }),
    xt(n, 1, { pallet: 'balances', method: 'transfer_keep_alive', args: { dest: BOB, value: '1000000000000' }, signer: ALICE, nonce: n, tip: '0', fee: '125000' }),
    xt(n, 2, {
      pallet: 'identitee',
      method: 'request_attestation',
      args: { authority: 0, target: { field: 'Email' } },
      signer: BOB,
      nonce: n,
      tip: '0',
      fee: '98000',
      success: !failed,
      error: failed ? { pallet: 'identitee', name: 'NoSuchAuthority', docs: 'The authority does not exist.' } : null,
    }),
  ];
  const evs = [
    ev(n, 0, 0, 'system', 'ExtrinsicSuccess'),
    ev(n, 1, 1, 'balances', 'Transfer', { from: ALICE, to: BOB, amount: '1000000000000' }, 'alice sent 1 IDT to bob'),
    failed
      ? ev(n, 2, 2, 'system', 'ExtrinsicFailed')
      : ev(n, 2, 2, 'identitee', 'AttestationRequested', { who: BOB, authority: 0, target: { field: 'Email' } }, 'bob asked identitee to check Email'),
  ];
  const extras = empty();
  extras.transfers.push({ from: ALICE, to: BOB, amount: '1000000000000', block: n, extrinsicId: `${n}-1`, eventId: `${n}-1` });
  if (!failed) {
    extras.attestations.push({ who: BOB, authorityId: 0, kind: 'requested', target: { field: 'Email' }, data: null, block: n, eventId: `${n}-2` });
  }
  if (o.migration) {
    evs.push(ev(n, evs.length, null, 'identitee', 'MigrationFulfilled', { who: BOB, source: 'PeopleChain' }, 'bob migrated an identity'));
    extras.migrations.push({ who: BOB, kind: 'fulfilled', data: { source: 'PeopleChain', agent: ALICE }, block: n, eventId: `${n}-${evs.length - 1}` });
  }
  if (o.username) {
    evs.push(ev(n, evs.length, null, 'identitee', 'NameClaimed', { who: ALICE, name: 'alice' }, 'alice claimed the name alice'));
    extras.usernames.push({ name: 'alice', who: ALICE, kind: 'claimed', block: n, eventId: `${n}-${evs.length - 1}` });
  }
  const links: AccountLink[] = [
    { address: ALICE, itemKind: 'extrinsic', itemId: `${n}-1`, block: n },
    { address: ALICE, itemKind: 'event', itemId: `${n}-1`, block: n },
    { address: BOB, itemKind: 'extrinsic', itemId: `${n}-1`, block: n },
    { address: BOB, itemKind: 'event', itemId: `${n}-1`, block: n },
    { address: BOB, itemKind: 'extrinsic', itemId: `${n}-2`, block: n },
  ];
  if (!failed) links.push({ address: BOB, itemKind: 'event', itemId: `${n}-2`, block: n });
  const block: BlockRow = {
    number: n,
    hash: hash(0x10, n),
    parentHash: hash(0x10, n - 1),
    stateRoot: hash(0x20, n),
    extrinsicsRoot: hash(0x30, n),
    timestamp: 1_700_000_000_000 + n * 6000,
    specVersion: 1,
    author: ALICE,
    authoritySetId: 0,
    justificationSigners: n % 3 === 0 ? [ALICE, BOB] : null,
    extrinsicCount: xts.length,
    eventCount: evs.length,
  };
  return { block, xts, evs, links, extras };
}

function write(store: ExplorerStore, f: Fixture): void {
  store.writeBlock(f.block, f.xts, f.evs, f.links, f.extras);
}

/** Write blocks 1..n; migrations on multiples of 3, usernames on multiples of 4. */
function fill(store: ExplorerStore, n: number): Fixture[] {
  const all: Fixture[] = [];
  for (let i = 1; i <= n; i++) {
    const f = fixture(i, { migration: i % 3 === 0, username: i % 4 === 0 });
    write(store, f);
    all.push(f);
  }
  return all;
}

/** `f` with identitee events of `who` appended, in this order (no extrinsic, no link). */
function withIdentity(f: Fixture, events: Array<[method: string, who: string]>): Fixture {
  const evs = [...f.evs];
  for (const [method, who] of events) evs.push(ev(f.block.number, evs.length, null, 'identitee', method, { who }));
  return { ...f, evs, block: { ...f.block, eventCount: evs.length } };
}

/** Follow `next` until null; every page must hold at most `limit` items. */
function drain<T>(read: (cursor: string | null) => Page<T>, limit: number): T[] {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = read(cursor);
    assert.ok(page.items.length <= limit, 'page larger than the limit');
    out.push(...page.items);
    if (page.next === null) return out;
    assert.ok(page.items.length > 0, 'a next cursor on an empty page');
    cursor = page.next;
  }
  throw new Error('the cursor never ended');
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
const fillRows = (target: ExplorerStore, n: number): void => void fill(target, n);

let store: ExplorerStore;
beforeEach(() => {
  store = new ExplorerStore(':memory:');
});
afterEach(() => {
  store.close();
});

describe('writing and reading', () => {
  it('starts empty', () => {
    assert.equal(store.lastIndexed(), null);
    assert.deepEqual(store.counts(), { blocks: 0, extrinsics: 0, events: 0, accounts: 0, transfers: 0, attestations: 0, migrations: 0, usernames: 0, identities: 0 });
    assert.deepEqual(store.blocks(null, 10), { items: [], next: null });
    assert.deepEqual(store.runtimes(), []);
  });

  it('returns every row it was given', () => {
    const f = fixture(1, { migration: true, username: true });
    write(store, f);

    assert.equal(store.lastIndexed(), 1);
    assert.deepEqual(store.block(1), f.block);
    assert.deepEqual(store.block(f.block.hash), f.block);
    assert.deepEqual(store.block(f.block.hash.toUpperCase().replace('0X', '0x')), f.block, 'a hash is found whatever its case');
    assert.equal(store.block(2), null);
    assert.equal(store.block(hash(0x99, 9)), null);

    assert.deepEqual(store.extrinsic('1-1'), f.xts[1]);
    assert.deepEqual(store.extrinsic('1-2'), f.xts[2], 'the error survives');
    assert.equal(store.extrinsic('1-9'), null);
    assert.equal(store.extrinsic('not an id'), null);
    assert.deepEqual(store.extrinsicByHash(f.xts[1]!.hash), [f.xts[1]]);
    assert.deepEqual(store.extrinsicByHash(hash(0x99, 9)), []);
    assert.deepEqual(store.extrinsicsOfBlock(1), f.xts);
    assert.deepEqual(store.eventsOfBlock(1), f.evs);
    assert.deepEqual(store.eventsOfBlock(2), []);

    assert.deepEqual(ids(store.extrinsics(null, 10).items), ['1-2', '1-1', '1-0']);
    assert.deepEqual(ids(store.events(null, 10).items), ['1-4', '1-3', '1-2', '1-1', '1-0']);

    const transfers = store.transfers(null, null, 10).items;
    assert.deepEqual(transfers, [{ ...f.extras.transfers[0], sentence: 'alice sent 1 IDT to bob' }]);
    assert.deepEqual(store.attestations(null, 10).items, [{ ...f.extras.attestations[0], sentence: 'bob asked identitee to check Email' }]);
    assert.deepEqual(store.migrations(null, 10).items, [{ ...f.extras.migrations[0], sentence: 'bob migrated an identity' }]);
    assert.deepEqual(store.usernames(null, 10).items, [{ ...f.extras.usernames[0], sentence: 'alice claimed the name alice' }]);

    assert.deepEqual(store.counts(), { blocks: 1, extrinsics: 3, events: 5, accounts: 2, transfers: 1, attestations: 1, migrations: 1, usernames: 1, identities: 1 });
  });

  it('keeps null and empty values as they are', () => {
    const f = fixture(1);
    f.block.timestamp = null;
    f.block.author = null;
    f.xts[0]!.args = null;
    f.evs[0]!.data = [];
    write(store, f);
    assert.deepEqual(store.block(1), f.block);
    assert.deepEqual(store.extrinsic('1-0'), f.xts[0]);
    assert.deepEqual(store.eventsOfBlock(1)[0], f.evs[0]);
  });

  it('finds a hash that repeats, newest first', () => {
    const a = fixture(1);
    const b = fixture(2);
    b.xts[1]!.hash = a.xts[1]!.hash;
    write(store, a);
    write(store, b);
    assert.deepEqual(ids(store.extrinsicByHash(a.xts[1]!.hash)), ['2-1', '1-1']);
  });

  it('lets the indexer resume: the highest block is the last indexed one', () => {
    fill(store, 4);
    assert.equal(store.lastIndexed(), 4);
  });

  it('counts the same as the tables hold', () => {
    fill(store, 12);
    const c = store.counts();
    assert.equal(c.blocks, 12);
    assert.equal(c.extrinsics, 36);
    assert.equal(c.events, 12 * 3 + 4 + 3);
    assert.equal(c.accounts, 2);
    assert.equal(c.transfers, 12);
    assert.equal(c.attestations, 6);
    assert.equal(c.migrations, 4);
    assert.equal(c.usernames, 3);
    assert.equal(drain((cur) => store.extrinsics(cur, 7), 7).length, c.extrinsics);
    assert.equal(drain((cur) => store.events(cur, 7), 7).length, c.events);
  });
});

describe('atomic writes', () => {
  it('leaves nothing behind when an extras insert throws', () => {
    write(store, fixture(1));
    const before = store.counts();
    const f = fixture(2, { migration: true });
    f.extras.transfers[0]!.from = null as unknown as string; // NOT NULL violated after the block, extrinsics, events and links went in
    assert.throws(() => write(store, f), /NOT NULL/);

    assert.equal(store.lastIndexed(), 1);
    assert.deepEqual(store.counts(), before);
    assert.equal(store.block(2), null);
    assert.equal(store.extrinsic('2-1'), null);
    assert.deepEqual(store.eventsOfBlock(2), []);
    assert.equal(drain((cur) => store.accountHistory(ALICE, cur, 50), 50).some((h) => h.block === 2), false);
    assert.deepEqual(store.migrations(null, 10).items, []);

    // the same block can then be written properly
    write(store, fixture(2, { migration: true }));
    assert.equal(store.lastIndexed(), 2);
    assert.equal(store.counts().blocks, 2);
  });

  it('refuses a block written twice, and keeps the first', () => {
    const f = fixture(1);
    write(store, f);
    assert.throws(() => write(store, fixture(1)), /UNIQUE|PRIMARY/);
    assert.deepEqual(store.counts(), { blocks: 1, extrinsics: 3, events: 3, accounts: 2, transfers: 1, attestations: 1, migrations: 0, usernames: 0, identities: 0 });
    assert.deepEqual(store.block(1), f.block);
  });

  it('refuses rows that do not belong together, before touching the database', () => {
    const wrongBlock = fixture(3);
    wrongBlock.evs[1]!.block = 4;
    assert.throws(() => write(store, wrongBlock), /block/);

    const wrongCount = fixture(3);
    wrongCount.block.eventCount = 99;
    assert.throws(() => write(store, wrongCount), /eventCount/);

    const wrongId = fixture(3);
    wrongId.xts[1]!.id = '3-7';
    assert.throws(() => write(store, wrongId), /3-7/);

    const strayLink = fixture(3);
    strayLink.links.push({ address: ALICE, itemKind: 'event', itemId: '3-40', block: 3 });
    assert.throws(() => write(store, strayLink), /3-40/);

    const strayFeed = fixture(3);
    strayFeed.extras.transfers[0]!.eventId = '3-40';
    assert.throws(() => write(store, strayFeed), /3-40/);

    const strayEvent = fixture(3);
    strayEvent.evs[0]!.extrinsicIndex = 12;
    assert.throws(() => write(store, strayEvent), /extrinsic/);

    assert.equal(store.lastIndexed(), null);
    assert.equal(store.counts().events, 0);
  });
});

describe('pagination', () => {
  it('pages blocks newest first, strictly older than the cursor, without overlap', () => {
    fill(store, 7);
    const first = store.blocks(null, 3);
    assert.deepEqual(first.items.map((b) => b.number), [7, 6, 5]);
    assert.equal(first.next, 5);
    const second = store.blocks(first.next, 3);
    assert.deepEqual(second.items.map((b) => b.number), [4, 3, 2]);
    assert.equal(second.next, 2);
    const third = store.blocks(second.next, 3);
    assert.deepEqual(third.items.map((b) => b.number), [1]);
    assert.equal(third.next, null);
    assert.equal(store.blocks(null, 7).next, null, 'a page that ends exactly with the data has no next');
    assert.equal(store.blocks(null, 6).next, 2);
    assert.deepEqual(store.blocks(100, 3).items.map((b) => b.number), [7, 6, 5], 'a cursor above the head reads from the head');
    assert.deepEqual(store.blocks(1, 3), { items: [], next: null });
  });

  it('pages extrinsics across block boundaries', () => {
    fill(store, 5);
    const all = drain((cur) => store.extrinsics(cur, 4), 4);
    const expected = [5, 4, 3, 2, 1].flatMap((b) => [2, 1, 0].map((i) => `${b}-${i}`));
    assert.deepEqual(ids(all), expected);
    assert.equal(store.extrinsics(null, 4).next, '4-2', 'the cursor is the id of the last item');
    assert.deepEqual(ids(store.extrinsics('3-1', 2).items), ['3-0', '2-2']);
  });

  it('pages events across block boundaries', () => {
    fill(store, 4);
    const all = drain((cur) => store.events(cur, 5), 5);
    const expected = [4, 3, 2, 1].flatMap((b) => {
      const count = 3 + (b % 3 === 0 ? 1 : 0) + (b % 4 === 0 ? 1 : 0);
      return Array.from({ length: count }, (_, i) => `${b}-${count - 1 - i}`);
    });
    assert.deepEqual(ids(all), expected);
  });

  it('pages every feed', () => {
    fill(store, 12);
    const transfers = drain((cur) => store.transfers(null, cur, 5), 5);
    assert.deepEqual(transfers.map((t) => t.block), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const attestations = drain((cur) => store.attestations(cur, 4), 4);
    assert.deepEqual(attestations.map((a) => a.block), [11, 9, 7, 5, 3, 1]);
    const migrations = drain((cur) => store.migrations(cur, 3), 3);
    assert.deepEqual(migrations.map((m) => m.block), [12, 9, 6, 3]);
    const usernames = drain((cur) => store.usernames(cur, 2), 2);
    assert.deepEqual(usernames.map((u) => u.block), [12, 8, 4]);
    assert.equal(new Set(attestations.map((a) => a.eventId)).size, attestations.length);
  });

  it('filters extrinsics and events, and pages the filtered lists', () => {
    fill(store, 6);
    const bobs = drain((cur) => store.extrinsics(cur, 2, { signer: BOB }), 2);
    assert.deepEqual(ids(bobs), ['6-2', '5-2', '4-2', '3-2', '2-2', '1-2']);
    assert.deepEqual(ids(store.extrinsics(null, 10, { pallet: 'balances' }).items), ['6-1', '5-1', '4-1', '3-1', '2-1', '1-1']);
    assert.deepEqual(ids(store.extrinsics(null, 10, { signer: ALICE, pallet: 'identitee' }).items), []);
    assert.deepEqual(ids(store.extrinsics(null, 10, { signer: BOB, pallet: 'identitee' }).items), ['6-2', '5-2', '4-2', '3-2', '2-2', '1-2']);
    assert.deepEqual(store.extrinsics(null, 10, { signer: 'nobody' }), { items: [], next: null });

    assert.deepEqual(ids(drain((cur) => store.events(cur, 2, { pallet: 'identitee', method: 'AttestationRequested' }), 2)), ['5-2', '3-2', '1-2']);
    assert.deepEqual(ids(store.events(null, 20, { pallet: 'identitee' }).items), ['6-3', '5-2', '4-3', '3-3', '3-2', '1-2']);
    assert.deepEqual(ids(store.events(null, 20, { pallet: 'balances', method: 'Nope' }).items), []);
  });

  it('lists only the signed extrinsics, alone or with another filter, and pages the list', () => {
    fill(store, 6);
    const signed = drain((cur) => store.extrinsics(cur, 3, { signed: true }), 3);
    assert.deepEqual(ids(signed), ['6-2', '6-1', '5-2', '5-1', '4-2', '4-1', '3-2', '3-1', '2-2', '2-1', '1-2', '1-1']);
    assert.ok(signed.every((x) => x.signer !== null));
    assert.deepEqual(ids(store.extrinsics(null, 10, { signed: true, pallet: 'balances' }).items), ['6-1', '5-1', '4-1', '3-1', '2-1', '1-1']);
    assert.deepEqual(ids(store.extrinsics(null, 10, { signed: true, signer: BOB }).items), ['6-2', '5-2', '4-2', '3-2', '2-2', '1-2']);
    assert.deepEqual(ids(store.extrinsics(null, 2, { signed: true }).items), ['6-2', '6-1']);
    // false is no filter at all
    assert.equal(store.extrinsics(null, 100, { signed: false }).items.length, 18);
    assert.deepEqual(store.extrinsics(null, 10, { signed: true, pallet: 'timestamp' }), { items: [], next: null });
  });

  it('filters the transfers by address, from or to, a self transfer once', () => {
    fill(store, 3);
    const selfTransfer = fixture(4);
    selfTransfer.extras.transfers[0] = { from: ALICE, to: ALICE, amount: '5', block: 4, extrinsicId: '4-1', eventId: '4-1' };
    selfTransfer.evs[1]!.sentence = null;
    write(store, selfTransfer);

    assert.deepEqual(drain((cur) => store.transfers(ALICE, cur, 2), 2).map((t) => t.block), [4, 3, 2, 1]);
    assert.deepEqual(drain((cur) => store.transfers(BOB, cur, 2), 2).map((t) => t.block), [3, 2, 1]);
    assert.deepEqual(store.transfers('nobody', null, 5), { items: [], next: null });
    assert.equal(store.transfers(ALICE, null, 10).items[0]!.sentence, null, 'no sentence when the event has none');
    assert.equal(store.transfers(ALICE, null, 10).items[1]!.sentence, 'alice sent 1 IDT to bob');
  });

  it('filters the attestations by authority', () => {
    fill(store, 5);
    const f = fixture(6);
    f.extras.attestations.push({ who: ALICE, authorityId: 3, kind: 'attested', target: { field: 'X' }, data: { agent: BOB }, block: 6, eventId: '6-1' });
    write(store, f);
    assert.deepEqual(store.attestations(null, 10, { authority: 3 }).items.map((a) => a.block), [6]);
    assert.deepEqual(store.attestations(null, 10, { authority: 0 }).items.map((a) => a.block), [5, 3, 1]);
    assert.deepEqual(store.attestations(null, 10).items.map((a) => a.block), [6, 5, 3, 1]);
    assert.deepEqual(store.attestations(null, 10, { authority: 3 }).items[0]!.data, { agent: BOB });
  });

  it('rejects a bad cursor or limit instead of guessing', () => {
    fill(store, 2);
    assert.throws(() => store.extrinsics('garbage', 5), BadCursorError);
    assert.throws(() => store.events('1-', 5), BadCursorError);
    assert.throws(() => store.events('1-2-3', 5), BadCursorError);
    assert.throws(() => store.transfers(null, "1-1'; DROP TABLE blocks; --", 5), BadCursorError);
    assert.throws(() => store.accountHistory(ALICE, '1-1', 5), BadCursorError);
    assert.throws(() => store.blocks(-1, 5), BadCursorError);
    assert.throws(() => store.blocks(1.5, 5), BadCursorError);
    assert.throws(() => store.blocks(null, 0), RangeError);
    assert.throws(() => store.blocks(null, 2.5), RangeError);
    assert.equal(store.counts().blocks, 2);
  });
});

describe('account history', () => {
  it('merges the extrinsics and events of one address, newest first', () => {
    fill(store, 3);
    const all = drain((cur) => store.accountHistory(BOB, cur, 100), 100);
    // bob: extrinsic 1 and 2 and event 1 in every block, event 2 where the request went through
    const label = (h: (typeof all)[number]): string => `${h.block}:${h.kind}:${h.item.index}`;
    assert.deepEqual(all.map(label), [
      '3:event:2', '3:event:1', '3:extrinsic:2', '3:extrinsic:1',
      '2:event:1', '2:extrinsic:2', '2:extrinsic:1',
      '1:event:2', '1:event:1', '1:extrinsic:2', '1:extrinsic:1',
    ]);
    const first = all[0]!;
    assert.equal(first.kind, 'event');
    if (first.kind === 'event') assert.equal(first.item.method, 'AttestationRequested');
    const failed = all.find((h) => h.kind === 'extrinsic' && h.item.id === '2-2');
    assert.ok(failed && failed.kind === 'extrinsic' && failed.item.success === false && failed.item.error?.name === 'NoSuchAuthority');
  });

  it('pages the merged list with a cursor that falls between the two kinds', () => {
    fill(store, 3);
    const everything = drain((cur) => store.accountHistory(BOB, cur, 100), 100).map((h) => `${h.block}:${h.kind}:${h.item.index}`);
    for (const limit of [1, 2, 3, 4, 5]) {
      const paged = drain((cur) => store.accountHistory(BOB, cur, limit), limit).map((h) => `${h.block}:${h.kind}:${h.item.index}`);
      assert.deepEqual(paged, everything, `limit ${limit}`);
    }
  });

  it('keeps addresses apart, and counts an address once however many links it has', () => {
    fill(store, 2);
    const f = fixture(3);
    f.links.push({ address: ALICE, itemKind: 'extrinsic', itemId: '3-1', block: 3 }); // a repeat
    f.links.push({ address: 'charlie', itemKind: 'extrinsic', itemId: '3-0', block: 3 });
    write(store, f);
    assert.deepEqual(drain((cur) => store.accountHistory('charlie', cur, 10), 10).map((h) => `${h.block}:${h.kind}:${h.item.index}`), ['3:extrinsic:0']);
    assert.equal(drain((cur) => store.accountHistory(ALICE, cur, 10), 10).length, 6);
    assert.equal(store.counts().accounts, 3);
    assert.deepEqual(store.accountHistory('nobody', null, 10), { items: [], next: null });
  });
});

describe('block times and genesis', () => {
  it('gives the timestamp of each indexed block asked for, null for the others', () => {
    fill(store, 3);
    const times = store.blockTimes([3, 1, 3, 9]);
    assert.deepEqual([...times.entries()].sort((a, b) => a[0] - b[0]), [[1, 1_700_000_006_000], [3, 1_700_000_018_000], [9, null]]);
    assert.equal(store.blockTimes([]).size, 0);
    const many = Array.from({ length: 1200 }, (_, i) => i);
    assert.equal(store.blockTimes(many).get(2), 1_700_000_012_000, 'more numbers than one statement takes');
  });

  it('gives the stored genesis hash', () => {
    assert.equal(store.genesis(), null);
    store.openForGenesis(GENESIS.toUpperCase().replace('0X', '0x'));
    assert.equal(store.genesis(), GENESIS);
  });
});

describe('runtime versions', () => {
  it('keeps every version, in block order', () => {
    store.recordRuntime(2, 400, 'identitee');
    store.recordRuntime(1, 0, 'identitee');
    store.recordRuntime(3, 900, 'identitee-next');
    assert.deepEqual(store.runtimes(), [
      { specVersion: 1, fromBlock: 0, specName: 'identitee' },
      { specVersion: 2, fromBlock: 400, specName: 'identitee' },
      { specVersion: 3, fromBlock: 900, specName: 'identitee-next' },
    ]);
  });

  it('records a version once, and a return to an older one as a change', () => {
    store.recordRuntime(1, 0, 'identitee');
    store.recordRuntime(1, 0, 'identitee');
    store.recordRuntime(1, 5, 'identitee');
    assert.equal(store.runtimes().length, 1, 'the block is replayed, or later blocks repeat the version: nothing new');
    store.recordRuntime(2, 10, 'identitee');
    store.recordRuntime(1, 20, 'identitee');
    assert.deepEqual(store.runtimes().map((r) => [r.specVersion, r.fromBlock]), [[1, 0], [2, 10], [1, 20]]);
  });
});

describe('genesis', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'explorer-store-'));
    path = join(dir, 'explorer.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the data when the genesis is the same, also across a restart', () => {
    const a = new ExplorerStore(path);
    assert.deepEqual(a.openForGenesis(GENESIS), { reset: false });
    fill(a, 3);
    assert.deepEqual(a.openForGenesis(GENESIS), { reset: false });
    assert.equal(a.lastIndexed(), 3);
    a.close();

    const b = new ExplorerStore(path);
    assert.deepEqual(b.openForGenesis(GENESIS), { reset: false });
    assert.equal(b.lastIndexed(), 3);
    assert.equal(b.counts().blocks, 3);
    b.close();
    assert.deepEqual(readdirBaks(dir), []);
  });

  it('moves a marked database aside on the next open even with the same genesis', () => {
    const a = new ExplorerStore(path);
    a.openForGenesis(GENESIS);
    fill(a, 3);
    a.markChainChanged();
    a.close();

    const b = new ExplorerStore(path);
    assert.deepEqual(b.openForGenesis(GENESIS), { reset: true });
    assert.equal(b.lastIndexed(), null);
    assert.ok(existsSync(`${path}.abababab.bak`));
    assert.deepEqual(b.openForGenesis(GENESIS), { reset: false }, 'the new database is not marked');
    b.close();
  });

  it('moves a database of another genesis aside and starts empty', () => {
    const a = new ExplorerStore(path);
    a.openForGenesis(GENESIS);
    fill(a, 3);
    a.recordRuntime(1, 0, 'identitee');

    assert.deepEqual(a.openForGenesis(OTHER_GENESIS), { reset: true });
    assert.equal(a.lastIndexed(), null);
    assert.deepEqual(a.counts(), { blocks: 0, extrinsics: 0, events: 0, accounts: 0, transfers: 0, attestations: 0, migrations: 0, usernames: 0, identities: 0 });
    assert.deepEqual(a.runtimes(), []);
    assert.deepEqual(a.blocks(null, 10), { items: [], next: null });

    const bak = `${path}.abababab.bak`;
    assert.ok(existsSync(bak), 'the old database is kept next to the new one');
    assert.ok(existsSync(path));

    // the new database works, and remembers its genesis
    write(a, fixture(1));
    assert.deepEqual(a.openForGenesis(OTHER_GENESIS), { reset: false });
    assert.equal(a.lastIndexed(), 1);
    a.close();

    // the old one still holds its three blocks
    const old = new ExplorerStore(bak);
    assert.equal(old.lastIndexed(), 3);
    assert.equal(old.counts().blocks, 3);
    assert.deepEqual(old.openForGenesis(GENESIS), { reset: false });
    old.close();
  });

  it('never overwrites an older backup of the same genesis', () => {
    const a = new ExplorerStore(path);
    a.openForGenesis(GENESIS);
    fill(a, 2);
    a.openForGenesis(OTHER_GENESIS);
    fill(a, 3);
    assert.deepEqual(a.openForGenesis(GENESIS), { reset: true });
    fill(a, 4);
    assert.deepEqual(a.openForGenesis(OTHER_GENESIS), { reset: true });
    a.close();

    assert.deepEqual(readdirBaks(dir).length, 3);
    const lasts = readdirBaks(dir).map((name) => {
      const s = new ExplorerStore(join(dir, name));
      const last = s.lastIndexed();
      s.close();
      return last;
    });
    assert.deepEqual(lasts.sort((a, b) => (a ?? 0) - (b ?? 0)), [2, 3, 4]);
  });

  it('just clears an in-memory store', () => {
    store.openForGenesis(GENESIS);
    fill(store, 2);
    assert.deepEqual(store.openForGenesis(OTHER_GENESIS), { reset: true });
    assert.equal(store.lastIndexed(), null);
    assert.equal(store.counts().events, 0);
    assert.deepEqual(store.openForGenesis(OTHER_GENESIS), { reset: false });
  });

  it('refuses a genesis that is not a 32-byte hash', () => {
    for (const bad of ['', '0x', 'abab', '0x../../etc/passwd', `0x${'zz'.repeat(32)}`, `0x${'ab'.repeat(31)}`]) {
      assert.throws(() => store.openForGenesis(bad), /genesis/, bad);
    }
  });
});

function readdirBaks(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith('.bak') || /\.bak\.\d+$/.test(n));
}

describe('identities', () => {
  it('counts the accounts whose last identity event set something', () => {
    const st = new ExplorerStore(':memory:');
    write(st, withIdentity(fixture(1), [['FieldSet', ALICE], ['BioSet', ALICE], ['AvatarSet', BOB]]));
    assert.equal(st.counts().identities, 2);
    // a field cleared alone keeps the identity; the identity cleared drops it
    write(st, withIdentity(fixture(2), [['FieldCleared', ALICE], ['IdentityCleared', BOB]]));
    assert.equal(st.counts().identities, 1);
    // cleared then set again in one block: counted; set then purged in one block: not
    write(st, withIdentity(fixture(3), [['IdentityCleared', ALICE], ['LinkAdded', ALICE], ['FieldSet', BOB], ['IdentityPurged', BOB]]));
    assert.equal(st.counts().identities, 1);
    // clearing an account that holds none changes nothing
    write(st, withIdentity(fixture(4), [['IdentityPurged', BOB]]));
    assert.equal(st.counts().identities, 1);
    st.close();
  });
});

describe('schema versions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'explorer-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const version = (path: string): number => {
    const db = new DatabaseSync(path);
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();
    return row.user_version;
  };

  it('stamps a new database and reopens it without running the schema again', () => {
    const path = join(dir, 'explorer.db');
    const a = new ExplorerStore(path);
    write(a, fixture(1));
    a.close();
    assert.equal(version(path), 4);
    const b = new ExplorerStore(path);
    assert.equal(b.lastIndexed(), 1);
    b.close();
    assert.equal(version(path), 4);
  });

  it('adds the signed-extrinsics index to a database of version 1, rows kept', () => {
    const path = join(dir, 'explorer.db');
    const a = new ExplorerStore(path);
    fillRows(a, 3);
    a.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX extrinsics_signed; DROP INDEX extrinsics_pallet_signed; DROP INDEX extrinsics_by_signer_pallet; DROP TABLE identities; DELETE FROM totals WHERE name = 'identities'; PRAGMA user_version = 1");
    raw.close();
    const b = new ExplorerStore(path);
    assert.equal(b.lastIndexed(), 3);
    assert.deepEqual(ids(b.extrinsics(null, 10, { signed: true }).items), ['3-2', '3-1', '2-2', '2-1', '1-2', '1-1']);
    b.close();
    assert.equal(version(path), 4);
    const check = new DatabaseSync(path);
    assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'extrinsics_signed'").get());
    check.close();
  });

  it('adds the filter indexes to a database of version 2, rows kept', () => {
    const path = join(dir, 'explorer.db');
    const a = new ExplorerStore(path);
    fillRows(a, 3);
    a.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX extrinsics_pallet_signed; DROP INDEX extrinsics_by_signer_pallet; DROP TABLE identities; DELETE FROM totals WHERE name = 'identities'; PRAGMA user_version = 2");
    raw.close();
    const b = new ExplorerStore(path);
    assert.equal(b.lastIndexed(), 3);
    assert.equal(b.extrinsics(null, 10, { pallet: 'balances', signed: true }).items.length, b.extrinsics(null, 10, { pallet: 'balances' }).items.length);
    b.close();
    assert.equal(version(path), 4);
    const check = new DatabaseSync(path);
    for (const name of ['extrinsics_pallet_signed', 'extrinsics_by_signer_pallet']) {
      assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name), name);
    }
    check.close();
  });

  it('reads every filtered list from one index range, never a whole table', () => {
    const store = new ExplorerStore(':memory:');
    const xt: Array<[Record<string, unknown>, string]> = [
      [{ signed: true }, 'extrinsics_signed'],
      [{ pallet: 'balances' }, 'extrinsics_by_pallet'],
      [{ pallet: 'balances', signed: true }, 'extrinsics_pallet_signed'],
      [{ signer: ALICE }, 'extrinsics_by_signer'],
      [{ signer: ALICE, signed: true }, 'extrinsics_by_signer'],
      [{ signer: ALICE, pallet: 'balances' }, 'extrinsics_by_signer_pallet'],
      [{ signer: ALICE, pallet: 'balances', signed: true }, 'extrinsics_by_signer_pallet'],
    ];
    const ev: Array<[Record<string, unknown>, string]> = [
      [{ pallet: 'identitee' }, 'events_by_pallet'],
      [{ pallet: 'identitee', method: 'NameClaimed' }, 'events_by_name'],
    ];
    for (const [list, cases] of [['extrinsics', xt], ['events', ev]] as const) {
      for (const [filter, index] of cases) {
        for (const cursor of [null, '2-1']) {
          const plan = store.queryPlan(list, cursor, filter).join('\n');
          assert.match(plan, new RegExp(`^(SEARCH|SCAN) ${list} USING INDEX ${index}\\b`), `${list} ${JSON.stringify(filter)} ${cursor}: ${plan}`);
          assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
        }
      }
    }
    // unfiltered: the primary key, newest first, stopped by the limit
    assert.doesNotMatch(store.queryPlan('extrinsics', null).join('\n'), /TEMP B-TREE|USING INDEX/);
    assert.throws(() => store.events(null, 10, { method: 'NameClaimed' }), /needs its pallet/);
    store.close();
  });

  it('counts the identities of a database of version 3 from its events', () => {
    const path = join(dir, 'explorer.db');
    const a = new ExplorerStore(path);
    write(a, withIdentity(fixture(1), [['FieldSet', ALICE], ['AvatarSet', BOB]]));
    write(a, withIdentity(fixture(2), [['IdentityPurged', BOB], ['ProfileUpdated', ALICE]]));
    write(a, withIdentity(fixture(3), [['IdentityCleared', ALICE], ['BioSet', ALICE]]));
    assert.equal(a.counts().identities, 1);
    a.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE identities; DELETE FROM totals WHERE name = 'identities'; PRAGMA user_version = 3");
    raw.close();
    const b = new ExplorerStore(path);
    assert.equal(b.counts().identities, 1);
    write(b, withIdentity(fixture(4), [['FieldSet', BOB]]));
    assert.equal(b.counts().identities, 2);
    b.close();
    assert.equal(version(path), 4);
  });

  it('refuses a database written by a newer version', () => {
    const path = join(dir, 'explorer.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => new ExplorerStore(path), /schema version 99/);
  });

  it('applies the missing steps in order, each in one transaction', () => {
    const db = new DatabaseSync(':memory:');
    const steps = ['CREATE TABLE a (x INTEGER)', 'ALTER TABLE a ADD COLUMN y TEXT'];
    migrate(db, steps.slice(0, 1));
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    migrate(db, steps);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    db.exec("INSERT INTO a (x, y) VALUES (1, 'one')");
    migrate(db, steps); // nothing left to do

    // a failing step leaves the version and the schema where they were
    assert.throws(() => migrate(db, [...steps, 'CREATE TABLE b (z INTEGER); CREATE TABLE a (x INTEGER)']), /already exists/);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    assert.throws(() => db.prepare('SELECT z FROM b').get(), /no such table/);
    db.close();
  });
});
