// The snapshot file `migrator.ts --snapshot` reads instead of a People Chain: the identities of
// one chain, written by hand (or by any script), each as the payload `fulfil_migration` takes.

import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

import {
  DEFAULT_LIMITS,
  sanitisePayload,
  type Dropped,
  type Limits,
  type MigrationPayloadJson,
  type SourceName,
} from './people.ts';

/** The JSON a snapshot file holds. Account keys are addresses in any SS58 format (only the key counts). */
export interface SnapshotJson {
  source: SourceName;
  /** The finalized block the whole file was read at, and its hash. */
  block: number;
  blockHash: string;
  identities: Record<string, MigrationPayloadJson>;
}

/** A snapshot, checked and indexed by account key (the 32-byte public key, whatever the SS58 format). */
export interface Snapshot {
  source: SourceName;
  block: number;
  blockHash: string;
  byAccount: Map<string, MigrationPayloadJson>;
  /** What checking the payloads left out, by account (SS58 as in the file). */
  dropped: Array<{ account: string; dropped: Dropped[] }>;
}

/** The index key of an address in any SS58 format (checksum verified). */
export function accountKey(address: string): string {
  return u8aToHex(decodeAddress(address));
}

/**
 * Check and index the text of a snapshot file. The payloads are sanitised again: a file can be
 * edited by hand, and the runtime refuses a whole `fulfil_migration` on one invalid entry, which
 * would leave the request pending for ever.
 */
export function parseSnapshot(text: string, limits: Limits = DEFAULT_LIMITS): Snapshot {
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null) throw new Error('a snapshot is a JSON object');
  const { source, block, blockHash, identities } = json as Record<string, unknown>;
  if (source !== 'Polkadot' && source !== 'Kusama') throw new Error('snapshot "source" is Polkadot or Kusama');
  if (typeof block !== 'number' || !Number.isInteger(block) || block < 0 || block > 0xffff_ffff) {
    throw new Error('snapshot "block" is a block number (u32)');
  }
  if (typeof blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error('snapshot "blockHash" is a 32-byte hash');
  }
  if (typeof identities !== 'object' || identities === null || Array.isArray(identities)) {
    throw new Error('snapshot "identities" is an object of payloads by address');
  }
  const byAccount = new Map<string, MigrationPayloadJson>();
  const dropped: Snapshot['dropped'] = [];
  for (const [account, candidate] of Object.entries(identities)) {
    const key = accountKey(account);
    if (byAccount.has(key)) throw new Error(`snapshot gives ${account} twice (under two SS58 formats)`);
    const checked = sanitisePayload(candidate, limits, source);
    byAccount.set(key, checked.payload);
    if (checked.dropped.length > 0) dropped.push({ account, dropped: checked.dropped });
  }
  return { source, block, blockHash, byAccount, dropped };
}
