// Tests of the migration service (src/migrator.ts, src/snapshot-file.ts) against a stub node:
// no network, no chain. The real chain is exercised by `npm run migrator:selftest`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { encodeAddress } from '@polkadot/util-crypto';

import {
  LivePeopleSource,
  Migrator,
  SnapshotSource,
  limitsOf,
  main,
  makeLogger,
  parseConfig,
  type Logger,
  type MainDeps,
  type MigratorOptions,
  type SourceReader,
  type SourceResult,
} from '../src/migrator.ts';
import type { MigrationPayloadJson, SourceName } from '../src/people.ts';
import { accountKey, parseSnapshot } from '../src/snapshot-file.ts';

// Two accounts, as 32 bytes and in the SS58 format of each chain.
const DAVE = '0x306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc20';
const EVE = '0xe659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e';
const form = (key: string, prefix: number): string => encodeAddress(key, prefix);

const hex = (text: string): string => `0x${Buffer.from(text, 'utf8').toString('hex')}`;

const PAYLOAD: MigrationPayloadJson = {
  typed: [['DisplayName', hex('Dave')]],
  custom: [],
  judgements: [[5, 'KnownGood']],
};

const SNAPSHOT_HASH = `0x${'ab'.repeat(32)}`;
const snapshotText = (identities: Record<string, unknown>, source = 'Polkadot'): string =>
  JSON.stringify({ source, block: 123, blockHash: SNAPSHOT_HASH, identities });

// --- Configuration and logging -------------------------------------------------------------------

describe('configuration', () => {
  it('reads the node, the key and the snapshots from the environment and the command line', () => {
    assert.deepEqual(parseConfig([], { IDENTITEE_MIGRATOR_SURI: '//Bob' }), {
      ws: 'ws://127.0.0.1:9944',
      suri: '//Bob',
      snapshots: [],
      pinned: {},
    });
    assert.deepEqual(
      parseConfig(['--snapshot', 'a.json', '--snapshot=b.json'], { IDENTITEE_MIGRATOR_SURI: '//Bob', IDENTITEE_WS: 'ws://node:1' }),
      { ws: 'ws://node:1', suri: '//Bob', snapshots: ['a.json', 'b.json'], pinned: {} },
    );
  });

  it('pins a People Chain to a block through PEOPLE_AT_BLOCK_POLKADOT / PEOPLE_AT_BLOCK_KUSAMA', () => {
    const polkadot = `0x${'aa'.repeat(32)}`;
    const kusama = `0x${'BB'.repeat(32)}`;
    assert.deepEqual(
      parseConfig([], { IDENTITEE_MIGRATOR_SURI: '//Bob', PEOPLE_AT_BLOCK_POLKADOT: polkadot, PEOPLE_AT_BLOCK_KUSAMA: kusama }).pinned,
      { Polkadot: polkadot, Kusama: `0x${'bb'.repeat(32)}` },
    );
    assert.throws(
      () => parseConfig([], { IDENTITEE_MIGRATOR_SURI: '//Bob', PEOPLE_AT_BLOCK_POLKADOT: 'latest' }),
      /PEOPLE_AT_BLOCK_POLKADOT must be a block hash/,
    );
  });

  it('refuses to run without a key, or with an argument it does not know, without echoing the key', () => {
    assert.throws(() => parseConfig([], {}), /IDENTITEE_MIGRATOR_SURI is not set/);
    assert.throws(() => parseConfig(['--snapshot'], { IDENTITEE_MIGRATOR_SURI: 'secret words' }), /--snapshot needs a file/);
    try {
      parseConfig(['--nope'], { IDENTITEE_MIGRATOR_SURI: 'secret words' });
      assert.fail('should throw');
    } catch (e) {
      assert.match(String(e), /unknown argument --nope/);
      assert.ok(!String(e).includes('secret words'));
    }
  });
});

describe('logging', () => {
  it('also removes the JSON-escaped form of a secret (quotes, backslashes, control characters)', () => {
    const secret = 'pa"ss\\word\nwith é';
    const lines: string[] = [];
    const log = makeLogger([secret], (l) => lines.push(l));
    log('error', 'fatal', { error: `could not use ${secret} here` }); // JSON puts it in the line escaped
    log('info', 'raw', { who: 'x', other: 'a plain secret-free value' });
    assert.ok(JSON.stringify(secret).slice(1, -1).length > secret.length - 1, 'the escaped form differs from the plain one');
    for (const line of lines) {
      assert.ok(!line.includes(JSON.stringify(secret).slice(1, -1)), 'escaped form present');
      assert.ok(!line.includes('pa"ss'), 'plain prefix present');
      JSON.parse(line);
    }
    assert.match(lines[0] as string, /\[redacted\]/);
  });

  it('writes one JSON object per line and removes the secrets from it', () => {
    const lines: string[] = [];
    const log = makeLogger(['secret words'], (l) => lines.push(l));
    log('info', 'fulfilled', { who: 'x', note: 'multi\nline value with secret words inside' });
    log('error', 'fatal');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'a single line');
      assert.ok(!line.includes('secret words'));
    }
    const first = JSON.parse(lines[0] as string);
    assert.equal(first.level, 'info');
    assert.equal(first.event, 'fulfilled');
    assert.match(first.ts, /^\d{4}-\d\d-\d\dT/);
    assert.match(first.note, /\[redacted\]/);
  });
});

