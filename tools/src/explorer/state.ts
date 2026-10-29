// Live chain state for the explorer API, read at the finalized head and kept 6 s (one block):
// authorities and their agents, identity summaries, roles, validators and node health. Genesis
// authorities, agents and the sudo key emit no events, so these come from storage, not the index.

import type { ApiPromise } from '@polkadot/api';
import type { Codec } from '@polkadot/types/types';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { blake2AsHex, decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { AURA_AUTHORITIES_KEY, auraAuthor, auraAuthorityKeys, auraSlot, SS58_PREFIX, toJson } from './decode.ts';

type Json = any;

const TTL_MS = 6000;
/** `aura` and `gran` as session key type ids. */
const AURA_KEY_TYPE = '0x61757261';
const GRANDPA_KEY_TYPE = '0x6772616e';

/** Capability bits of an agent (pallets/identitee/src/types.rs, `Capabilities`). */
export const CAPABILITIES: ReadonlyArray<[number, string]> = [
  [1, 'attest_fields'],
  [2, 'person_facts'],
  [4, 'manage_names'],
  [8, 'migrate'],
];

export const capabilityNames = (bits: number): string[] => CAPABILITIES.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name);

export interface AgentState {
  address: string;
  capabilities: number;
  capabilityNames: string[];
}

export interface AuthorityState {
  id: number;
  name: string;
  active: boolean;
  agents: AgentState[];
}

export interface IdentitySummary {
  display: string | null;
  username: string | null;
  trust: string | null;
  /** A short hash of the avatar on chain (it changes with the image), null without one. */
  avatar: string | null;
}

export interface Roles {
  sudo: boolean;
  /** In the validator list (pallet validators); on a runtime without it, an Aura or GRANDPA key of
   * the current set. */
  validator: boolean;
  /** The authority this account is an agent of (an account serves at most one). */
  agent: Array<{ authority: number; name: string | null; capabilities: number; capabilityNames: string[] }>;
}

/** Each key comes with the account owning it (SS58, from session's `KeyOwner`), null if none. */
export interface Validators {
  aura: Array<{ key: string; label: string | null; account: string | null }>;
  grandpa: Array<{ key: string; weight: number; label: string | null; account: string | null }>;
  setId: number;
}

export interface Health {
  peers: number;
  isSyncing: boolean;
  shouldHavePeers: boolean;
}

const caches = new WeakMap<object, Map<string, { until: number; value: Promise<unknown> }>>();

