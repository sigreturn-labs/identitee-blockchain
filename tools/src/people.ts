// Reading identities from the People Chains (Polkadot, Kusama).
//
//   npx tsx src/people.ts <address> [polkadot|kusama]   read-only: print the migration payload
//
// See tools/README.md.

import { pathToFileURL } from 'node:url';

import { ApiPromise, WsProvider } from '@polkadot/api';

// --- Protocol constants ----------------------------------------------------------------------

export type SourceName = 'Polkadot' | 'Kusama';

/**
 * People Chain endpoints per source, in order: the first that connects is used. Read at the
 * latest FINALIZED block only, so a flaky node cannot feed the chain a block that gets reorged.
 */
export const PEOPLE_ENDPOINTS: Record<SourceName, readonly string[]> = {
  Polkadot: ['wss://polkadot-people-rpc.polkadot.io', 'wss://rpc-people-polkadot.luckyfriday.io'],
  Kusama: ['wss://kusama-people-rpc.polkadot.io', 'wss://rpc-people-kusama.luckyfriday.io'],
};

/**
 * dotID's registrar indices per source, the preferred one first. Mirrors `DOTID_REGISTRARS` of
 * pallets/identitee/src/migration.rs (the runtime does the judgement mapping; the tools only
 * select accounts), and a test checks that the two stay equal.
 */
export const DOTID_REGISTRARS: Record<SourceName, readonly number[]> = {
  Polkadot: [5],
  Kusama: [7, 6],
};

/** How long one endpoint gets to connect before the next one is tried. */
const CONNECT_TIMEOUT_MS = 20_000;

// --- Connection ------------------------------------------------------------------------------

export interface PeopleConnection {
  api: ApiPromise;
  endpoint: string;
}

/**
 * Connect to the People Chain of `source`, trying `endpoints` in order. A provider that cannot
 * connect within the timeout is dropped (auto-reconnect is off, so it cannot linger) and the next
 * one is tried; fails with every endpoint's reason if none connects. `first` rotates the order,
 * so a caller that just lost an endpoint can start from the next one.
 */
export async function connectPeople(
  source: SourceName,
  options: { endpoints?: readonly string[]; first?: number; timeoutMs?: number } = {},
): Promise<PeopleConnection> {
  const all = options.endpoints ?? PEOPLE_ENDPOINTS[source];
  const shift = (options.first ?? 0) % all.length;
  const endpoints = [...all.slice(shift), ...all.slice(0, shift)];
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    const provider = new WsProvider(endpoint, false);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
      });
      const created = (async () => {
        await provider.connect();
        return ApiPromise.create({ provider, noInitWarn: true });
      })();
      created.catch(() => undefined); // an attempt that loses the race must not become unhandled
      const api = await Promise.race([created, timeout]);
      return { api, endpoint };
    } catch (e) {
      failures.push(`${endpoint}: ${e instanceof Error ? e.message : String(e)}`);
      await provider.disconnect().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`no People Chain endpoint for ${source} answered (${failures.join('; ')})`);
}

// --- Payload ---------------------------------------------------------------------------------

/** `FieldKind` of the pallet (pallets/identitee/src/types.rs), by variant name. */
export type FieldKindName =
  | 'DisplayName'
  | 'LegalName'
  | 'Web'
  | 'Email'
  | 'Matrix'
  | 'X'
  | 'Discord'
  | 'GitHub'
  | 'Telegram'
  | 'Pgp';

/** `JudgementLevel` of the pallet, by variant name (`FeePaid` without its amount). */
export type JudgementLevelName =
  | 'Unknown'
  | 'FeePaid'
  | 'Reasonable'
  | 'KnownGood'
  | 'OutOfDate'
  | 'LowQuality'
  | 'Erroneous';

/**
 * A `MigrationPayload` as `api.tx.identitee.fulfilMigration` takes it: values and custom keys as
 * `0x` hex of their bytes, so that a snapshot file holds exactly what is sent.
 */