// --- Snapshot files ------------------------------------------------------------------------------

describe('snapshot', () => {
  it('finds an account whatever the SS58 format it is written or asked in', async () => {
    const snapshot = parseSnapshot(snapshotText({ [form(DAVE, 0)]: PAYLOAD }));
    const source = new SnapshotSource([snapshot]);
    for (const prefix of [0, 2, 2426, 42]) {
      const read = await source.read('Polkadot', form(DAVE, prefix));
      assert.ok(read && read !== 'not-served', `format ${prefix}`);
      assert.equal(read.block, 123);
      assert.equal(read.blockHash, SNAPSHOT_HASH);
      assert.deepEqual(read.payload, PAYLOAD);
    }
    assert.equal(await source.read('Polkadot', form(EVE, 2426)), null, 'absent from the snapshot');
    assert.equal(await source.read('Kusama', form(DAVE, 2426)), 'not-served', 'no snapshot for that chain');
  });

  it('serves each chain from its own file and refuses two files for one chain', async () => {
    const polkadot = parseSnapshot(snapshotText({ [form(DAVE, 0)]: PAYLOAD }));
    const kusama = parseSnapshot(snapshotText({ [form(EVE, 2)]: PAYLOAD }, 'Kusama'));
    const both = new SnapshotSource([polkadot, kusama]);
    assert.ok(typeof (await both.read('Kusama', form(EVE, 2426))) === 'object');
    assert.equal(await both.read('Kusama', form(DAVE, 2426)), null);
    assert.throws(() => new SnapshotSource([polkadot, polkadot]), /two snapshots for Polkadot/);
  });

  it('checks a file again: what the runtime would refuse is dropped, not sent', () => {
    const snapshot = parseSnapshot(
      snapshotText({
        [form(DAVE, 0)]: { typed: [['DisplayName', '0xff'], ['Email', hex('d@e.f')]], custom: [], judgements: [[5, 'KnownGood']] },
      }),
    );
    assert.deepEqual(snapshot.byAccount.get(accountKey(form(DAVE, 2426)))?.typed, [['Email', hex('d@e.f')]]);
    assert.deepEqual(snapshot.dropped, [{ account: form(DAVE, 0), dropped: [{ field: 'DisplayName', reason: 'invalid-utf8' }] }]);
  });

  it('refuses a file that is not a snapshot', () => {
    assert.throws(() => parseSnapshot('[]'), /snapshot "source"/);
    assert.throws(() => parseSnapshot(snapshotText({}, 'Westend')), /snapshot "source"/);
    assert.throws(() => parseSnapshot(JSON.stringify({ source: 'Kusama', block: -1, blockHash: SNAPSHOT_HASH, identities: {} })), /"block"/);
    assert.throws(() => parseSnapshot(JSON.stringify({ source: 'Kusama', block: 1, blockHash: '0x12', identities: {} })), /"blockHash"/);
    assert.throws(() => parseSnapshot(JSON.stringify({ source: 'Kusama', block: 1, blockHash: SNAPSHOT_HASH })), /"identities"/);
    assert.throws(() => parseSnapshot(snapshotText({ 'not an address': PAYLOAD })));
    assert.throws(() => parseSnapshot(snapshotText({ [form(DAVE, 0)]: { typed: [] } })), /a payload is/);
    // The same key under two formats is one account twice.
    assert.throws(() => parseSnapshot(snapshotText({ [form(DAVE, 0)]: PAYLOAD, [form(DAVE, 2)]: PAYLOAD })), /twice/);
  });
});

// --- Reading the People Chains ---------------------------------------------------------------------

describe('live source', () => {
  /** A source whose connections and reads are scripted: `reads` answers one read each, in order. */
  function live(pinned: Record<string, string>, reads: Array<() => Promise<unknown>>) {
    const connected: Array<{ source: string; first: number | undefined }> = [];
    const readOptions: Array<Record<string, unknown>> = [];
    const disconnects: string[] = [];
    const logs: Array<{ event: string }> = [];
    const source = new LivePeopleSource(
      { maxValueLen: 256, maxCustomKeyLen: 32, maxCustomFields: 16, maxTypedFields: 16, maxImportedJudgements: 32 },
      (_level, event) => logs.push({ event }),
      pinned,
      {
        connect: async (chain, options) => {
          connected.push({ source: chain, first: options?.first });
          const endpoint = `wss://endpoint-${connected.length}`;
          return { endpoint, api: { disconnect: async () => disconnects.push(endpoint) } as unknown as ApiPromise };
        },
        read: async (_api, _who, options) => {
          readOptions.push({ ...options });
          const next = reads.shift();
          if (!next) throw new Error('unexpected read');
          return next() as never;
        },
      },
    );
    return { source, connected, readOptions, disconnects, logs };
  }

  const read = { block: 1, blockHash: SNAPSHOT_HASH, payload: PAYLOAD, dropped: [] };

  it('reads the pinned block of the chain, and the finalized head of an unpinned chain', async () => {
    const pinned = `0x${'ab'.repeat(32)}`;
    const h = live({ Polkadot: pinned }, [async () => read, async () => read]);
    await h.source.read('Polkadot', 'dave');
    await h.source.read('Kusama', 'dave');
    assert.equal(h.readOptions[0]?.at, pinned);
    assert.equal(h.readOptions[0]?.source, 'Polkadot');
    assert.ok(!('at' in (h.readOptions[1] ?? {})), 'Kusama is not pinned');
  });

  it('keeps its connection, and on a failed read drops it and retries on the next endpoint', async () => {
    const h = live({}, [
      async () => read,
      async () => {
        throw new Error('State already discarded');
      },
      async () => read,
    ]);
    await h.source.read('Polkadot', 'dave');
    assert.equal(h.connected.length, 1, 'the connection is kept');
    assert.deepEqual(await h.source.read('Polkadot', 'dave'), read, 'the retry answers');
    assert.deepEqual(h.connected.map((c) => c.first), [0, 0 + 1], 'the second connection starts from the next endpoint');
    assert.deepEqual(h.disconnects, ['wss://endpoint-1']);
    assert.ok(h.logs.some((l) => l.event === 'people-read-failed'));
  });

  it('gives up after one retry', async () => {
    const fail = async () => {
      throw new Error('down');
    };
    const h = live({}, [fail, fail]);
    await assert.rejects(h.source.read('Kusama', 'dave'), /down/);
    assert.equal(h.connected.length, 2);
  });
});