/** `load()` once per `key` and 6 s; a failed load is not kept. */
function cached<T>(api: ApiPromise, key: string, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(api);
  if (cache === undefined) caches.set(api, (cache = new Map()));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.until > now) return hit.value as Promise<T>;
  for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
  const value = load();
  cache.set(key, { until: now + TTL_MS, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** The state at the finalized head. */
function head(api: ApiPromise): Promise<Json> {
  return cached(api, 'head', async () => api.at(await api.rpc.chain.getFinalizedHead()));
}

/** The 32-byte public key of an SS58 (any prefix) or hex address, as lowercase hex; throws if invalid. */
export function publicKey(address: string): string {
  return u8aToHex(decodeAddress(address)).toLowerCase();
}

const keys = (list: Codec[]): string[] => list.map((k) => k.toHex().toLowerCase());

export function authorities(api: ApiPromise): Promise<AuthorityState[]> {
  return cached(api, 'authorities', async () => {
    const at = await head(api);
    const [infos, agents] = (await Promise.all([at.query.identitee.authorities.entries(), at.query.identitee.agents.entries()])) as [
      Array<[Json, Json]>,
      Array<[Json, Json]>,
    ];
    const byId = new Map<number, AuthorityState>();
    for (const [key, info] of infos) {
      const value = toJson(info) as { name: string; active: boolean } | null;
      if (value === null) continue;
      const id = key.args[0].toNumber() as number;
      byId.set(id, { id, name: value.name, active: value.active, agents: [] });
    }
    for (const [key, row] of agents) {
      const value = toJson(row) as [number, number] | null;
      if (value === null) continue;
      const [authority, caps] = value;
      byId.get(authority)?.agents.push({ address: encodeAddress(key.args[0].toU8a(), SS58_PREFIX), capabilities: caps, capabilityNames: capabilityNames(caps) });
    }
    const list = [...byId.values()].sort((a, b) => a.id - b.id);
    for (const a of list) a.agents.sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
    return list;
  });
}

export function identitySummary(api: ApiPromise, address: string): Promise<IdentitySummary> {
  const key = publicKey(address);
  return cached(api, `identity:${key}`, async () => {
    const at = await head(api);
    const [identity, name, trust] = (await Promise.all([
      at.query.identitee.identities(key),
      at.query.identitee.nameOf(key),
      at.call.identiteeApi.trustLevel(key),
    ])) as [Codec, Codec, Codec];
    const id = toJson(identity) as { typed?: Array<[unknown, unknown]>; avatar?: unknown } | null;
    let display: string | null = null;
    for (const [kind, value] of id?.typed ?? []) {
      if (kind === 'DisplayName' && typeof value === 'object' && value !== null && typeof (value as Json).Public === 'string') display = (value as Json).Public;
    }
    const username = toJson(name);
    const level = toJson(trust);
    const image = avatarOf(id);
    return {
      display,
      username: typeof username === 'string' ? username : null,
      trust: typeof level === 'string' ? level : null,
      avatar: image === null ? null : blake2AsHex(image, 64).slice(2),
    };
  });
}

/** The avatar bytes (WebP) of an identity as `toJson` gives it, null without one. */
const avatarOf = (identity: { avatar?: unknown } | null): Uint8Array | null =>
  typeof identity?.avatar === 'string' && identity.avatar !== '0x' ? hexToU8a(identity.avatar) : null;

/** The avatar an account has on chain (a WebP image), null without one. */
export function avatar(api: ApiPromise, address: string): Promise<Uint8Array | null> {
  const key = publicKey(address);
  return cached(api, `avatar:${key}`, async () => {
    const at = await head(api);
    return avatarOf(toJson(await at.query.identitee.identities(key)) as { avatar?: unknown } | null);
  });
}

export function roles(api: ApiPromise, address: string): Promise<Roles> {
  const key = publicKey(address);
  return cached(api, `roles:${key}`, async () => {
    const at = await head(api);
    const [sudo, agent, set, listed] = (await Promise.all([
      at.query.sudo.key(),
      at.query.identitee.agents(key),
      validators(api),
      at.query.validators?.validators === undefined ? null : at.query.validators.validators(),
    ])) as [Codec, Codec, Validators, Codec | null];
    const sudoKey = toJson(sudo);
    const row = toJson(agent) as [number, number] | null;
    const list: Roles['agent'] = [];
    if (row !== null) {
      const name = (await authorities(api)).find((a) => a.id === row[0])?.name ?? null;
      list.push({ authority: row[0], name, capabilities: row[1], capabilityNames: capabilityNames(row[1]) });
    }
    return {
      sudo: typeof sudoKey === 'string' && publicKey(sudoKey) === key,
      validator:
        listed === null
          ? set.aura.some((v) => v.key === key) || set.grandpa.some((v) => v.key === key)
          : (toJson(listed) as string[]).some((account) => publicKey(account) === key),
      agent: list,
    };
  });
}

/** Aura and GRANDPA keys of the current set, with the labels of the configuration (hex key to label). */
export function validators(api: ApiPromise, labels: Record<string, string> = {}): Promise<Validators> {
  return cached(api, 'validators', async () => {
    const at = await head(api);
    const [aura, grandpa, setId] = (await Promise.all([at.query.aura.authorities(), at.query.grandpa.authorities(), at.query.grandpa.currentSetId()])) as [
      Codec[],
      Array<[Codec, Codec]>,
      Codec,
    ];
    const auraKeys = keys(aura);
    const grandpaKeys = grandpa.map(([k]) => k.toHex().toLowerCase());
    const [auraOwners, grandpaOwners] = await Promise.all([
      Promise.all(auraKeys.map((k) => keyOwner(api, AURA_KEY_TYPE, k))),
      Promise.all(grandpaKeys.map((k) => keyOwner(api, GRANDPA_KEY_TYPE, k))),
    ]);
    return {
      aura: auraKeys.map((key, i) => ({ key, label: null, account: auraOwners[i]! })),
      grandpa: grandpa.map(([, w], i) => ({ key: grandpaKeys[i]!, weight: Number(w.toString()), label: null, account: grandpaOwners[i]! })),
      setId: Number(setId.toString()),
    } satisfies Validators;
  }).then((v) => {
    const label = (key: string): string | null => labels[key] ?? labels[key.toLowerCase()] ?? findLabel(labels, key);
    return { ...v, aura: v.aura.map((x) => ({ ...x, label: label(x.key) })), grandpa: v.grandpa.map((x) => ({ ...x, label: label(x.key) })) };
  });
}

function findLabel(labels: Record<string, string>, key: string): string | null {
  for (const [k, v] of Object.entries(labels)) if (k.toLowerCase() === key) return v;
  return null;
}

/** The account (SS58) owning an Aura key (lowercase hex) at the finalized head, null if none:
 * session's `KeyOwner`, which a validator's keys enter when it is added. */
export function auraKeyOwner(api: ApiPromise, key: string): Promise<string | null> {
  return keyOwner(api, AURA_KEY_TYPE, key);
}

/** The account (SS58) owning a session key of `type`, null if none (or no session pallet). */
function keyOwner(api: ApiPromise, type: string, key: string): Promise<string | null> {
  return cached(api, `owner:${type}:${key}`, async () => {
    const at = await head(api);
    if (at.query.session?.keyOwner === undefined) return null;
    const owner = toJson(await at.query.session.keyOwner([type, key]));
    return typeof owner === 'string' ? encodeAddress(decodeAddress(owner), SS58_PREFIX) : null;
  });
}

/** A block of the best chain that the index does not hold yet (not finalized, or not indexed yet),
 * as its header and body say. Its time is the start of its Aura slot. */
export interface RecentBlock {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  timestamp: number | null;
  specVersion: number;
  author: string | null;
  extrinsicCount: number;
}

/** Block `n` of the node's best chain, null if it has none: re-read every 6 s, as the best chain can
 * change below the finalized head. */
export function recentBlock(api: ApiPromise, n: number): Promise<RecentBlock | null> {
  return cached(api, `recent:${n}`, async () => {
    const hash = (await api.rpc.chain.getBlockHash(n)) as Json;
    if (hash.isEmpty) return null;
    const [signed, version] = (await Promise.all([api.rpc.chain.getBlock(hash), api.rpc.state.getRuntimeVersion(hash)])) as [Json, Json];
    const header = signed.block.header;
    const slot = auraSlot(header.digest.logs);
    let author: string | null = null;
    if (slot !== null && n > 0) {
      // the authorities at the parent, read raw: see `auraAuthorityKeys`
      const raw = (await api.rpc.state.getStorage(AURA_AUTHORITIES_KEY, header.parentHash)) as Json;
      const keys = raw.isSome ? auraAuthorityKeys(raw.unwrap().toU8a(true)) : [];
      if (keys.length > 0) author = auraAuthor(slot, keys);
    }
    // Aura slots last twice the timestamp's minimum period
    const period = (api.consts as Json).timestamp?.minimumPeriod;
    return {
      number: n,
      hash: hash.toHex(),
      parentHash: header.parentHash.toHex(),
      stateRoot: header.stateRoot.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      timestamp: slot !== null && period !== undefined ? Number(slot) * 2 * Number(period.toString()) : null,
      specVersion: version.specVersion.toNumber(),
      author,
      extrinsicCount: signed.block.extrinsics.length,
    };
  });
}

/** The GRANDPA authority keys (lowercase hex) in the state at `blockHash`; needs a node that keeps that state. */
export function grandpaMembers(api: ApiPromise, blockHash: string): Promise<string[]> {
  return cached(api, `grandpa:${blockHash}`, async () => {
    const at = await api.at(blockHash);
    const list = (await at.query.grandpa.authorities()) as unknown as Array<[Codec, Codec]>;
    return list.map(([k]) => k.toHex().toLowerCase());
  });
}

export function health(api: ApiPromise): Promise<Health> {
  return cached(api, 'health', async () => {
    const h = await api.rpc.system.health();
    return { peers: h.peers.toNumber(), isSyncing: h.isSyncing.isTrue, shouldHavePeers: h.shouldHavePeers.isTrue };
  });
}
