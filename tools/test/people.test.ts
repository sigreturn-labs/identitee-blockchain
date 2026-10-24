// Tests of the People Chain reading (src/people.ts). No network: the identities are synthetic
// `identityOf` responses built by `src/make-fixtures.ts` (test/fixtures/), the node is a stub.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { TypeRegistry } from '@polkadot/types';

import {
  DOTID_REGISTRARS,
  PEOPLE_ENDPOINTS,
  mapIdentity,
  pinnedBlock,
  readPeopleIdentity,
  sanitisePayload,
  type MigrationPayloadJson,
} from '../src/people.ts';

// --- Fixtures --------------------------------------------------------------------------------

interface FixtureAccount {
  address: string;
  why: string;
  storageKey: string;
  raw: string | null;
  identityOf: any;
}

interface Fixture {
  source: 'Polkadot' | 'Kusama';
  block: number;
  blockHash: string;
  specName: string;
  accounts: Record<string, FixtureAccount>;
}

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;

const polkadot = load('people-polkadot.json');
const kusama = load('people-kusama.json');

const account = (fixture: Fixture, name: string): FixtureAccount => {
  const found = fixture.accounts[name];
  assert.ok(found, `fixture ${fixture.source}/${name} exists`);
  return found;
};

/** What a stub node knows about one block besides the finalized head of the fixture. */
interface StubBlock {
  number: number;
  /** The identities in its state, by address (none: every account has no identity there). */
  identities?: Record<string, unknown>;
  /** Whether it is on the canonical chain (default: yes). */
  canonical?: boolean;
  /** The state is gone (a pruned node). */
  pruned?: boolean;
}

/**
 * A stand-in for a People Chain node that answers like the real one: its finalized head is the
 * fixture's block, whose state holds the fixture's identities; `blocks` adds other blocks by hash.
 */
function stubApi(fixture: Fixture, calls: string[] = [], blocks: Record<string, StubBlock> = {}): ApiPromise {
  const finalizedState = Object.fromEntries(Object.values(fixture.accounts).map((a) => [a.address, a.identityOf]));
  const all: Record<string, StubBlock> = { [fixture.blockHash]: { number: fixture.block, identities: finalizedState }, ...blocks };
  const hashOf = (n: number): string => Object.entries(all).find(([, b]) => b.number === n && b.canonical !== false)?.[0] ?? `0x${'00'.repeat(32)}`;
  const known = (hash: string): StubBlock => {
    const found = all[hash];
    if (!found) throw new Error(`4003: Client error: UnknownBlock: Header was not found in the database: ${hash}`);
    return found;
  };
  return {
    rpc: {
      chain: {
        getFinalizedHead: async () => {
          calls.push('getFinalizedHead');
          return { toHex: () => fixture.blockHash };
        },
        getHeader: async (hash: string) => {
          calls.push(`getHeader ${hash}`);
          return { number: { toNumber: () => known(hash).number } };
        },
        getBlockHash: async (number: number) => {
          calls.push(`getBlockHash ${number}`);
          return { toHex: () => hashOf(number) };
        },
      },
    },
    at: async (hash: string) => {
      calls.push(`at ${hash}`);
      const block = known(hash);
      if (block.pruned) throw new Error(`4003: Client error: State already discarded for ${hash}`);
      return {
        query: {
          identity: {
            identityOf: async (who: string) => {
              calls.push(`identityOf ${who}`);
              return { toJSON: () => block.identities?.[who] ?? null };
            },
          },
        },
      };
    },
  } as unknown as ApiPromise;
}

const hexOf = (text: string): string => `0x${Buffer.from(text, 'utf8').toString('hex')}`;

/** An identity as `identityOf.toJSON()` renders it, with the given `info` fields over empty ones. */
function identity(info: Record<string, unknown>, judgements: unknown[] = []): unknown {
  const none = { none: null };
  return {
    judgements,
    deposit: 1,
    info: {
      display: none,
      legal: none,
      web: none,
      matrix: none,
      email: none,
      pgpFingerprint: null,
      image: none,
      twitter: none,
      github: none,
      discord: none,
      ...info,
    },
  };
}

const raw = (hex: string) => ({ raw: hex });

const typedOf = (payload: MigrationPayloadJson, kind: string): string | undefined =>
  payload.typed.find(([k]) => k === kind)?.[1];