// --- The service, against a stub node ------------------------------------------------------------

interface Sent {
  call: 'fulfilMigration' | 'rejectMigration';
  args: unknown[];
}

type TxMode = 'normal' | 'hang' | 'isError' | 'noEvent' | 'pool-error';

interface Harness {
  migrator: Migrator;
  logs: Array<{ level: string; event: string; [key: string]: unknown }>;
  sent: Sent[];
  pending: Map<string, [SourceName, number]>;
  /** The most extrinsics that were in flight at once. */
  maxInFlight: () => number;
  /** Let the service settle: everything queued has been served. */
  settle: () => Promise<void>;
  /** Queue an account as an event or a sweep would. */
  enqueue: (who: string) => void;
  /** When the service will take the account again after a failure (ms since the epoch), if it waits. */
  retryAt: (who: string) => number | undefined;
  failureCount: (who: string) => number | undefined;
}

function harness(options: {
  pending: Array<[string, SourceName]>;
  source: (source: SourceName, who: string) => Promise<SourceResult>;
  /** Accounts that have an identity (a request is no obstacle to creating one). */
  identities?: string[];
  /** The dispatch error of every extrinsic, or of one call only. */
  dispatchError?: string | ((call: Sent['call']) => string | undefined);
  txMode?: TxMode;
  txDelayMs?: number;
  migratorOptions?: MigratorOptions;
  events?: (hash: string) => Array<{ section: string; method: string; data: string[] }>;
  finalizedHashes?: Record<number, string>;
}): Harness {
  const pending = new Map<string, [SourceName, number]>(options.pending.map(([who, source]) => [who, [source, 1]]));
  const identities = new Set(options.identities ?? []);
  const sent: Sent[] = [];
  const logs: Harness['logs'] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const errorOf = (call: Sent['call']): string | undefined =>
    typeof options.dispatchError === 'function' ? options.dispatchError(call) : options.dispatchError;
  const makeTx = (call: Sent['call']) => (...args: unknown[]) => ({
    signAndSend: (_pair: unknown, callback: (result: unknown) => void) => {
      const mode = options.txMode ?? 'normal';
      sent.push({ call, args });
      if (mode === 'pool-error') return Promise.reject(new Error('1010: Invalid Transaction: Custom error: 0'));
      if (mode === 'hang') return Promise.resolve(() => undefined);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        if (mode === 'isError') {
          callback({ isError: true, status: { type: 'Invalid' } });
          return;
        }
        const who = args[0] as string;
        const error = errorOf(call);
        if (error === undefined && mode === 'normal') pending.delete(who);
        callback({
          isError: false,
          status: { isInBlock: true, asInBlock: { toHex: () => '0xb10c' } },
          events:
            error !== undefined || mode === 'noEvent'
              ? []
              : [{ event: { section: 'identitee', method: call === 'fulfilMigration' ? 'MigrationFulfilled' : 'MigrationRejected' } }],
          dispatchError: error !== undefined ? { isModule: true, asModule: error } : undefined,
        });
      }, options.txDelayMs ?? 5);
      return Promise.resolve(() => undefined);
    },
  });
  const events = options.events ?? (() => []);
  const api = {
    runtimeVersion: { specName: { toString: () => 'identitee' } },
    registry: {
      findMetaError: (error: string) => {
        const [section, name] = error.split('.');
        return { section, name };
      },
    },
    query: {
      identitee: {
        agents: async () => ({ toJSON: () => [0, 8] }),
        migrationRequests: async (who: string) => ({ toJSON: () => pending.get(who) ?? null }),
        identities: async (who: string) => ({ toJSON: () => (identities.has(who) ? { typed: {} } : null) }),
      },
    },
    tx: { identitee: { fulfilMigration: makeTx('fulfilMigration'), rejectMigration: makeTx('rejectMigration') } },
    rpc: {
      chain: {
        getBlockHash: async (n: number) => ({ toHex: () => options.finalizedHashes?.[n] ?? `0x${n}` }),
      },
    },
    at: async (hash: { toHex(): string }) => ({
      query: {
        identitee: {
          migrationRequests: {
            // One page holding every pending request, as the node would list them.
            entriesPaged: async () => [...pending.keys()].map((who) => [{ args: [{ toString: () => who }], toHex: () => `0x${who}` }]),
          },
        },
        system: {
          events: async () =>
            events(hash.toHex()).map(({ section, method, data }) => ({ event: { section, method, data: data.map((d) => ({ toString: () => d })) } })),
        },
      },
    }),
  } as unknown as ApiPromise;
  const log: Logger = (level, event, fields = {}) => logs.push({ level, event, ...fields });
  const source: SourceReader = { read: options.source, close: async () => undefined };
  const migrator = new Migrator(api, { address: 'agent' } as unknown as KeyringPair, source, log, options.migratorOptions);
  const internals = migrator as unknown as {
    enqueue(who: string): void;
    worker: Promise<void>;
    retryAfter: Map<string, number>;
    failures: Map<string, number>;
  };
  return {
    migrator,
    logs,
    sent,
    pending,
    maxInFlight: () => maxInFlight,
    settle: async () => {
      let before: Promise<void>;
      do {
        before = internals.worker;
        await before;
      } while (before !== internals.worker);
    },
    enqueue: (who) => internals.enqueue(who),
    retryAt: (who) => internals.retryAfter.get(who),
    failureCount: (who) => internals.failures.get(who),
  };
}

