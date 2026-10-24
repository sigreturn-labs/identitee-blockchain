// Build the People Chain test fixtures (test/fixtures/people-{polkadot,kusama}.json).
//
//   npx tsx src/make-fixtures.ts            rewrites both files, no network
//
// The identities are synthetic: fictional values on development accounts (`//Bob`, `//Charlie`...),
// one per property the migration has to handle. Each is encoded as the People Chain stores it
// (the SCALE value of `identity.identityOf`, with the storage key of its account) and decoded
// back to the JSON that polkadot.js gives for it, so the tests read them exactly like a node's
// answer. The block numbers and hashes are made up too: they only have to look like the real ones.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { Keyring } from '@polkadot/keyring';
import { TypeRegistry } from '@polkadot/types';
import { stringToHex, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsHex, cryptoWaitReady, xxhashAsU8a } from '@polkadot/util-crypto';

import { PEOPLE_ENDPOINTS, type SourceName } from './people.ts';

/** The People Chain types, as the tests decode them (test/people.test.ts). */
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

type Data = { Raw: string } | { BlakeTwo256: string } | { ShaThree256: string } | { None: null };

const text = (value: string): Data => ({ Raw: stringToHex(value) });
const bytes = (hex: string): Data => ({ Raw: hex });
const sha3 = (value: string): string => `0x${createHash('sha3-256').update(value, 'utf8').digest('hex')}`;

interface Pick {
  name: string;
  seed: string;
  why: string;
  judgements: Array<[number, Record<string, unknown>]>;
  deposit: bigint;
  info: Partial<Record<string, Data | string | null>>;
}

/** The identity shared by both chains: every People Chain field, with a PGP fingerprint. */
const BOB_INFO: Pick['info'] = {
  display: text('Bob'),
  legal: text('Bob Example'),
  web: text('https://bob.example.com'),
  matrix: text('@bob:example.org'),
  email: text('bob@example.org'),
  pgpFingerprint: '0xb0b0000000000000000000000000000000b0b0b0',
  image: bytes(blake2AsHex('synthetic avatar of bob')),
  twitter: text('@bob_example'),
  github: text('bob-example'),
  discord: text('bob_example'),
};

const PICKS: Record<SourceName, Pick[]> = {
  Polkadot: [
    {
      name: 'all_fields_with_pgp',
      seed: '//Bob',
      why: 'every People Chain field set (display, legal, web, matrix, email, pgp, image, twitter, github, discord), judged KnownGood by dotID (5)',
      judgements: [[5, { KnownGood: null }]],
      deposit: 2_016_700_000n,
      info: BOB_INFO,
    },
    {
      name: 'dotid_known_good_and_other_registrar',
      seed: '//Charlie',
      why: 'a Reasonable judgement of registrar 0 next to dotID (5) KnownGood',
      judgements: [
        [0, { Reasonable: null }],
        [5, { KnownGood: null }],
      ],
      deposit: 2_011_100_000n,
      info: {
        display: text('Charlie'),
        matrix: text('@charlie:example.org'),
        email: text('charlie@example.com'),
        twitter: text('@charlie_example'),
        discord: text('charlie.example'),
      },
    },
    {
      name: 'hashed_email',
      seed: '//Dave',
      why: 'the email is a BlakeTwo256 hash (Data::BlakeTwo256), not a value',
      judgements: [[4, { Reasonable: null }]],
      deposit: 2_008_400_000n,
      info: {
        display: text('Dave'),
        legal: text('Dave Example'),
        email: { BlakeTwo256: blake2AsHex('dave@example.org') },
        github: text('dave-example'),
      },
    },
    {
      name: 'dotid_fee_paid',
      seed: '//Eve',
      why: 'dotID (5) judgement still FeePaid (carries an amount)',
      judgements: [[5, { FeePaid: 0 }]],
      deposit: 2_007_600_000n,
      info: { display: text('Eve'), legal: text('Eve Example'), email: text('eve@example.org') },
    },
    {
      name: 'dotid_out_of_date_other_reasonable',
      seed: '//Ferdie',
      why: 'dotID (5) OutOfDate next to FeePaid (3) and Reasonable (4)',
      judgements: [
        [3, { FeePaid: 5_000_000_000 }],
        [4, { Reasonable: null }],
        [5, { OutOfDate: null }],
      ],
      deposit: 2_008_600_000n,
      info: { display: text('Ferdie'), legal: text('Ferdie Example'), email: text('ferdie@example.com') },
    },
  ],
  Kusama: [
    {
      name: 'fee_paid_unknown_and_reasonable',
      seed: '//Charlie',
      why: 'FeePaid (5), Unknown (6) and Reasonable (7): both Kusama dotID registrars present, only 7 is a verdict',
      judgements: [
        [5, { FeePaid: 40_000_000_000 }],
        [6, { Unknown: null }],
        [7, { Reasonable: null }],
      ],
      deposit: 6_702_333_291n,
      info: {
        display: text('Charlie'),
        legal: text('Charlie Example'),
        web: text('https://charlie.example.com'),
        email: text('charlie@example.com'),
      },
    },
    {
      name: 'both_dotid_registrars',
      seed: '//Dave',
      why: 'KnownGood by the former dotID registrar (6), OutOfDate by the current one (7)',
      judgements: [
        [6, { KnownGood: null }],
        [7, { OutOfDate: null }],
      ],
      deposit: 6_727_333_266n,
      info: {
        display: text('Dave | Example Validator'),
        web: text('https://dave.example.org'),
        matrix: text('@dave:example.org'),
        email: text('dave@example.org'),
        image: text('https://dave.example.org/a.png'),
        twitter: text('@dave_example'),
        github: text('dave-example'),
      },
    },
    {
      name: 'all_fields_with_pgp',
      seed: '//Bob',
      why: 'every People Chain field set, judged KnownGood by dotID (7)',
      judgements: [[7, { KnownGood: null }]],
      deposit: 6_722_333_271n,
      info: BOB_INFO,
    },
    {
      name: 'hashed_legal',
      seed: '//Eve',
      why: 'the legal name is a BlakeTwo256 hash; Reasonable by the former dotID registrar (6)',
      judgements: [[6, { Reasonable: null }]],
      deposit: 6_700_999_959n,
      info: {
        display: text('Eve'),
        legal: { BlakeTwo256: blake2AsHex('Eve Example') },
        matrix: text('@eve:example.org'),
        email: text('eve@example.com'),
      },
    },
    {
      name: 'hashed_web_sha3',
      seed: '//Ferdie',
      why: 'the web value is a ShaThree256 hash (another hashed variant), no judgement',
      judgements: [],
      deposit: 6_703_666_623n,
      info: {
        display: text('フェルディ Ferdie 🌞'),
        legal: text('Ferdie Example'),
        web: { ShaThree256: sha3('https://ferdie.example.com') },
        matrix: bytes('0x'),
        email: bytes('0x'),
        twitter: text('@ferdie_example'),
      },
    },
  ],
};