// --- The mapping of the brief ------------------------------------------------------------------

describe('readPeopleIdentity', () => {
  for (const fixture of [polkadot, kusama]) {
    it(`maps_all_supported_fields (${fixture.source})`, async () => {
      const full = account(fixture, 'all_fields_with_pgp');
      const info = full.identityOf.info;
      const read = await readPeopleIdentity(stubApi(fixture), full.address);
      assert.ok(read);
      // People Chain field → identitee field, written out here independently of the code.
      const expected = [
        ['DisplayName', info.display.raw],
        ['LegalName', info.legal.raw],
        ['Web', info.web.raw],
        ['Email', info.email.raw],
        ['Matrix', info.matrix.raw],
        ['X', info.twitter.raw], // twitter is X
        ['Discord', info.discord.raw],
        ['GitHub', info.github.raw],
        ['Pgp', info.pgpFingerprint],
      ];
      assert.deepEqual(read.payload.typed, expected);
      assert.equal(info.pgpFingerprint.length, 2 + 2 * 20, 'a v4 fingerprint, raw bytes');
      assert.ok(info.image.raw, 'the fixture has an image, which is ignored');
      assert.deepEqual(read.payload.custom, []);
      assert.deepEqual(read.dropped, []);
      // Every field present is imported: no kind appears twice, no value is the image's.
      assert.equal(new Set(read.payload.typed.map(([k]) => k)).size, read.payload.typed.length);
      assert.ok(!read.payload.typed.some(([, v]) => v === info.image.raw && v !== info.display.raw));
    });
  }

  it('maps_all_supported_fields: text is the UTF-8 of the bytes, untouched', async () => {
    const full = account(polkadot, 'all_fields_with_pgp');
    const read = await readPeopleIdentity(stubApi(polkadot), full.address);
    assert.ok(read);
    const email = typedOf(read.payload, 'Email');
    assert.ok(email);
    assert.match(Buffer.from(email.slice(2), 'hex').toString('utf8'), /^[^@\s]+@[^@\s]+$/);
  });

  it('reads at the latest finalized block and reports it', async () => {
    const calls: string[] = [];
    const full = account(polkadot, 'all_fields_with_pgp');
    const read = await readPeopleIdentity(stubApi(polkadot, calls), full.address);
    assert.ok(read);
    assert.equal(read.block, polkadot.block);
    assert.equal(read.blockHash, polkadot.blockHash);
    assert.deepEqual(calls, [
      'getFinalizedHead',
      `getHeader ${polkadot.blockHash}`,
      `at ${polkadot.blockHash}`,
      `identityOf ${full.address}`,
    ]);
  });

  describe('at a pinned block (the last one before the People Chain drops pallet-identity)', () => {
    const entry = account(polkadot, 'dotid_known_good_and_other_registrar');
    const PINNED = `0x${'1a'.repeat(32)}`;
    const FORK = `0x${'2b'.repeat(32)}`;
    const FUTURE = `0x${'3c'.repeat(32)}`;
    const blocks: Record<string, StubBlock> = {
      // Older than the finalized head, with the identity in its state; the head's state has none (pallet gone).
      [PINNED]: { number: polkadot.block - 1000, identities: { [entry.address]: entry.identityOf } },
      [FORK]: { number: polkadot.block - 5, identities: { [entry.address]: entry.identityOf }, canonical: false },
      [FUTURE]: { number: polkadot.block + 10, identities: { [entry.address]: entry.identityOf } },
    };
    const gone: Fixture = { ...polkadot, accounts: { ...polkadot.accounts, [entry.address]: { ...entry, identityOf: null } } };

    it('reads the pinned state instead of the finalized one, and reports the pinned block', async () => {
      const calls: string[] = [];
      const api = stubApi(gone, calls, blocks);
      assert.equal(await readPeopleIdentity(api, entry.address), null, 'the default read is at the finalized head');
      calls.length = 0;
      const read = await readPeopleIdentity(api, entry.address, { at: PINNED });
      assert.ok(read, 'the identity of the pinned block');
      assert.equal(read.block, polkadot.block - 1000);
      assert.equal(read.blockHash, PINNED);
      assert.deepEqual(read.payload.judgements, [
        [0, 'Reasonable'],
        [5, 'KnownGood'],
      ]);
      assert.ok(calls.includes(`at ${PINNED}`));
      assert.ok(!calls.includes(`at ${polkadot.blockHash}`), 'the finalized state is never read');
    });

    it('accepts a hash in capitals and returns it in the node\'s form', async () => {
      const read = await readPeopleIdentity(stubApi(gone, [], blocks), entry.address, { at: PINNED.toUpperCase().replace('0X', '0x') });
      assert.equal(read?.blockHash, PINNED);
    });

    it('refuses a block that is not on the canonical chain, or not finalized yet', async () => {
      const api = stubApi(gone, [], blocks);
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: FORK }), /not on the canonical chain/);
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: FUTURE }), /not finalized yet/);
    });

    it('refuses what is not a block hash and a block the node does not know', async () => {
      const api = stubApi(gone, [], blocks);
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: '0x1234' }), /must be a block hash/);
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: 'latest' }), /must be a block hash/);
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: `0x${'ee'.repeat(32)}` }), /UnknownBlock/);
    });

    it('lets a pruned endpoint fail, so that the caller can try the next one', async () => {
      const api = stubApi(gone, [], { ...blocks, [PINNED]: { ...blocks[PINNED]!, pruned: true } });
      await assert.rejects(readPeopleIdentity(api, entry.address, { at: PINNED }), /State already discarded/);
    });

    it('reads the block hash from the environment variable of the source', () => {
      assert.equal(pinnedBlock('Polkadot', { PEOPLE_AT_BLOCK_POLKADOT: PINNED }), PINNED);
      assert.equal(pinnedBlock('Kusama', { PEOPLE_AT_BLOCK_POLKADOT: PINNED }), undefined, 'the other chain is not pinned');
      assert.equal(pinnedBlock('Kusama', { PEOPLE_AT_BLOCK_KUSAMA: '' }), undefined, 'empty is unset');
      assert.throws(() => pinnedBlock('Kusama', { PEOPLE_AT_BLOCK_KUSAMA: '12345' }), /PEOPLE_AT_BLOCK_KUSAMA must be a block hash/);
    });
  });

  it('skips_hashed_data', async () => {
    const cases: Array<[Fixture, string, string, string]> = [
      [polkadot, 'hashed_email', 'email', 'Email'],
      [kusama, 'hashed_legal', 'legal', 'LegalName'],
      [kusama, 'hashed_web_sha3', 'web', 'Web'],
    ];
    for (const [fixture, name, field, kind] of cases) {
      const entry = account(fixture, name);
      const hashed = entry.identityOf.info[field];
      assert.ok(!('raw' in hashed) && !('none' in hashed), `${name}: the fixture field is a hashed variant`);
      const read = await readPeopleIdentity(stubApi(fixture), entry.address);
      assert.ok(read);
      assert.equal(typedOf(read.payload, kind), undefined, `${name}: ${kind} is not imported`);
      assert.deepEqual(read.dropped, [{ field: kind, reason: 'hashed' }]);
      assert.ok(typedOf(read.payload, 'DisplayName'), `${name}: the other fields are kept`);
      // The hash itself must not leak into any value.
      const digest = Object.values(hashed)[0] as string;
      assert.ok(!read.payload.typed.some(([, v]) => v === digest));
    }
  });

  it('keeps_both_kusama_registrars', async () => {
    const both = await readPeopleIdentity(stubApi(kusama), account(kusama, 'both_dotid_registrars').address);
    assert.ok(both);
    // The former (6) and the current (7) dotID registrar: both kept, the runtime picks.
    assert.deepEqual(both.payload.judgements, [
      [6, 'KnownGood'],
      [7, 'OutOfDate'],
    ]);
    // Every registrar, not only dotID's, with FeePaid's amount dropped and Unknown kept.
    const mixed = await readPeopleIdentity(stubApi(kusama), account(kusama, 'fee_paid_unknown_and_reasonable').address);
    assert.ok(mixed);
    assert.deepEqual(mixed.payload.judgements, [
      [5, 'FeePaid'],
      [6, 'Unknown'],
      [7, 'Reasonable'],
    ]);
  });

  it('maps every judgement level of the People Chain by name', async () => {
    const out = await readPeopleIdentity(
      stubApi(polkadot),
      account(polkadot, 'dotid_out_of_date_other_reasonable').address,
    );
    assert.ok(out);
    assert.deepEqual(out.payload.judgements, [
      [3, 'FeePaid'],
      [4, 'Reasonable'],
      [5, 'OutOfDate'],
    ]);
    const fee = await readPeopleIdentity(stubApi(polkadot), account(polkadot, 'dotid_fee_paid').address);
    assert.deepEqual(fee?.payload.judgements, [[5, 'FeePaid']]);
    const levels = mapIdentity(
      identity({}, [
        [0, { unknown: null }],
        [1, { lowQuality: null }],
        [2, { erroneous: null }],
        [3, { knownGood: null }],
      ]),
    );
    assert.deepEqual(levels?.payload.judgements, [
      [0, 'Unknown'],
      [1, 'LowQuality'],
      [2, 'Erroneous'],
      [3, 'KnownGood'],
    ]);
  });

  it('returns_null_without_identity', async () => {
    for (const fixture of [polkadot, kusama]) {
      const none = account(fixture, 'no_identity');
      assert.equal(none.raw, null);
      assert.equal(await readPeopleIdentity(stubApi(fixture), none.address), null);
    }
  });

  it('reads the (Registration, Option<username>) shape of newer runtimes like the plain one', async () => {
    const entry = account(polkadot, 'dotid_known_good_and_other_registrar').identityOf;
    const plain = mapIdentity(entry);
    assert.ok(plain);
    assert.deepEqual(mapIdentity([entry, null]), plain);
    assert.deepEqual(mapIdentity([entry, '0x616c696365']), plain);
    assert.equal(mapIdentity(null), null);
  });

  it('refuses a value that is not an identity instead of reading it as "none"', () => {
    assert.throws(() => mapIdentity({ unexpected: true }), /unexpected identityOf value/);
  });
});