const found = (payload: MigrationPayloadJson = PAYLOAD): SourceResult => ({ block: 777, blockHash: SNAPSHOT_HASH, payload, dropped: [] });

describe('migrator', () => {
  it('fulfils with what the source read, one transaction at a time', async () => {
    const h = harness({
      pending: [['dave', 'Polkadot'], ['eve', 'Kusama'], ['frank', 'Polkadot']],
      source: async () => found(),
    });
    for (const who of ['dave', 'eve', 'frank', 'dave']) h.enqueue(who); // dave twice: queued once
    await h.settle();
    assert.deepEqual(
      h.sent.map((s) => [s.call, s.args[0], s.args[1]]),
      [['fulfilMigration', 'dave', 'Polkadot'], ['fulfilMigration', 'eve', 'Kusama'], ['fulfilMigration', 'frank', 'Polkadot']],
    );
    assert.deepEqual(h.sent[0]?.args.slice(2), [777, SNAPSHOT_HASH, PAYLOAD]);
    assert.equal(h.maxInFlight(), 1, 'one extrinsic in flight at a time');
    assert.deepEqual(h.logs.filter((l) => l.event === 'fulfilled').map((l) => l.who), ['dave', 'eve', 'frank']);
  });

  it('is idempotent: an account without a pending request costs no transaction', async () => {
    const h = harness({ pending: [], source: async () => assert.fail('the source must not be read') });
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.logs.map((l) => [l.event, l.reason]), [['skipped', 'no pending request']]);
    // And served once: asking again after the fulfilment finds nothing to do.
    const again = harness({ pending: [['dave', 'Polkadot']], source: async () => found() });
    again.enqueue('dave');
    await again.settle();
    again.enqueue('dave');
    await again.settle();
    assert.equal(again.sent.length, 1);
  });

  it('rejects with Unspecified when the source has no identity', async () => {
    const h = harness({ pending: [['dave', 'Polkadot']], source: async () => null });
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.sent, [{ call: 'rejectMigration', args: ['dave', 'Unspecified'] }]);
    assert.equal(h.logs.filter((l) => l.event === 'rejected').length, 1);
  });

  it('leaves a request pending when no source serves its chain, and when the source fails', async () => {
    const h = harness({
      pending: [['dave', 'Kusama'], ['eve', 'Polkadot']],
      source: async (_source, who) => {
        if (who === 'dave') return 'not-served';
        throw new Error('people chain unreachable');
      },
    });
    h.enqueue('dave');
    h.enqueue('eve');
    await h.settle();
    assert.deepEqual(h.sent, [], 'neither a fulfilment nor a rejection');
    assert.ok(h.pending.has('dave') && h.pending.has('eve'));
    assert.deepEqual(h.logs.map((l) => [l.level, l.event]), [['warn', 'not-served'], ['error', 'request-failed']]);
    assert.match(String(h.logs[1]?.error), /people chain unreachable/);
  });

  it('retries a failing request with a delay that doubles up to a cap, and forgets the failures once served', async () => {
    let failing = true;
    const h = harness({
      pending: [['dave', 'Polkadot'], ['eve', 'Polkadot']],
      source: async (_source, who) => {
        if (who === 'dave' && failing) throw new Error('down');
        return found();
      },
      migratorOptions: { retryBaseMs: 1_000, retryMaxMs: 3_500 },
    });
    for (let i = 0; i < 4; i++) {
      h.enqueue('dave');
      await h.settle();
    }
    const failed = h.logs.filter((l) => l.event === 'request-failed');
    assert.deepEqual(failed.map((l) => [l.attempt, l.retryAfterMs]), [[1, 1000], [2, 2000], [3, 3500], [4, 3500]]);
    assert.ok((h.retryAt('dave') ?? 0) > Date.now() + 3_000, 'a sweep leaves it alone until then');
    // The others are served meanwhile: a request that does not work does not hold the queue.
    h.enqueue('eve');
    await h.settle();
    assert.deepEqual(h.sent.map((s) => s.args[0]), ['eve']);
    // Once it works, its failures are forgotten.
    failing = false;
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.sent.map((s) => s.args[0]), ['eve', 'dave']);
    assert.equal(h.failureCount('dave'), undefined);
    assert.equal(h.retryAt('dave'), undefined);
  });

  it('rejects, with Other, a request whose account created an identity meanwhile, without reading the source', async () => {
    const h = harness({
      pending: [['dave', 'Polkadot']],
      identities: ['dave'],
      source: async () => assert.fail('the source must not be read'),
    });
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.sent, [{ call: 'rejectMigration', args: ['dave', 'Other'] }]);
    const rejected = h.logs.find((l) => l.event === 'rejected');
    assert.equal(rejected?.reason, 'Other');
    assert.match(String(rejected?.cause), /created an identity/);
    assert.equal(h.logs.filter((l) => l.level === 'error').length, 0);
    assert.equal(h.retryAt('dave'), undefined, 'nothing to retry');
  });

  it('treats the refusals that no retry can change as final: a payload the runtime refuses is rejected, not retried', async () => {
    for (const [error, cause] of [
      ['identitee.IdentityExists', /created an identity/],
      ['identitee.InvalidUtf8', /invalid UTF-8/],
      ['identitee.InvalidPgp', /PGP/],
      ['identitee.DuplicateField', /duplicate field/],
      ['identitee.DuplicateJudgement', /duplicate judgement/],
      ['identitee.TooManyCustomFields', /too many custom fields/],
    ] as const) {
      const h = harness({
        pending: [['dave', 'Polkadot']],
        source: async () => found(),
        dispatchError: (call) => (call === 'fulfilMigration' ? error : undefined),
      });
      h.enqueue('dave');
      await h.settle();
      assert.deepEqual(h.sent.map((s) => [s.call, s.args[1]]), [['fulfilMigration', 'Polkadot'], ['rejectMigration', 'Other']], error);
      assert.ok(!h.pending.has('dave'), `${error}: the request is consumed`);
      assert.match(String(h.logs.find((l) => l.event === 'rejected')?.cause), cause);
      assert.ok(!h.logs.some((l) => l.event === 'request-failed'), `${error}: no retry`);
      assert.equal(h.retryAt('dave'), undefined);
      assert.equal(h.logs.find((l) => l.event === 'fulfil-refused')?.error, error);
    }
  });

  it('skips, without retry, a request that was withdrawn or changed between the read and the transaction', async () => {
    for (const [error, reason] of [
      ['identitee.NoMigrationRequest', /withdrawn or served/],
      ['identitee.MigrationSourceMismatch', /changed meanwhile/],
    ] as const) {
      const h = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), dispatchError: error });
      h.enqueue('dave');
      await h.settle();
      assert.deepEqual(h.logs.map((l) => [l.level, l.event]), [['info', 'skipped']], error);
      assert.match(String(h.logs[0]?.reason), reason);
      assert.equal(h.retryAt('dave'), undefined, `${error}: a sweep may take the new request at once`);
    }
    // Withdrawn between the read and the REJECTION: the same.
    const h = harness({ pending: [['dave', 'Polkadot']], source: async () => null, dispatchError: 'identitee.NoMigrationRequest' });
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.logs.map((l) => [l.level, l.event]), [['info', 'skipped']]);
  });

  it('retries with a delay what may pass: another runtime error, a failed rejection', async () => {
    const other = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), dispatchError: 'system.CallFiltered' });
    other.enqueue('dave');
    await other.settle();
    assert.deepEqual(other.sent.map((s) => s.call), ['fulfilMigration'], 'not rejected on an error that may pass');
    assert.equal(other.logs.at(-1)?.event, 'request-failed');
    assert.match(String(other.logs.at(-1)?.error), /fulfil_migration failed with system\.CallFiltered/);
    assert.ok(other.retryAt('dave') !== undefined);

    const rejection = harness({ pending: [['dave', 'Polkadot']], source: async () => null, dispatchError: 'system.CallFiltered' });
    rejection.enqueue('dave');
    await rejection.settle();
    assert.match(String(rejection.logs.at(-1)?.error), /reject_migration failed with system\.CallFiltered/);
    assert.ok(rejection.retryAt('dave') !== undefined);
  });

  describe('a transaction that does not come out as expected is a failure to retry', () => {
    it('never included: the inclusion timeout', async () => {
      const h = harness({
        pending: [['dave', 'Polkadot']],
        source: async () => found(),
        txMode: 'hang',
        migratorOptions: { inclusionTimeoutMs: 30 },
      });
      h.enqueue('dave');
      await h.settle();
      assert.equal(h.logs.at(-1)?.event, 'request-failed');
      assert.match(String(h.logs.at(-1)?.error), /not in a block after/);
      assert.ok(h.pending.has('dave'));
    });

    it('dropped, invalid or usurped: the extrinsic status is an error', async () => {
      const h = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), txMode: 'isError' });
      h.enqueue('dave');
      await h.settle();
      assert.match(String(h.logs.at(-1)?.error), /extrinsic Invalid/);
    });

    it('refused by the pool before inclusion: the rejection of signAndSend', async () => {
      const h = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), txMode: 'pool-error' });
      h.enqueue('dave');
      await h.settle();
      assert.match(String(h.logs.at(-1)?.error), /1010: Invalid Transaction/);
    });

    it('successful but without the event that proves it: neither fulfilled nor rejected is claimed', async () => {
      const fulfil = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), txMode: 'noEvent' });
      fulfil.enqueue('dave');
      await fulfil.settle();
      assert.match(String(fulfil.logs.at(-1)?.error), /succeeded without identitee\.MigrationFulfilled/);
      assert.ok(!fulfil.logs.some((l) => l.event === 'fulfilled'));
      const reject = harness({ pending: [['dave', 'Polkadot']], source: async () => null, txMode: 'noEvent' });
      reject.enqueue('dave');
      await reject.settle();
      assert.match(String(reject.logs.at(-1)?.error), /succeeded without identitee\.MigrationRejected/);
      assert.ok(!reject.logs.some((l) => l.event === 'rejected'));
    });
  });

  it('reads the events of every finalized block, also the ones a notification skipped', async () => {
    const requested = (who: string) => ({ section: 'identitee', method: 'MigrationRequested', data: [who, 'Polkadot'] });
    const h = harness({
      pending: [],
      source: async () => found(),
      events: (hash) =>
        hash === '0x11' ? [requested('dave')] : hash === '0x12' ? [{ section: 'balances', method: 'Transfer', data: ['x'] }] : hash === '0x13' ? [requested('eve')] : [],
    });
    const enqueued: string[] = [];
    (h.migrator as unknown as { enqueue(who: string): void }).enqueue = (who) => enqueued.push(who);
    const head = (n: number) => ({ number: { toNumber: () => n }, hash: { toHex: () => `0x${n}` } });
    const onFinalized = (h.migrator as unknown as { onFinalized(header: unknown): Promise<void> }).onFinalized.bind(h.migrator);
    // The first head only sets the starting point (the pending requests come from the sweep).
    (h.migrator as unknown as { sweep(hash: unknown): Promise<void> }).sweep = async () => undefined;
    await onFinalized(head(10));
    assert.deepEqual(enqueued, []);
    // Blocks 11 and 12 are finalized together with 13: one notification, three blocks.
    await onFinalized(head(13));
    assert.deepEqual(enqueued, ['dave', 'eve']);
    await onFinalized(head(14));
    assert.deepEqual(enqueued, ['dave', 'eve']);
  });

  it('a sweep takes every pending request, but leaves one that failed alone until its delay is over', async () => {
    let now = 1_000_000;
    let failing = true;
    const h = harness({
      pending: [['dave', 'Polkadot'], ['eve', 'Polkadot']],
      source: async (_source, who) => {
        if (who === 'dave' && failing) throw new Error('down');
        return found();
      },
      migratorOptions: { retryBaseMs: 30_000, now: () => now },
    });
    const sweep = (h.migrator as unknown as { sweep(hash: unknown): Promise<void> }).sweep.bind(h.migrator);
    h.enqueue('dave');
    await h.settle();
    assert.equal(h.retryAt('dave'), now + 30_000, 'the delay is counted on the service clock');
    failing = false;
    await sweep('0xf1');
    await h.settle();
    assert.deepEqual(h.sent.map((s) => s.args[0]), ['eve'], 'dave is left alone before its delay');
    now += 29_999;
    await sweep('0xf2');
    await h.settle();
    assert.deepEqual(h.sent.map((s) => s.args[0]), ['eve'], 'still one millisecond to go');
    now += 1;
    await sweep('0xf3');
    await h.settle();
    assert.deepEqual(h.sent.map((s) => s.args[0]), ['eve', 'dave'], 'taken again once the delay is over');
  });

  it('does not queue again an account that is being served (a sweep during its read)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    const h = harness({
      pending: [['dave', 'Polkadot']],
      source: async () => {
        reads++;
        await gate;
        return found();
      },
    });
    h.enqueue('dave');
    await new Promise((r) => setTimeout(r, 5)); // dave is now being read
    assert.equal(reads, 1);
    h.enqueue('dave'); // what a sweep or an event would do meanwhile
    release();
    await h.settle();
    assert.equal(reads, 1, 'read once');
    assert.deepEqual(h.sent.map((s) => s.call), ['fulfilMigration']);
    assert.ok(!h.logs.some((l) => l.event === 'skipped'), 'no second pass that finds nothing');
  });

  it('forgets earlier failures when the transaction finds the request withdrawn or changed', async () => {
    const cases: Array<[string, SourceResult, 'fulfilMigration' | 'rejectMigration']> = [
      ['identitee.NoMigrationRequest', found(), 'fulfilMigration'],
      ['identitee.MigrationSourceMismatch', found(), 'fulfilMigration'],
      ['identitee.NoMigrationRequest', null, 'rejectMigration'],
    ];
    for (const [error, answer, call] of cases) {
      let failing = true;
      const h = harness({
        pending: [['dave', 'Polkadot']],
        source: async () => {
          if (failing) throw new Error('down');
          return answer;
        },
        dispatchError: (sent) => (sent === call ? error : undefined),
      });
      h.enqueue('dave');
      await h.settle();
      assert.equal(h.failureCount('dave'), 1, `${call} ${error}: one failure first`);
      failing = false;
      h.enqueue('dave');
      await h.settle();
      assert.equal(h.logs.at(-1)?.event, 'skipped', `${call} ${error}`);
      assert.deepEqual(h.sent.map((s) => s.call), [call]);
      assert.equal(h.failureCount('dave'), undefined, `${call} ${error}: failures forgotten`);
      assert.equal(h.retryAt('dave'), undefined, `${call} ${error}: no delay left`);
    }
  });

  it('forgets the failures of an account whose request disappeared', async () => {
    const h = harness({
      pending: [['dave', 'Polkadot']],
      source: async () => {
        throw new Error('down');
      },
    });
    h.enqueue('dave');
    await h.settle();
    assert.equal(h.failureCount('dave'), 1);
    h.pending.delete('dave'); // withdrawn, or served by another migrator
    h.enqueue('dave');
    await h.settle();
    assert.equal(h.logs.at(-1)?.event, 'skipped');
    assert.equal(h.failureCount('dave'), undefined);
    assert.equal(h.retryAt('dave'), undefined);
  });

  it('takes a new request of an account that had failed at once, counting its failures from zero', async () => {
    const requested = { section: 'identitee', method: 'MigrationRequested', data: ['dave', 'Polkadot'] };
    const h = harness({
      pending: [['dave', 'Polkadot']],
      source: async () => {
        throw new Error('down');
      },
      migratorOptions: { retryBaseMs: 60_000 },
      events: (hash) => (hash === '0x11' ? [requested] : []),
    });
    for (let i = 0; i < 2; i++) {
      h.enqueue('dave');
      await h.settle();
    }
    assert.equal(h.failureCount('dave'), 2);
    assert.ok((h.retryAt('dave') ?? 0) > Date.now() + 100_000);
    // The person asks again: a new request, served at once, whatever the old delay and count.
    const internals = h.migrator as unknown as { onFinalized(header: unknown): Promise<void>; sweep(hash: unknown): Promise<void> };
    internals.sweep = async () => undefined;
    const head = (n: number) => ({ number: { toNumber: () => n }, hash: { toHex: () => `0x${n}` } });
    await internals.onFinalized(head(10));
    await internals.onFinalized(head(11));
    await h.settle();
    const failed = h.logs.filter((l) => l.event === 'request-failed');
    assert.equal(failed.length, 3, 'taken again at once');
    assert.deepEqual([failed[2]?.attempt, failed[2]?.retryAfterMs], [1, 60_000], 'its failures count from zero');
  });

  it('stops cleanly: a request queued after stop() is not served', async () => {
    const h = harness({ pending: [['dave', 'Polkadot']], source: async () => found() });
    await h.migrator.stop();
    h.enqueue('dave');
    await h.settle();
    assert.deepEqual(h.sent, []);
  });

  it('abandons a read of the source at once when it is stopped: nothing sent, the request stays pending', async () => {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    const h = harness({
      pending: [['dave', 'Polkadot']],
      source: () => {
        reading();
        return new Promise<SourceResult>(() => undefined); // never answers
      },
    });
    h.enqueue('dave');
    await started;
    const t0 = Date.now();
    await h.migrator.stop();
    await h.settle();
    assert.ok(Date.now() - t0 < 1_000, 'stop() does not wait for the read');
    assert.deepEqual(h.sent, []);
    assert.ok(h.pending.has('dave'));
    assert.deepEqual(h.logs.map((l) => l.event), ['aborted']);
    assert.equal(h.retryAt('dave'), undefined, 'a stop is not a failure to back off from');
  });

  it('waits for a transaction already sent, but not for ever', async () => {
    const waited = harness({ pending: [['dave', 'Polkadot']], source: async () => found(), txDelayMs: 100 });
    waited.enqueue('dave');
    await new Promise((resolve) => setTimeout(resolve, 30)); // the transaction is on its way
    assert.equal(waited.sent.length, 1);
    await waited.migrator.stop();
    assert.ok(waited.logs.some((l) => l.event === 'fulfilled'), 'it was waited for');

    const impatient = harness({
      pending: [['dave', 'Polkadot']],
      source: async () => found(),
      txMode: 'hang',
      migratorOptions: { stopWaitMs: 50, inclusionTimeoutMs: 300 }, // its own timer must not outlive the test
    });
    impatient.enqueue('dave');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const t0 = Date.now();
    await impatient.migrator.stop();
    assert.ok(Date.now() - t0 < 1_000, 'stop() returns after the wait');
    assert.ok(impatient.logs.some((l) => l.event === 'stop-timeout'));
  });
});