export interface MigrationPayloadJson {
  typed: Array<[FieldKindName, string]>;
  custom: Array<[string, string]>;
  judgements: Array<[number, JudgementLevelName]>;
}

/** Why an entry of an identity was left out of the payload. */
export type DropReason =
  | 'hashed' // Data::Sha256 and the like: only a hash is on chain, there is no value to import
  | 'unsupported' // a field, key or judgement the pallet has no place for
  | 'empty'
  | 'invalid-utf8'
  | 'too-long'
  | 'bad-pgp-length'
  | 'duplicate'
  | 'too-many'
  | 'malformed';

export interface Dropped {
  /** The People Chain field, or `additional[<index>]`, or `judgement[<registrar>]`. */
  field: string;
  reason: DropReason;
  detail?: string;
}

/** The chain's limits that a payload must respect (the runtime refuses the whole call otherwise). */
export interface Limits {
  maxValueLen: number;
  maxCustomKeyLen: number;
  maxCustomFields: number;
  maxTypedFields: number;
  maxImportedJudgements: number;
}

/** The limits of the design (pallets/identitee/src/limits.rs); the migrator reads the node's own. */
export const DEFAULT_LIMITS: Limits = {
  maxValueLen: 256,
  maxCustomKeyLen: 32,
  maxCustomFields: 16,
  maxTypedFields: 16,
  maxImportedJudgements: 32,
};

/** People Chain `IdentityInfo` field → identitee field. `image` has no counterpart and is ignored. */
const TYPED_FIELDS: ReadonlyArray<readonly [string, FieldKindName]> = [
  ['display', 'DisplayName'],
  ['legal', 'LegalName'],
  ['web', 'Web'],
  ['email', 'Email'],
  ['matrix', 'Matrix'],
  ['twitter', 'X'],
  ['discord', 'Discord'],
  ['github', 'GitHub'],
  ['pgpFingerprint', 'Pgp'],
];

const FIELD_KINDS: ReadonlySet<string> = new Set<FieldKindName>([
  'DisplayName',
  'LegalName',
  'Web',
  'Email',
  'Matrix',
  'X',
  'Discord',
  'GitHub',
  'Telegram',
  'Pgp',
]);

/** polkadot.js's JSON name of a `pallet_identity::Judgement` variant → the pallet's. */
const JUDGEMENTS: Readonly<Record<string, JudgementLevelName>> = {
  unknown: 'Unknown',
  feePaid: 'FeePaid',
  reasonable: 'Reasonable',
  knownGood: 'KnownGood',
  outOfDate: 'OutOfDate',
  lowQuality: 'LowQuality',
  erroneous: 'Erroneous',
};

const JUDGEMENT_NAMES: ReadonlySet<string> = new Set(Object.values(JUDGEMENTS));

type Json = any;

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `0x` followed by whole bytes. */
const isHexBytes = (value: unknown): value is string =>
  typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