/** Synthetic block metadata, of the order of the People Chains in late 2026. */
const BLOCKS: Record<SourceName, { specName: string; specVersion: number; block: number }> = {
  Polkadot: { specName: 'people-polkadot', specVersion: 2_005_000, block: 11_294_191 },
  Kusama: { specName: 'people-kusama', specVersion: 2_003_002, block: 11_263_113 },
};

/** The account that is `//Alice` on every chain: no People Chain identity, for the empty answer. */
const NO_IDENTITY_SEED = '//Alice';

const SS58: Record<SourceName, number> = { Polkadot: 0, Kusama: 2 };

/** `identity.identityOf` is a `Twox64Concat` map over the account id. */
function storageKey(publicKey: Uint8Array): string {
  return u8aToHex(
    u8aConcat(xxhashAsU8a('Identity', 128), xxhashAsU8a('IdentityOf', 128), xxhashAsU8a(publicKey, 64), publicKey),
  );
}

function build(source: SourceName, keyring: Keyring): unknown {
  const none = { None: null };
  const accounts: Record<string, unknown> = {};
  for (const pick of PICKS[source]) {
    const pair = keyring.addFromUri(pick.seed);
    const registration = registry.createType('PeopleRegistration', {
      judgements: pick.judgements,
      deposit: pick.deposit,
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
        ...pick.info,
      },
    });
    const raw = registration.toHex();
    accounts[pick.name] = {
      address: keyring.encodeAddress(pair.publicKey, SS58[source]),
      why: pick.why,
      storageKey: storageKey(pair.publicKey),
      raw,
      identityOf: JSON.parse(JSON.stringify(registry.createType('PeopleRegistration', raw).toJSON())),
    };
  }
  const alice = keyring.addFromUri(NO_IDENTITY_SEED);
  accounts.no_identity = {
    address: keyring.encodeAddress(alice.publicKey, SS58[source]),
    why: 'an account without a People Chain identity',
    storageKey: storageKey(alice.publicKey),
    raw: null,
    identityOf: null,
  };
  const { specName, specVersion, block } = BLOCKS[source];
  return {
    source,
    endpoint: PEOPLE_ENDPOINTS[source][0],
    specName,
    specVersion,
    block,
    blockHash: blake2AsHex(`synthetic ${specName} block ${block}`),
    accounts,
  };
}

await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519' });
for (const source of ['Polkadot', 'Kusama'] as const) {
  const file = new URL(`../test/fixtures/people-${source.toLowerCase()}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(build(source, keyring), null, 2)}\n`);
  console.log(`wrote ${file.pathname}`);
}
