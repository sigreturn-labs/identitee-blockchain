// Live chain state for the explorer API, read at the finalized head and kept 6 s (one block):
// authorities and their agents, identity summaries, roles, validators and node health. Genesis
// authorities, agents and the sudo key emit no events, so these come from storage, not the index.

import type { ApiPromise } from '@polkadot/api';
import type { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { SS58_PREFIX, toJson } from './decode.ts';

type Json = any;

const TTL_MS = 6000;

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
}

export interface Roles {
  sudo: boolean;
  /** An Aura or GRANDPA key of the current set. */
  validator: boolean;
  /** The authority this account is an agent of (an account serves at most one). */
  agent: Array<{ authority: number; name: string | null; capabilities: number; capabilityNames: string[] }>;
}

export interface Validators {
  aura: Array<{ key: string; label: string | null }>;
  grandpa: Array<{ key: string; weight: number; label: string | null }>;
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
    const id = toJson(identity) as { typed?: Array<[unknown, unknown]> } | null;
    let display: string | null = null;
    for (const [kind, value] of id?.typed ?? []) {
      if (kind === 'DisplayName' && typeof value === 'object' && value !== null && typeof (value as Json).Public === 'string') display = (value as Json).Public;
    }
    const username = toJson(name);
    const level = toJson(trust);
    return { display, username: typeof username === 'string' ? username : null, trust: typeof level === 'string' ? level : null };
  });
}

export function roles(api: ApiPromise, address: string): Promise<Roles> {
  const key = publicKey(address);
  return cached(api, `roles:${key}`, async () => {
    const at = await head(api);
    const [sudo, agent, set] = (await Promise.all([at.query.sudo.key(), at.query.identitee.agents(key), validators(api)])) as [Codec, Codec, Validators];
    const sudoKey = toJson(sudo);
    const row = toJson(agent) as [number, number] | null;
    const list: Roles['agent'] = [];
    if (row !== null) {
      const name = (await authorities(api)).find((a) => a.id === row[0])?.name ?? null;
      list.push({ authority: row[0], name, capabilities: row[1], capabilityNames: capabilityNames(row[1]) });
    }
    return {
      sudo: typeof sudoKey === 'string' && publicKey(sudoKey) === key,
      validator: set.aura.some((v) => v.key === key) || set.grandpa.some((v) => v.key === key),
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
    return {
      aura: keys(aura).map((key) => ({ key, label: null })),
      grandpa: grandpa.map(([k, w]) => ({ key: k.toHex().toLowerCase(), weight: Number(w.toString()), label: null })),
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
