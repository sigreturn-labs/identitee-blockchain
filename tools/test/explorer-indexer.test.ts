// Tests of the explorer indexer (src/explorer/indexer.ts) against a fake chain: an object with the
// part of `ApiPromise` the indexer uses, blocks without extrinsics or events. No network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';

import { callArgs, feedRow, Indexer, truncateLarge } from '../src/explorer/indexer.ts';
import { ExplorerStore } from '../src/explorer/store.ts';
import type { Logger } from '../src/migrator.ts';

const hashOf = (n: number): string => `0x${'ab'}${n.toString(16).padStart(62, '0')}`;
const numberOf = (hash: string): number => parseInt(hash.slice(4), 16);
const codec = (hex: string) => ({ toHex: () => hex, toString: () => hex });
const num = (n: number) => ({ toNumber: () => n, toString: () => String(n) });

const header = (n: number) => ({
  number: num(n),
  hash: codec(hashOf(n)),
  parentHash: codec(n === 0 ? `0x${'00'.repeat(32)}` : hashOf(n - 1)),
  stateRoot: codec(`0x${'01'.repeat(32)}`),
  extrinsicsRoot: codec(`0x${'02'.repeat(32)}`),
  digest: { logs: [] },
});

interface FakeChain {
  api: ApiPromise;
  /** Blocks fetched with getBlock, in order. */
  fetched: number[];
  finalize(n: number): void;
  newHead(n: number): void;
  unsubscribed: number;
}

/** A chain whose finalized head is `finalized`; getBlock of `failAt` throws once. */
function fakeChain(finalized: number, failAt?: number): FakeChain {
  let head = finalized;
  let failed = false;
  const finalizedSubs: Array<(h: unknown) => void> = [];
  const newSubs: Array<(h: unknown) => void> = [];
  const chain: FakeChain = {
    api: undefined as unknown as ApiPromise,
    fetched: [],
    unsubscribed: 0,
    finalize(n) {
      head = n;
      for (const cb of finalizedSubs) cb(header(n));
    },
    newHead(n) {
      for (const cb of newSubs) cb(header(n));
    },
  };
  const subscribe = (list: Array<(h: unknown) => void>, first: () => number) => async (cb: (h: unknown) => void) => {
    list.push(cb);
    cb(header(first()));
    return () => {
      chain.unsubscribed++;
      list.splice(list.indexOf(cb), 1);
    };
  };
  const api = {
    genesisHash: codec(hashOf(0)),
    rpc: {
      chain: {
        getFinalizedHead: async () => codec(hashOf(head)),
        getHeader: async (h: { toHex(): string } | string) => header(numberOf(typeof h === 'string' ? h : h.toHex())),
        getBlockHash: async (n: number) => {
          assert.ok(n <= head, `block ${n} asked while the finalized head is ${head}`);
          return codec(hashOf(n));
        },
        getBlock: async (h: { toHex(): string }) => {
          const n = numberOf(h.toHex());
          if (n === failAt && !failed) {
            failed = true;
            throw new Error('connection lost');
          }
          chain.fetched.push(n);
          return { block: { header: header(n), extrinsics: [] }, justifications: { isSome: false, isNone: true } };
        },
        subscribeFinalizedHeads: subscribe(finalizedSubs, () => head),
        subscribeNewHeads: subscribe(newSubs, () => head),
      },
    },
    at: async (h: { toHex(): string } | string) => {
      const n = numberOf(typeof h === 'string' ? h : h.toHex());
      return {
        runtimeVersion: { specVersion: num(8), specName: { toString: () => 'identitee' } },
        registry: {},
        query: {
          system: { events: async () => [] },
          timestamp: { now: async () => num(n === 0 ? 0 : 1_000_000 + n * 6000) },
          grandpa: { currentSetId: async () => num(0) },
          aura: { authorities: async () => [] },
          identitee: { authorities: { entries: async () => [] } },
        },
      };
    },
  };
  chain.api = api as unknown as ApiPromise;
  return chain;
}

const quiet = (): { log: Logger; lines: Array<{ level: string; event: string }> } => {
  const lines: Array<{ level: string; event: string }> = [];
  return { log: (level, event) => lines.push({ level, event }), lines };
};