const hexLength = (hex: string): number => (hex.length - 2) / 2;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Whether the bytes of `hex` are valid UTF-8, the check the runtime applies to text. */
function isUtf8Hex(hex: string): boolean {
  const bytes = Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a payload the way the runtime's `fulfil_migration` will, and keep what it would accept:
 * the runtime refuses the WHOLE call on one invalid entry, so an entry that would be refused is
 * dropped here and said so (`dropped`). Valid entries are returned untouched, in order; the first
 * of two entries with the same key wins. When there are more judgements than the chain takes, the
 * source's dotID registrars (`source`) are kept first: they are the only ones the runtime maps.
 *
 * `input` may come from a file: its shape is checked too, and a payload that is not even three
 * arrays throws.
 */
export function sanitisePayload(
  input: unknown,
  limits: Limits = DEFAULT_LIMITS,
  source?: SourceName,
): { payload: MigrationPayloadJson; dropped: Dropped[] } {
  if (!isRecord(input) || !Array.isArray(input.typed) || !Array.isArray(input.custom) || !Array.isArray(input.judgements)) {
    throw new Error('a payload is {typed: [...], custom: [...], judgements: [...]}');
  }
  const dropped: Dropped[] = [];
  const drop = (field: string, reason: DropReason, detail?: string): void => {
    dropped.push(detail === undefined ? { field, reason } : { field, reason, detail });
  };

  const typed: MigrationPayloadJson['typed'] = [];
  const seenKinds = new Set<string>();
  for (const entry of input.typed) {
    const [kind, value] = Array.isArray(entry) ? entry : [];
    const field = typeof kind === 'string' ? kind : '?';
    if (!FIELD_KINDS.has(kind) || !isHexBytes(value)) {
      drop(field, 'malformed');
    } else if (seenKinds.has(kind)) {
      drop(field, 'duplicate');
    } else if (hexLength(value) === 0) {
      drop(field, 'empty');
    } else if (hexLength(value) > limits.maxValueLen) {
      drop(field, 'too-long', `${hexLength(value)} bytes, at most ${limits.maxValueLen}`);
    } else if (kind === 'Pgp' && hexLength(value) !== 20 && hexLength(value) !== 32) {
      drop(field, 'bad-pgp-length', `${hexLength(value)} bytes, a fingerprint has 20 or 32`);
    } else if (kind !== 'Pgp' && !isUtf8Hex(value)) {
      drop(field, 'invalid-utf8');
    } else if (typed.length >= limits.maxTypedFields) {
      drop(field, 'too-many');
    } else {
      seenKinds.add(kind);
      typed.push([kind, value]);
    }
  }

  const custom: MigrationPayloadJson['custom'] = [];
  const seenKeys = new Set<string>();
  input.custom.forEach((entry: unknown, index: number) => {
    const [key, value] = Array.isArray(entry) ? entry : [];
    const field = `additional[${index}]`;
    if (!isHexBytes(key) || !isHexBytes(value)) {
      drop(field, 'malformed');
    } else if (hexLength(key) === 0 || hexLength(value) === 0) {
      drop(field, 'empty');
    } else if (hexLength(key) > limits.maxCustomKeyLen) {
      drop(field, 'too-long', `key of ${hexLength(key)} bytes, at most ${limits.maxCustomKeyLen}`);
    } else if (hexLength(value) > limits.maxValueLen) {
      drop(field, 'too-long', `${hexLength(value)} bytes, at most ${limits.maxValueLen}`);
    } else if (!isUtf8Hex(key) || !isUtf8Hex(value)) {
      drop(field, 'invalid-utf8');
    } else if (seenKeys.has(key.toLowerCase())) {
      drop(field, 'duplicate');
    } else if (custom.length >= limits.maxCustomFields) {
      drop(field, 'too-many');
    } else {
      seenKeys.add(key.toLowerCase());
      custom.push([key, value]);
    }
  });

  let judgements: MigrationPayloadJson['judgements'] = [];
  const seenRegistrars = new Set<number>();
  for (const entry of input.judgements) {
    const [registrar, level] = Array.isArray(entry) ? entry : [];
    const field = `judgement[${typeof registrar === 'number' ? registrar : '?'}]`;
    if (!Number.isInteger(registrar) || registrar < 0 || registrar > 0xffff_ffff || !JUDGEMENT_NAMES.has(level)) {
      drop(field, 'malformed');
    } else if (seenRegistrars.has(registrar)) {
      drop(field, 'duplicate');
    } else {
      seenRegistrars.add(registrar);
      judgements.push([registrar, level]);
    }
  }
  if (judgements.length > limits.maxImportedJudgements) {
    const dotid = source === undefined ? [] : DOTID_REGISTRARS[source];
    const ranked = [...judgements].sort(
      (a, b) => Number(!dotid.includes(a[0])) - Number(!dotid.includes(b[0])),
    );
    const kept = new Set(ranked.slice(0, limits.maxImportedJudgements).map(([registrar]) => registrar));
    for (const [registrar] of judgements) {
      if (!kept.has(registrar)) drop(`judgement[${registrar}]`, 'too-many');
    }
    judgements = judgements.filter(([registrar]) => kept.has(registrar));
  }

  return { payload: { typed, custom, judgements }, dropped };
}

// --- Mapping a People Chain identity ---------------------------------------------------------

/**
 * The bytes of a People Chain `Data` as polkadot.js writes them in JSON: `{raw: '0x…'}` for a
 * value, `{none: null}` for nothing, and a one-key object named after the hash for the hashed
 * variants (`blakeTwo256`, `sha256`, `keccak256`, `shaThree256`). Returns the hex of a raw value
 * (possibly empty), `null` for nothing, or `'hashed'`.
 */
function dataHex(data: unknown): string | null | 'hashed' {
  if (data === null || data === undefined) return null;
  if (!isRecord(data)) throw new Error(`unexpected Data ${JSON.stringify(data)}`);
  const keys = Object.keys(data);
  if (keys.length !== 1) throw new Error(`unexpected Data ${JSON.stringify(data)}`);
  const key = keys[0] as string;
  if (key === 'none') return null;
  if (/^raw\d*$/.test(key)) {
    if (!isHexBytes(data[key])) throw new Error(`unexpected Data ${JSON.stringify(data)}`);
    return data[key];
  }
  return 'hashed';
}

/** The `Registration` of an `identityOf` value, which is `Option<Registration>` or `Option<(Registration, Option<username>)>`. */
function registrationOf(value: unknown): Json | null {
  if (value === null || value === undefined) return null;
  const registration = Array.isArray(value) ? value[0] : value;
  if (!isRecord(registration) || !isRecord(registration.info) || !Array.isArray(registration.judgements)) {
    throw new Error(`unexpected identityOf value ${JSON.stringify(value).slice(0, 200)}`);
  }
  return registration;
}

/**
 * The migration payload of a decoded `identity.identityOf` value (its `toJSON()`), or `null` if
 * the account has no identity. Only `Data::Raw` values are imported; the hashed variants are
 * dropped, `image` is ignored, `additional` (absent on the People Chains today) becomes custom
 * fields, and every judgement is kept. What the runtime would refuse is dropped and listed (see
 * `sanitisePayload`). Throws if the value is not an identity at all: that is a failure to read,
 * never to be taken for "no identity".
 */
export function mapIdentity(
  value: unknown,
  options: { limits?: Limits; source?: SourceName } = {},
): { payload: MigrationPayloadJson; dropped: Dropped[] } | null {
  const registration = registrationOf(value);
  if (registration === null) return null;
  const dropped: Dropped[] = [];

  const typed: MigrationPayloadJson['typed'] = [];
  for (const [name, kind] of TYPED_FIELDS) {
    const field = registration.info[name];
    // `pgpFingerprint` is `Option<[u8; N]>`: null or the bytes. The others are `Data`.
    const hex = name === 'pgpFingerprint' ? (field ?? null) : dataHex(field);
    // Nothing, or a raw value of zero bytes (what a form leaves for a field never filled in).
    if (hex === null || hex === '0x') continue;
    if (hex === 'hashed') {
      dropped.push({ field: kind, reason: 'hashed' });
    } else if (!isHexBytes(hex)) {
      throw new Error(`unexpected ${name} ${JSON.stringify(field)}`);
    } else {
      typed.push([kind, hex]);
    }
  }

  const custom: MigrationPayloadJson['custom'] = [];
  const customIndex: number[] = []; // position in `additional` of each candidate, for the log
  const additional: unknown = registration.info.additional ?? [];
  if (!Array.isArray(additional)) throw new Error('unexpected additional');
  additional.forEach((pair: unknown, index: number) => {
    const [key, value] = Array.isArray(pair) ? pair : [];
    const [keyHex, valueHex] = [dataHex(key), dataHex(value)];
    if (keyHex === 'hashed' || valueHex === 'hashed') {
      dropped.push({ field: `additional[${index}]`, reason: 'hashed' });
    } else if (keyHex !== null && valueHex !== null) {
      custom.push([keyHex, valueHex]);
      customIndex.push(index);
    } else {
      dropped.push({ field: `additional[${index}]`, reason: 'empty' });
    }
  });

  const judgements: MigrationPayloadJson['judgements'] = [];
  for (const entry of registration.judgements) {
    const [registrar, judgement] = Array.isArray(entry) ? entry : [];
    const name = isRecord(judgement) ? JUDGEMENTS[Object.keys(judgement)[0] ?? ''] : undefined;
    if (name === undefined) {
      dropped.push({ field: `judgement[${registrar}]`, reason: 'unsupported', detail: JSON.stringify(judgement) });
    } else {
      judgements.push([registrar, name]);
    }
  }

  const sanitised = sanitisePayload({ typed, custom, judgements }, options.limits, options.source);
  // `sanitisePayload` counts the custom candidates; the log counts the source's `additional`.
  const later = sanitised.dropped.map((d) => {
    const at = /^additional\[(\d+)\]$/.exec(d.field);
    return at ? { ...d, field: `additional[${customIndex[Number(at[1])]}]` } : d;
  });
  return { payload: sanitised.payload, dropped: [...dropped, ...later] };
}

// --- Reading ---------------------------------------------------------------------------------

export interface PeopleRead {
  /** The finalized block the identity was read at, and its hash. */
  block: number;
  blockHash: string;
  payload: MigrationPayloadJson;
  /** What was left out of the payload, and why. */
  dropped: Dropped[];
}

/** The environment variable that pins the block a source chain is read at. */
export const PEOPLE_AT_ENV: Record<SourceName, string> = {
  Polkadot: 'PEOPLE_AT_BLOCK_POLKADOT',
  Kusama: 'PEOPLE_AT_BLOCK_KUSAMA',
};

/** A block hash as given by an operator: `0x` and 32 bytes, else an error naming where it came from. */
export function parseBlockHash(value: string, where: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${where} must be a block hash (0x and 64 hex digits), got ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

/** The block `source` is pinned to by its environment variable, if set (empty counts as unset). */
export function pinnedBlock(source: SourceName, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[PEOPLE_AT_ENV[source]];
  return value ? parseBlockHash(value, PEOPLE_AT_ENV[source]) : undefined;
}

/**
 * Read the identity of `who` (an address in any SS58 format: only the key counts) on a People
 * Chain. `null` if the account has no identity there.
 *
 * By default the read is at the latest FINALIZED block. With `at` (a block hash) it is at that
 * block instead: the way to migrate from the last block before the pallet is removed from the
 * People Chain, which needs an archive endpoint (a pruned node refuses the state, and the caller
 * can try the next endpoint). A pinned block must be finalized and on the canonical chain: a
 * typo, or a hash of a fork, is refused rather than read. Either way `block` and `blockHash` are
 * the block that was read, as `fulfil_migration` records them.
 */
export async function readPeopleIdentity(
  api: ApiPromise,
  who: string,
  options: { limits?: Limits; source?: SourceName; at?: string } = {},
): Promise<PeopleRead | null> {
  const hash =
    options.at === undefined
      ? (await api.rpc.chain.getFinalizedHead()).toHex()
      : parseBlockHash(options.at, 'the pinned block');
  const block = (await api.rpc.chain.getHeader(hash)).number.toNumber();
  if (options.at !== undefined) {
    const finalized = await api.rpc.chain.getFinalizedHead();
    const [canonical, finalizedHeader] = await Promise.all([api.rpc.chain.getBlockHash(block), api.rpc.chain.getHeader(finalized.toHex())]);
    if (canonical.toHex() !== hash) throw new Error(`block ${hash} (#${block}) is not on the canonical chain`);
    const finalizedNumber = finalizedHeader.number.toNumber();
    if (block > finalizedNumber) throw new Error(`block ${hash} (#${block}) is not finalized yet (finalized: #${finalizedNumber})`);
  }
  const at = await api.at(hash);
  const mapped = mapIdentity((await at.query.identity.identityOf(who)).toJSON(), options);
  if (mapped === null) return null;
  return { block, blockHash: hash, ...mapped };
}

// --- Command line ----------------------------------------------------------------------------

/** A value for a human: its text if it is UTF-8, its hex otherwise. */
const show = (hex: string): string => {
  try {
    return JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex.slice(2), 'hex')));
  } catch {
    return hex;
  }
};

