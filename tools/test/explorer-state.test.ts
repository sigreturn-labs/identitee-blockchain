// Tests of the explorer's live state readers (src/explorer/state.ts), on a stub node. No network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { blake2AsHex, cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { avatar, identitySummary, roles, validators } from '../src/explorer/state.ts';

await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519' });
const alice = keyring.addFromUri('//Alice');
const bob = keyring.addFromUri('//Bob');
const AURA_KEY = keyring.addFromUri('//Alice//aura');
const registry = new TypeRegistry();

/** A node at its finalized head: Alice is sudo, `aura` is the Aura set, and `listed` the validator
 * list (null: a runtime without the validators pallet). */
function node(aura: Uint8Array[], listed: Uint8Array[] | null): ApiPromise {
  const at = {
    query: {
      sudo: { key: async () => registry.createType('Option<AccountId32>', u8aToHex(alice.publicKey)) },
      identitee: { agents: async () => registry.createType('Option<(u32, u32)>', null) },
      aura: { authorities: async () => aura.map((k) => registry.createType('[u8; 32]', k)) },
      grandpa: { authorities: async () => [], currentSetId: async () => registry.createType('u64', 0) },
      ...(listed === null ? {} : { validators: { validators: async () => registry.createType('Vec<AccountId32>', listed.map((k) => u8aToHex(k))) } }),
    },
  };
  return { at: async () => at, rpc: { chain: { getFinalizedHead: async () => '0x01' } } } as unknown as ApiPromise;
}

describe('roles', () => {
  it('names a validator by the validator list, whose keys are not the account', async () => {
    const api = node([AURA_KEY.publicKey], [alice.publicKey, bob.publicKey]);
    assert.equal((await roles(api, encodeAddress(bob.publicKey, 2426))).validator, true);
    // any SS58 format
    assert.equal((await roles(api, encodeAddress(alice.publicKey, 42))).validator, true);
    const other = node([AURA_KEY.publicKey], [alice.publicKey]);
    assert.equal((await roles(other, encodeAddress(bob.publicKey, 2426))).validator, false);
  });

  it('falls back to the consensus keys on a runtime without the validator list', async () => {
    const api = node([alice.publicKey], null);
    assert.equal((await roles(api, u8aToHex(alice.publicKey))).validator, true);
    assert.equal((await roles(api, u8aToHex(bob.publicKey))).validator, false);
  });
});

/** A node holding one identity for Alice, with `image` as its avatar (null: none). */
function withIdentity(image: Uint8Array | null): ApiPromise {
  const at = {
    query: {
      identitee: {
        identities: async () => registry.createType('Option<{"avatar":"Option<Bytes>"}>', { avatar: image === null ? null : u8aToHex(image) }),
        nameOf: async () => registry.createType('Option<Text>', 'alice'),
      },
    },
    call: { identiteeApi: { trustLevel: async () => registry.createType('Text', 'Unknown') } },
  };
  return { at: async () => at, rpc: { chain: { getFinalizedHead: async () => '0x01' } } } as unknown as ApiPromise;
}

describe('avatar', () => {
  const IMAGE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7]);

  it('reads the avatar bytes, and gives their short hash with the identity', async () => {
    const api = withIdentity(IMAGE);
    const who = encodeAddress(alice.publicKey, 2426);
    assert.deepEqual(await avatar(api, who), IMAGE);
    assert.equal((await identitySummary(api, who)).avatar, blake2AsHex(IMAGE, 64).slice(2));
  });

  it('is null without an avatar', async () => {
    const api = withIdentity(null);
    const who = encodeAddress(alice.publicKey, 2426);
    assert.equal(await avatar(api, who), null);
    assert.equal((await identitySummary(api, who)).avatar, null);
  });
});

describe('validators', () => {
  it('gives each Aura and GRANDPA key the account owning it, by key type', async () => {
    const aura = keyring.addFromUri('//Bob//aura').publicKey;
    const gran = new Uint8Array(32).fill(7);
    const owners: Record<string, string> = { [`0x61757261:${u8aToHex(aura)}`]: u8aToHex(bob.publicKey), [`0x6772616e:${u8aToHex(gran)}`]: u8aToHex(bob.publicKey) };
    const at = {
      query: {
        aura: { authorities: async () => [registry.createType('[u8; 32]', aura), registry.createType('[u8; 32]', alice.publicKey)] },
        grandpa: {
          authorities: async () => [[registry.createType('[u8; 32]', gran), registry.createType('u64', 1)]],
          currentSetId: async () => registry.createType('u64', 4),
        },
        session: { keyOwner: async ([type, key]: [string, string]) => registry.createType('Option<AccountId32>', owners[`${type}:${key}`] ?? null) },
      },
    };
    const api = { at: async () => at, rpc: { chain: { getFinalizedHead: async () => '0x02' } } } as unknown as ApiPromise;
    const v = await validators(api, { [u8aToHex(alice.publicKey)]: 'identitee-01' });
    const BOB = encodeAddress(bob.publicKey, 2426);
    assert.deepEqual(v.aura, [
      { key: u8aToHex(aura), label: null, account: BOB },
      { key: u8aToHex(alice.publicKey), label: 'identitee-01', account: null },
    ]);
    // the GRANDPA key is asked under its own key type: under aura's it has no owner
    assert.deepEqual(v.grandpa, [{ key: u8aToHex(gran), weight: 1, label: null, account: BOB }]);
    assert.equal(v.setId, 4);
  });
});