async function until(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const numbers = (store: ExplorerStore): number[] => store.blocks(null, 100).items.map((b) => b.number);

describe('Indexer', () => {
  it('catches up with the finalized head, block by block in order', async () => {
    const chain = fakeChain(4);
    const store = new ExplorerStore(':memory:');
    const indexer = new Indexer(chain.api, store, quiet().log);
    await indexer.start();
    assert.deepEqual(chain.fetched, [0, 1, 2, 3, 4]);
    assert.deepEqual(numbers(store), [4, 3, 2, 1, 0]);
    assert.equal(store.lastIndexed(), 4);
    const b3 = store.block(3)!;
    assert.equal(b3.hash, hashOf(3));
    assert.equal(b3.parentHash, hashOf(2));
    assert.equal(b3.timestamp, 1_000_000 + 3 * 6000);
    assert.equal(b3.specVersion, 8);
    assert.equal(b3.author, null);
    assert.equal(b3.justificationSigners, null);
    assert.equal(store.block(0)!.timestamp, null);
    assert.deepEqual(store.runtimes(), [{ specVersion: 8, fromBlock: 0, specName: 'identitee' }]);
    await indexer.stop();
    assert.equal(chain.unsubscribed, 2);
  });

  it('resumes at the block it was ingesting when it crashed, with no duplicate', async () => {
    const chain = fakeChain(4, 3);
    const store = new ExplorerStore(':memory:');
    const first = new Indexer(chain.api, store, quiet().log);
    await assert.rejects(first.start(), /connection lost/);
    await first.stop();
    assert.equal(store.lastIndexed(), 2);

    const second = new Indexer(chain.api, store, quiet().log);
    await second.start();
    assert.deepEqual(chain.fetched, [0, 1, 2, 3, 4]);
    assert.deepEqual(numbers(store), [4, 3, 2, 1, 0]);
    assert.equal(store.counts().blocks, 5);
    await second.stop();
  });

  it('fills the gap when the finalized head jumps', async () => {
    const chain = fakeChain(5);
    const store = new ExplorerStore(':memory:');
    const indexer = new Indexer(chain.api, store, quiet().log);
    await indexer.start();
    assert.equal(store.lastIndexed(), 5);
    chain.finalize(8);
    await until('block 8', () => store.lastIndexed() === 8);
    assert.deepEqual(chain.fetched.slice(6), [6, 7, 8]);
    assert.deepEqual(numbers(store), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await indexer.stop();
  });

  it('reports the best and finalized heights', async () => {
    const chain = fakeChain(2);
    const store = new ExplorerStore(':memory:');
    const indexer = new Indexer(chain.api, store, quiet().log);
    const heads: Array<{ best: number; finalized: number }> = [];
    indexer.onHead((h) => heads.push(h));
    await indexer.start();
    chain.newHead(4);
    chain.finalize(3);
    await until('block 3', () => store.lastIndexed() === 3);
    assert.deepEqual(heads.at(-1), { best: 4, finalized: 3 });
    assert.ok(heads.every((h) => h.best >= h.finalized));
    await indexer.stop();
  });

  it('retries a block that failed while following, and logs it', async () => {
    const chain = fakeChain(1, 3);
    const store = new ExplorerStore(':memory:');
    const { log, lines } = quiet();
    const indexer = new Indexer(chain.api, store, log, { retryMs: 10 });
    await indexer.start();
    chain.finalize(4);
    await until('block 4', () => store.lastIndexed() === 4);
    assert.deepEqual(numbers(store), [4, 3, 2, 1, 0]);
    assert.ok(lines.some((l) => l.level === 'warn' && l.event === 'ingest_failed'));
    await indexer.stop();
  });
});

describe('truncateLarge', () => {
  it('replaces bytes over 4 KB, in hex or text, by their length and blake2-256 hash', () => {
    const big = new Uint8Array(5000).fill(7);
    const hex = `0x${Buffer.from(big).toString('hex')}`;
    const text = 'a'.repeat(4097);
    const out = truncateLarge({ code: hex, nested: [{ note: text }], small: '0x0102', name: 'alice' });
    assert.deepEqual(out, {
      code: { bytes: 5000, hash: blake2AsHex(big, 256) },
      nested: [{ note: { bytes: 4097, hash: blake2AsHex(new TextEncoder().encode(text), 256) } }],
      small: '0x0102',
      name: 'alice',
    });
  });

  it('keeps 4 KB exactly', () => {
    const hex = `0x${'00'.repeat(4096)}`;
    assert.equal(truncateLarge(hex), hex);
  });
});

describe('callArgs', () => {
  it('puts each nested call back in full where it appears', () => {
    const set = { pallet: 'identitee', method: 'set_username_for', args: { who: 'bob', name: 'bob' }, inner: [] };
    const inner = { pallet: 'sudo', method: 'sudo_as', args: { who: 'alice', call: { pallet: 'identitee', method: 'set_username_for' } }, inner: [set] };
    const outer = { pallet: 'sudo', method: 'sudo', args: { call: { pallet: 'sudo', method: 'sudo_as' } }, inner: [inner] };
    assert.deepEqual(callArgs(outer), {
      call: { pallet: 'sudo', method: 'sudo_as', args: { who: 'alice', call: { pallet: 'identitee', method: 'set_username_for', args: { who: 'bob', name: 'bob' } } } },
    });
    assert.deepEqual(callArgs(set), { who: 'bob', name: 'bob' });
  });
});

describe('feedRow', () => {
  const at = { block: 9, eventId: '9-2', extrinsicId: '9-1' };
  const who = 'alice';

  it('turns transfers, attestations, facts, migrations and names into feed rows', () => {
    assert.deepEqual(feedRow('balances', 'Transfer', { from: 'alice', to: 'bob', amount: '1000' }, at), {
      feed: 'transfers', row: { from: 'alice', to: 'bob', amount: '1000', block: 9, extrinsicId: '9-1', eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'AttestationRequested', { who, authority: 0, target: { Field: { Typed: 'Email' } } }, at), {
      feed: 'attestations', row: { who, authorityId: 0, kind: 'requested', target: { Field: { Typed: 'Email' } }, data: null, block: 9, eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'FieldAttested', { who, key: { Typed: 'Email' }, authority: 1, verdict: 'Verified', agent: 'bob' }, at), {
      feed: 'attestations', row: { who, authorityId: 1, kind: 'attested', target: { Field: { Typed: 'Email' } }, data: { verdict: 'Verified', agent: 'bob' }, block: 9, eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'FactGranted', { who, kind: 'DocumentChecked', authority: 0, agent: 'bob' }, at), {
      feed: 'attestations', row: { who, authorityId: 0, kind: 'attested', target: { Fact: 'DocumentChecked' }, data: { agent: 'bob' }, block: 9, eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'FactRevoked', { who, kind: 'Fraud', authority: 0, reason: 'Other', agent: 'bob' }, at)?.row, {
      who, authorityId: 0, kind: 'revoked', target: { Fact: 'Fraud' }, data: { reason: 'Other', agent: 'bob' }, block: 9, eventId: '9-2',
    });
    assert.deepEqual(feedRow('identitee', 'RequestRejected', { who, authority: 0, target: { Fact: 'Fraud' }, reason: 'Abuse', note: '', agent: 'bob' }, at)?.row, {
      who, authorityId: 0, kind: 'rejected', target: { Fact: 'Fraud' }, data: { reason: 'Abuse', note: '', agent: 'bob' }, block: 9, eventId: '9-2',
    });
    assert.deepEqual(feedRow('identitee', 'MigrationFulfilled', { who, source: 'Polkadot', block: 5, block_hash: '0x00', agent: 'bob' }, at), {
      feed: 'migrations', row: { who, kind: 'fulfilled', data: { source: 'Polkadot', block: 5, block_hash: '0x00', agent: 'bob' }, block: 9, eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'NameReserved', { name: 'example' }, at), {
      feed: 'usernames', row: { name: 'example', who: null, kind: 'reserved', block: 9, eventId: '9-2' },
    });
    assert.deepEqual(feedRow('identitee', 'NameClaimed', { who, name: 'alice' }, at)?.row, { name: 'alice', who, kind: 'claimed', block: 9, eventId: '9-2' });
  });

  it('ignores other events', () => {
    assert.equal(feedRow('identitee', 'FieldSet', { who, key: { Typed: 'Email' } }, at), null);
    assert.equal(feedRow('system', 'ExtrinsicSuccess', {}, at), null);
  });
});
