// Decoding helpers of the explorer indexer: block author from the Aura digest, GRANDPA signers
// from a justification, and decoded calls and events as plain JSON. Pure functions over codecs
// built from the runtime metadata, no network.

import {
  Bool,
  Bytes,
  Compact,
  Enum,
  GenericAccountId,
  GenericCall,
  GenericEvent,
  GenericExtrinsic,
  Int,
  Null,
  Option,
  Raw,
  Result,
  Struct,
  Text,
  UInt,
} from '@polkadot/types';
import type { Call, DigestItem, Event, GrandpaJustification } from '@polkadot/types/interfaces';
import type { Codec, Registry } from '@polkadot/types/types';
import { compactFromU8a, u8aToHex } from '@polkadot/util';
import { encodeAddress, xxhashAsHex } from '@polkadot/util-crypto';

export const SS58_PREFIX = 2426;

/** The slot of the Aura pre-runtime digest item, or null if the header has none. */
export function auraSlot(digestLogs: DigestItem[]): bigint | null {
  for (const log of digestLogs) {
    if (!log.isPreRuntime) continue;
    const [engine, data] = log.asPreRuntime;
    if (!engine.isAura || data.length < 8) continue;
    return new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true);
  }
  return null;
}

/** Storage key of `Aura::Authorities`: `twox128("Aura") ++ twox128("Authorities")`. */
export const AURA_AUTHORITIES_KEY = `${xxhashAsHex('Aura', 128)}${xxhashAsHex('Authorities', 128).slice(2)}`;

/**
 * The keys (hex) of a raw `Aura::Authorities` value: a SCALE vector of 32-byte public keys. Read raw
 * because the type is the same in every runtime, while the metadata-driven decoding mixes up the
 * two runtimes around the block of an upgrade. Throws on a value of the wrong length.
 */
export function auraAuthorityKeys(raw: Uint8Array): string[] {
  const [offset, length] = compactFromU8a(raw);
  const count = length.toNumber();
  if (raw.length !== offset + 32 * count) throw new Error(`auraAuthorityKeys: ${raw.length} bytes for ${count} keys`);
  return Array.from({ length: count }, (_, i) => u8aToHex(raw.subarray(offset + 32 * i, offset + 32 * (i + 1))));
}

/** The Aura author of a slot: the authorities take turns. Throws if there are none. */
export function auraAuthor(slot: bigint, authorities: string[]): string {
  if (authorities.length === 0) throw new Error('auraAuthor: no Aura authorities');
  return authorities[Number(slot % BigInt(authorities.length))];
}

/** The ed25519 keys (hex) that signed the precommits of a GRANDPA justification, each once. */
export function justificationSigners(justification: Uint8Array, registry: Registry): string[] {
  const decoded = registry.createType<GrandpaJustification>('GrandpaJustification', justification);
  const keys = decoded.commit.precommits.map((p) => p.id.toHex());
  return [...new Set(keys)];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Text that would be unsafe to show as is: C0 controls and DEL, and the bidi embeddings, overrides
// and isolates that make a string display in another order than it reads.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function bytesToJson(u8a: Uint8Array): string {
  let text: string;
  try {
    text = UTF8.decode(u8a);
  } catch {
    return u8aToHex(u8a);
  }
  return UNSAFE_TEXT.test(text) ? u8aToHex(u8a) : text;
}

/**
 * A codec as human JSON: addresses in SS58 2426, integers wider than 32 bits (balances) as
 * decimal strings, bytes as text when valid UTF-8 without control or bidi characters and hex
 * otherwise, unit enum variants as their name, other variants as `{ Variant: value }`. A call
 * given directly comes out as `walkCall` renders it; a call nested in the value as
 * `{ pallet, method }` only.
 */
export function toJson(codec: Codec): unknown {
  if (codec instanceof GenericCall) return walkCall(codec as unknown as Call);
  return json(codec, []);
}

