// Tests of the explorer's live state readers (src/explorer/state.ts), on a stub node. No network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { blake2AsHex, cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import { avatar, identitySummary, roles } from '../src/explorer/state.ts';

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