// --- Sanitising: the runtime refuses the whole call on one bad entry ---------------------------

describe('sanitising', () => {
  it('drops_invalid_utf8 and keeps the rest', () => {
    const read = mapIdentity(identity({ display: raw('0x4120ff42'), email: raw(hexOf('a@b.c')) }));
    assert.ok(read);
    assert.deepEqual(read.payload.typed, [['Email', hexOf('a@b.c')]]);
    assert.deepEqual(read.dropped, [{ field: 'DisplayName', reason: 'invalid-utf8' }]);
    // A lone surrogate encoding and an overlong encoding are invalid UTF-8 too.
    assert.equal(mapIdentity(identity({ web: raw('0xeda080') }))?.payload.typed.length, 0);
    assert.equal(mapIdentity(identity({ web: raw('0xc0af') }))?.payload.typed.length, 0);
    // Multi-byte text that is valid stays.
    assert.deepEqual(mapIdentity(identity({ display: raw(hexOf('Carol 🌞 é')) }))?.payload.typed, [
      ['DisplayName', hexOf('Carol 🌞 é')],
    ]);
  });

  it('drops_oversize: 256 bytes stay, 257 go', () => {
    const at = `0x${'61'.repeat(256)}`;
    const over = `0x${'61'.repeat(257)}`;
    const read = mapIdentity(identity({ display: raw(at), web: raw(over) }));
    assert.ok(read);
    assert.deepEqual(read.payload.typed, [['DisplayName', at]]);
    assert.equal(read.dropped.length, 1);
    assert.equal(read.dropped[0]?.field, 'Web');
    assert.equal(read.dropped[0]?.reason, 'too-long');
    // The limit is the chain's, when the caller knows it.
    const small = mapIdentity(identity({ display: raw(hexOf('abcd')) }), {
      limits: { maxValueLen: 3, maxCustomKeyLen: 32, maxCustomFields: 16, maxTypedFields: 16, maxImportedJudgements: 32 },
    });
    assert.equal(small?.payload.typed.length, 0);
  });

  it('keeps a PGP fingerprint of 20 or 32 bytes and drops any other length', () => {
    const bytes = (n: number) => `0x${'ab'.repeat(n)}`;
    for (const [n, kept] of [
      [20, true],
      [32, true],
      [19, false],
      [21, false],
      [33, false],
      [0, false],
    ] as const) {
      const read = mapIdentity(identity({ pgpFingerprint: bytes(n) }));
      assert.ok(read);
      assert.equal(read.payload.typed.length, kept ? 1 : 0, `${n} bytes`);
      if (!kept && n > 0) assert.equal(read.dropped[0]?.reason, 'bad-pgp-length');
    }
    // A fingerprint is raw bytes, never text: not UTF-8, and still kept.
    assert.deepEqual(mapIdentity(identity({ pgpFingerprint: bytes(20) }))?.payload.typed, [['Pgp', bytes(20)]]);
  });

  it('treats an empty raw value as a field never filled in, not as a drop', () => {
    const read = mapIdentity(identity({ display: raw('0x'), email: raw(hexOf('x@y.z')) }));
    assert.ok(read);
    assert.deepEqual(read.payload.typed, [['Email', hexOf('x@y.z')]]);
    assert.deepEqual(read.dropped, []);
    // An empty value in a payload that comes from a file is refused, and said so.
    const file = sanitisePayload({ typed: [['Web', '0x']], custom: [], judgements: [] });
    assert.deepEqual(file.dropped, [{ field: 'Web', reason: 'empty' }]);
  });

  it('turns `additional` into custom fields, Raw only, within the chain limits', () => {
    const read = mapIdentity(
      identity({
        additional: [
          [raw(hexOf('telegram')), raw(hexOf('@someone'))],
          [raw(hexOf('telegram')), raw(hexOf('@again'))], // same key twice: the first wins
          [{ sha256: `0x${'11'.repeat(32)}` }, raw(hexOf('v'))], // hashed key
          [raw(hexOf('k')), { blakeTwo256: `0x${'22'.repeat(32)}` }], // hashed value
          [raw(hexOf('bad')), raw('0xff')], // not UTF-8
          [raw(`0x${'6b'.repeat(33)}`), raw(hexOf('v'))], // key longer than 32 bytes
          [raw(hexOf('none')), { none: null }], // nothing to import
        ],
      }),
    );
    assert.ok(read);
    assert.deepEqual(read.payload.custom, [[hexOf('telegram'), hexOf('@someone')]]);
    assert.deepEqual(
      read.dropped.map((d) => [d.field, d.reason]),
      [
        ['additional[2]', 'hashed'],
        ['additional[3]', 'hashed'],
        ['additional[6]', 'empty'],
        ['additional[1]', 'duplicate'],
        ['additional[4]', 'invalid-utf8'],
        ['additional[5]', 'too-long'],
      ],
    );
    // More custom fields than the chain holds: the first 16 stay.
    const many = mapIdentity(
      identity({ additional: Array.from({ length: 20 }, (_, i) => [raw(hexOf(`k${i}`)), raw(hexOf('v'))]) }),
    );
    assert.equal(many?.payload.custom.length, 16);
    assert.deepEqual(many?.dropped.map((d) => d.reason), ['too-many', 'too-many', 'too-many', 'too-many']);
  });

  it('keeps the dotID judgements first when there are more than the chain takes', () => {
    // 38 other registrars come first in the list, dotID's two Kusama registrars last: a plain
    // truncation to the first 32 would lose them.
    const others = Array.from({ length: 38 }, (_, i) => [20 + i, { reasonable: null }]);
    const levels = [...others, [6, { knownGood: null }], [7, { outOfDate: null }]];
    const read = mapIdentity(identity({}, levels), { source: 'Kusama' });
    assert.ok(read);
    assert.equal(read.payload.judgements.length, 32);
    const kept = new Map(read.payload.judgements);
    assert.equal(kept.get(6), 'KnownGood');
    assert.equal(kept.get(7), 'OutOfDate');
    assert.equal(read.dropped.length, 8);
    assert.ok(read.dropped.every((d) => d.reason === 'too-many'));
    // Without a source there is no preference: the first ones stay.
    assert.ok(!new Map(mapIdentity(identity({}, levels))?.payload.judgements).has(7));
  });

  it('keeps one judgement per registrar', () => {
    const read = mapIdentity(identity({}, [[5, { knownGood: null }], [5, { reasonable: null }]]));
    assert.deepEqual(read?.payload.judgements, [[5, 'KnownGood']]);
    assert.deepEqual(read?.dropped, [{ field: 'judgement[5]', reason: 'duplicate' }]);
  });

  it('sanitisePayload checks a payload that comes from a file and leaves a valid one untouched', () => {
    const valid: MigrationPayloadJson = {
      typed: [
        ['DisplayName', hexOf('Dave')],
        ['Pgp', `0x${'cd'.repeat(32)}`],
      ],
      custom: [[hexOf('k'), hexOf('v')]],
      judgements: [[5, 'KnownGood']],
    };
    assert.deepEqual(sanitisePayload(valid), { payload: valid, dropped: [] });
    const bad = sanitisePayload({
      typed: [['Nope', hexOf('x')], ['Web', 'not hex'], ['Email', '0xzz'], ['Web', hexOf('ok')], ['Web', hexOf('twice')]],
      custom: [['nope']],
      judgements: [[5, 'Great'], ['5', 'KnownGood'], [-1, 'KnownGood']],
    });
    assert.deepEqual(bad.payload, { typed: [['Web', hexOf('ok')]], custom: [], judgements: [] });
    assert.equal(bad.dropped.length, 8);
    assert.throws(() => sanitisePayload({ typed: [] }), /a payload is/);
    assert.throws(() => sanitisePayload(null), /a payload is/);
  });
});