// --- Limits read from the node ----------------------------------------------------------------------

describe('limits of the node', () => {
  const consts = (values: Record<string, number | undefined>) =>
    ({ consts: { identitee: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { toString: () => String(v) }])) } }) as unknown as ApiPromise;
  const all = { maxValueLen: 200, maxCustomKeyLen: 30, maxCustomFields: 10, maxImportedJudgements: 20 };

  it('reads them from the metadata constants, and the typed-field bound (not a constant of the pallet) as designed', () => {
    assert.deepEqual(limitsOf(consts(all)), { ...all, maxTypedFields: 16 });
  });

  it('fails loudly when a constant is missing or is not a number, instead of guessing', () => {
    for (const name of Object.keys(all)) {
      assert.throws(
        () => limitsOf(consts({ ...all, [name]: undefined })),
        new RegExp(`does not expose the constant identitee\\.${name}`),
        name,
      );
    }
    assert.throws(() => limitsOf({ consts: {} } as unknown as ApiPromise), /identitee\.maxValueLen/);
    assert.throws(() => limitsOf(consts({ ...all, maxValueLen: 0 })), /identitee\.maxValueLen/);
  });
});

// --- The whole program: start, signals, startup checks ------------------------------------------------

describe('main', () => {
  const SURI = '//Bob';
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ IDENTITEE_MIGRATOR_SURI: SURI, ...extra });
  const node = (): ApiPromise => {
    const pending = ['Polkadot', 1];
    const key = { args: [{ toString: () => 'dave' }], toHex: () => '0x01' };
    const head = { number: { toNumber: () => 5 }, hash: { toHex: () => '0x05' } };
    return {
      runtimeVersion: { specName: { toString: () => 'identitee' } },
      registry: { signedExtensions: [] },
      consts: {
        identitee: Object.fromEntries(
          ['maxValueLen', 'maxCustomKeyLen', 'maxCustomFields', 'maxImportedJudgements'].map((k) => [k, { toString: () => '16' }]),
        ),
      },
      query: {
        identitee: {
          agents: async () => ({ toJSON: () => [0, 8] }),
          migrationRequests: async () => ({ toJSON: () => pending }),
          identities: async () => ({ toJSON: () => null }),
        },
      },
      rpc: {
        chain: {
          subscribeFinalizedHeads: async (callback: (h: unknown) => void) => {
            setTimeout(() => callback(head), 0);
            return () => undefined;
          },
          getFinalizedHead: async () => head.hash,
        },
      },
      at: async () => ({
        query: {
          identitee: { migrationRequests: { entriesPaged: async () => [[key, pending]] } },
          system: { events: async () => [] },
        },
      }),
      disconnect: async () => undefined,
    } as unknown as ApiPromise;
  };
  const capture = () => {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line), events: () => lines.map((l) => JSON.parse(l).event as string) };
  };
  const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: not done after ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const noExit: Pick<MainDeps, 'exit'> = { exit: () => assert.fail('a second signal was not expected') };

  it('SIGTERM during a read of the source: exits 0 within a moment, without sending anything', async () => {
    const out = capture();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    const done = main([], env(), {
      ...noExit,
      write: out.write,
      connect: async () => node(),
      makeSource: () => ({
        read: () => {
          reading();
          return new Promise<SourceResult>(() => undefined);
        },
        close: async () => undefined,
      }),
    });
    await within(started, 5_000, 'the read to begin');
    const t0 = Date.now();
    process.emit('SIGTERM');
    assert.equal(await within(done, 3_000, 'main'), 0);
    assert.ok(Date.now() - t0 < 2_000);
    const events = out.events();
    assert.deepEqual(events.filter((e) => ['stopping', 'aborted', 'stopped'].includes(e)), ['stopping', 'aborted', 'stopped']);
    assert.ok(!events.includes('fulfilled') && !events.includes('request-failed'));
  });

  it('SIGINT during the connection: exits 0 without waiting for it', async () => {
    const out = capture();
    let disconnected = false;
    const done = main([], env(), {
      ...noExit,
      write: out.write,
      connect: () =>
        new Promise<ApiPromise>((resolve) => {
          setTimeout(() => resolve({ disconnect: async () => (disconnected = true) } as unknown as ApiPromise), 400);
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit('SIGINT');
    assert.equal(await within(done, 300, 'main'), 0);
    assert.deepEqual(out.events(), ['stopping', 'stopped']);
    // The connection that was still being made is closed when it arrives.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(disconnected);
  });

  it('removes its signal handlers when it returns', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const done = main([], env(), { ...noExit, write: () => undefined, connect: async () => node(), makeSource: () => ({ read: async () => null, close: async () => undefined }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit('SIGTERM');
    assert.equal(await within(done, 3_000, 'main'), 0);
    assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
  });

  it('a malformed PEOPLE_AT_BLOCK_* stops it at once with a message that names the variable, before connecting', async () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await main([], env({ PEOPLE_AT_BLOCK_KUSAMA: 'latest' }), {
        connect: async () => assert.fail('it must not connect'),
      });
      assert.equal(code, 2);
    } finally {
      process.stderr.write = realWrite;
    }
    assert.match(written.join(''), /PEOPLE_AT_BLOCK_KUSAMA must be a block hash/);
  });

  it('warns that PEOPLE_AT_BLOCK_* is ignored with --snapshot files', async () => {
    const out = capture();
    const pinned = `0x${'ab'.repeat(32)}`;
    const done = main(['--snapshot', 'x.json'], env({ PEOPLE_AT_BLOCK_POLKADOT: pinned }), {
      ...noExit,
      write: out.write,
      connect: async () => node(),
      makeSource: () => ({ read: async () => null, close: async () => undefined }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit('SIGTERM');
    assert.equal(await within(done, 3_000, 'main'), 0);
    const warning = out.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'people-pinned-ignored');
    assert.equal(warning?.level, 'warn');
    assert.deepEqual(warning?.env, ['PEOPLE_AT_BLOCK_POLKADOT']);
  });

  it('exits 1 on a node that lacks a limit constant, saying which, and never prints the key', async () => {
    const out = capture();
    const bare = { ...node(), consts: { identitee: {} } } as unknown as ApiPromise;
    const code = await main([], env(), { ...noExit, write: out.write, connect: async () => bare });
    assert.equal(code, 1);
    const fatal = out.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'fatal');
    assert.match(fatal.error, /identitee\.maxValueLen/);
    assert.ok(out.lines.every((l) => !l.includes(SURI)));
  });
});