const CLI_USAGE = `usage: npx tsx src/people.ts <address> [polkadot|kusama] [--at <block hash>]

  Without a chain both are read. --at reads at that block instead of the latest finalized one
  (an archive endpoint is needed) and needs the chain. The environment variables
  PEOPLE_AT_BLOCK_POLKADOT and PEOPLE_AT_BLOCK_KUSAMA pin the same way when --at is not given.`;

async function cli(args: string[]): Promise<number> {
  const argv: string[] = [];
  let at: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--at') {
      at = args[++i];
      if (at === undefined) {
        console.error(`--at needs a block hash\n${CLI_USAGE}`);
        return 2;
      }
    } else if (arg.startsWith('--at=')) {
      at = arg.slice('--at='.length);
    } else {
      argv.push(arg);
    }
  }
  const [address, which] = argv;
  if (!address || address.startsWith('-') || argv.length > 2) {
    console.error(CLI_USAGE);
    return 2;
  }
  if (at !== undefined && which === undefined) {
    console.error(`--at is the hash of a block of ONE chain: say which\n${CLI_USAGE}`);
    return 2;
  }
  if (at !== undefined) parseBlockHash(at, '--at');
  const sources: SourceName[] =
    which === undefined ? ['Polkadot', 'Kusama'] : which.toLowerCase() === 'polkadot' ? ['Polkadot'] : which.toLowerCase() === 'kusama' ? ['Kusama'] : [];
  if (sources.length === 0) {
    console.error(`unknown chain ${which}: polkadot or kusama`);
    return 2;
  }
  for (const source of sources) {
    const started = Date.now();
    const { api, endpoint } = await connectPeople(source);
    try {
      const pinned = at ?? pinnedBlock(source, process.env);
      const read = await readPeopleIdentity(api, address, { source, ...(pinned ? { at: pinned } : {}) });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (read === null) {
        console.log(`${source}: no identity for ${address} (${endpoint}, ${seconds} s)`);
        continue;
      }
      console.log(
        `${source}: ${address} at ${pinned ? 'pinned' : 'finalized'} block ${read.block} ${read.blockHash} (${endpoint}, ${seconds} s)`,
      );
      for (const [kind, hex] of read.payload.typed) console.log(`  ${kind.padEnd(12)} ${kind === 'Pgp' ? hex : show(hex)}`);
      for (const [key, hex] of read.payload.custom) console.log(`  custom ${show(key)} = ${show(hex)}`);
      const dotid = DOTID_REGISTRARS[source];
      for (const [registrar, level] of read.payload.judgements) {
        console.log(`  judgement    registrar ${registrar}${dotid.includes(registrar) ? ' (dotID)' : ''}: ${level}`);
      }
      for (const d of read.dropped) console.log(`  dropped      ${d.field}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`);
      console.log(`  payload      ${JSON.stringify(read.payload)}`);
    } finally {
      await api.disconnect();
    }
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