// Each nested call is walked once, pushed to `calls` and left as `{ pallet, method }` in the
// arguments: rendering it in full there too would double the work and the output at each level.
function json(codec: Codec, calls: WalkedCall[]): unknown {
  const rec = (c: Codec): unknown => json(c, calls);
  if (codec instanceof GenericAccountId) return encodeAddress(codec.toU8a(), SS58_PREFIX);
  if (codec instanceof GenericCall) {
    const walked = walkCall(codec as unknown as Call);
    calls.push(walked);
    return { pallet: walked.pallet, method: walked.method };
  }
  if (codec instanceof Compact) return rec(codec.unwrap());
  if (codec instanceof UInt || codec instanceof Int) return codec.bitLength() > 32 ? codec.toString() : codec.toNumber();
  if (codec instanceof Bool) return codec.isTrue;
  if (codec instanceof Null) return null;
  if (codec instanceof Text) return codec.toString();
  if (codec instanceof Bytes) return bytesToJson(codec.toU8a(true));
  if (codec instanceof Raw) return codec.toHex();
  if (codec instanceof Option) return codec.isSome ? rec(codec.unwrap()) : null;
  if (codec instanceof Result) return { [codec.type]: rec(codec.inner) };
  if (codec instanceof Enum) {
    // A MultiAddress that holds an account id reads as the address itself.
    if (codec.type === 'Id' && codec.inner instanceof GenericAccountId) return rec(codec.inner);
    return codec.inner instanceof Null ? codec.type : { [codec.type]: rec(codec.inner) };
  }
  if (codec instanceof Struct) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of codec.entries()) out[String(key)] = rec(value);
    return out;
  }
  if (codec instanceof Map) return [...codec.entries()].map(([k, v]) => [rec(k as Codec), rec(v as Codec)]);
  if (Array.isArray(codec) || codec instanceof Set) return [...(codec as Iterable<Codec>)].map(rec);
  return codec.toJSON();
}

export interface WalkedCall {
  pallet: string;
  method: string;
  /** Nested calls appear here as `{ pallet, method }`, in full in `inner`. */
  args: Record<string, unknown>;
  inner: WalkedCall[];
}

/** A call with its named arguments as JSON, and every call nested in its arguments, recursively. */
export function walkCall(call: Call): WalkedCall {
  const args: Record<string, unknown> = {};
  const inner: WalkedCall[] = [];
  // `argsDef` keeps the metadata's names (snake case), `meta.args` has them in camel case.
  Object.keys(call.argsDef).forEach((name, i) => {
    args[name] = json(call.args[i], inner);
  });
  return { pallet: call.section, method: call.meta.name.toString(), args, inner };
}

/** The data of an event by field name (the metadata's names), each as JSON. */
export function eventData(event: Event): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  event.data.forEach((value, i) => {
    const name = event.meta.fields[i]?.name.unwrapOr(null)?.toString() ?? String(i);
    out[name] = json(value, []);
  });
  return out;
}

/** Every address in a call, event or extrinsic (the signer included), SS58 2426, each once. */
export function accountsIn(value: Codec): string[] {
  const found = new Set<string>();
  const visit = (codec: Codec): void => {
    if (codec instanceof GenericAccountId) {
      found.add(encodeAddress(codec.toU8a(), SS58_PREFIX));
      return;
    }
    for (const child of children(codec)) visit(child);
  };
  visit(value);
  return [...found];
}

function children(codec: Codec): Codec[] {
  if (codec instanceof GenericExtrinsic) {
    return codec.isSigned ? [codec.signer, codec.method] : [codec.method];
  }
  if (codec instanceof GenericEvent) return [...codec.data];
  if (codec instanceof GenericCall) return [...codec.args];
  if (codec instanceof Compact) return [];
  if (codec instanceof Option) return codec.isSome ? [codec.unwrap()] : [];
  if (codec instanceof Enum) return [codec.inner];
  if (codec instanceof Struct) return [...codec.values()];
  if (codec instanceof Map) return [...codec.entries()].flat() as Codec[];
  if (Array.isArray(codec) || codec instanceof Set) return [...(codec as Iterable<Codec>)];
  return [];
}