// --- The fixtures and the constants themselves -------------------------------------------------

describe('fixtures and constants', () => {
  it('each fixture holds the SCALE bytes its JSON decodes from', () => {
    const registry = new TypeRegistry();
    registry.register({
      PeopleInfo: {
        display: 'Data',
        legal: 'Data',
        web: 'Data',
        matrix: 'Data',
        email: 'Data',
        pgpFingerprint: 'Option<[u8; 20]>',
        image: 'Data',
        twitter: 'Data',
        github: 'Data',
        discord: 'Data',
      },
      PeopleJudgement: {
        _enum: {
          Unknown: null,
          FeePaid: 'u128',
          Reasonable: null,
          KnownGood: null,
          OutOfDate: null,
          LowQuality: null,
          Erroneous: null,
        },
      },
      PeopleRegistration: { judgements: 'Vec<(u32, PeopleJudgement)>', deposit: 'u128', info: 'PeopleInfo' },
    });
    let checked = 0;
    for (const fixture of [polkadot, kusama]) {
      for (const [name, entry] of Object.entries(fixture.accounts)) {
        if (entry.raw === null) {
          assert.equal(entry.identityOf, null, `${fixture.source}/${name}`);
          continue;
        }
        const decoded = registry.createType('PeopleRegistration', entry.raw).toJSON();
        assert.deepEqual(JSON.parse(JSON.stringify(decoded)), entry.identityOf, `${fixture.source}/${name}`);
        checked++;
      }
    }
    assert.ok(checked >= 8);
  });

  it('fixtures name the finalized block they were read at', () => {
    for (const fixture of [polkadot, kusama]) {
      assert.match(fixture.blockHash, /^0x[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(fixture.block) && fixture.block > 0);
      assert.equal(fixture.specName, `people-${fixture.source.toLowerCase()}`);
    }
  });

  it('DOTID_REGISTRARS are the runtime ones (pallets/identitee/src/migration.rs)', () => {
    const rust = readFileSync(new URL('../../pallets/identitee/src/migration.rs', import.meta.url), 'utf8');
    const declaration = /pub const DOTID_REGISTRARS[\s\S]*?\n\n/.exec(rust)?.[0];
    assert.ok(declaration, 'DOTID_REGISTRARS is declared in migration.rs');
    const parsed: Record<string, number[]> = {};
    for (const [, chain, list] of declaration.matchAll(/SourceChain::(\w+),\s*&\[([^\]]*)\]/g)) {
      parsed[chain as string] = (list as string).split(',').map((n) => Number(n.trim()));
    }
    assert.deepEqual({ ...DOTID_REGISTRARS }, parsed);
  });

  it('every source has two endpoints and the first is the public one', () => {
    assert.equal(PEOPLE_ENDPOINTS.Polkadot[0], 'wss://polkadot-people-rpc.polkadot.io');
    assert.equal(PEOPLE_ENDPOINTS.Kusama[0], 'wss://kusama-people-rpc.polkadot.io');
    assert.equal(PEOPLE_ENDPOINTS.Polkadot.length, 2);
    assert.equal(PEOPLE_ENDPOINTS.Kusama.length, 2);
  });
});
