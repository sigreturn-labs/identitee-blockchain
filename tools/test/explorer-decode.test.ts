// Tests of the explorer's decoding helpers (src/explorer/decode.ts, src/explorer/sentences.ts),
// against the runtime metadata recorded in test/fixtures/explorer-metadata.hex. No network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Keyring } from '@polkadot/keyring';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { Call, DigestItem, Event } from '@polkadot/types/interfaces';
import { u8aConcat, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import {
  accountsIn,
  auraAuthor,
  auraSlot,
  eventData,
  justificationSigners,
  toJson,
  walkCall,
} from '../src/explorer/decode.ts';
import { sentence } from '../src/explorer/sentences.ts';

const registry = new TypeRegistry();
const metadata = new Metadata(
  registry,
  readFileSync(new URL('./fixtures/explorer-metadata.hex', import.meta.url), 'utf8').trim() as `0x${string}`,
);
registry.setMetadata(metadata);

await cryptoWaitReady();
const sr = new Keyring({ type: 'sr25519', ss58Format: 2426 });
const ed = new Keyring({ type: 'ed25519', ss58Format: 2426 });
const alice = sr.addFromUri('//Alice');
const bob = sr.addFromUri('//Bob');
const ALICE = encodeAddress(alice.publicKey, 2426);
const BOB = encodeAddress(bob.publicKey, 2426);

const palletIndex = (name: string): number =>
  metadata.asLatest.pallets.find((p) => p.name.toString() === name)!.index.toNumber();

const variants = (pallet: string, kind: 'events' | 'calls') => {
  const p = metadata.asLatest.pallets.find((x) => x.name.toString() === pallet)!;
  return registry.lookup.getSiType(p[kind].unwrap().type).def.asVariant.variants;
};

const callIndex = (pallet: string, name: string): [number, number] => {
  const v = variants(pallet, 'calls').find((x) => x.name.toString() === name)!;
  return [palletIndex(pallet), v.index.toNumber()];
};

const call = (pallet: string, name: string, args: Record<string, unknown>): Call =>
  registry.createType('Call', { callIndex: callIndex(pallet, name), args });

// Event objects do not take field values in this registry: encode the index and the fields.
const transferEvent = (from: Uint8Array, to: Uint8Array, amount: bigint): Event =>
  registry.createType(
    'Event',
    u8aConcat(
      new Uint8Array([palletIndex('Balances'), 2]),
      registry.createType('AccountId', from).toU8a(),
      registry.createType('AccountId', to).toU8a(),
      registry.createType('u128', amount).toU8a(),
    ),
  ) as Event;

const ctx = { authorityName: (id: number) => (id === 0 ? 'identitee' : null) };

describe('aura', () => {
  it('reads the slot of an Aura pre-runtime digest', () => {
    // PreRuntime, engine "aura", 8 bytes: slot 293_847_123 little endian.
    const slot = 293_847_123n;
    const le = new Uint8Array(8);
    new DataView(le.buffer).setBigUint64(0, slot, true);
    const pre = registry.createType('DigestItem', `0x066175726120${u8aToHex(le).slice(2)}`);
    const seal = registry.createType('DigestItem', { Seal: ['aura', `0x${'11'.repeat(64)}`] });
    const other = registry.createType('DigestItem', { PreRuntime: ['BABE', '0x00'] });
    assert.equal(auraSlot([seal, other, pre] as DigestItem[]), slot);
    assert.equal(auraSlot([seal] as DigestItem[]), null);
  });

  it('takes the author at slot modulo the number of authorities', () => {
    assert.equal(auraAuthor(7n, ['a']), 'a');
    assert.equal(auraAuthor(7n, ['a', 'b', 'c']), 'b');
    assert.equal(auraAuthor(9n, ['a', 'b', 'c']), 'a');
  });

  it('refuses an empty authority set', () => {
    assert.throws(() => auraAuthor(7n, []), /no Aura authorities/);
  });
});

describe('justificationSigners', () => {
  it('returns the ed25519 keys of the precommits, deduplicated, in order', () => {
    const a = ed.addFromUri('//Alice');
    const b = ed.addFromUri('//Bob');
    const target = { targetHash: `0x${'22'.repeat(32)}`, targetNumber: 512 };
    const precommit = (pair: typeof a) => ({ precommit: target, signature: pair.sign(new Uint8Array([1])), id: pair.publicKey });
    const justification = registry.createType('GrandpaJustification', {
      round: 4,
      commit: { ...target, precommits: [precommit(b), precommit(a), precommit(b)] },
      votesAncestries: [],
    });
    assert.deepEqual(justificationSigners(justification.toU8a(), registry), [u8aToHex(b.publicKey), u8aToHex(a.publicKey)]);
  });
});

describe('toJson', () => {
  it('renders addresses in SS58 2426, balances as decimal strings and bytes as text or hex', () => {
    const transfer = call('Balances', 'transfer_keep_alive', { dest: { Id: bob.publicKey }, value: 1_500_000_000_000n });
    assert.deepEqual(toJson(transfer.args[0]), BOB);
    assert.equal(toJson(transfer.args[1]), '1500000000000');
    assert.equal(toJson(registry.createType('Bytes', '0x616c696365')), 'alice');
    assert.equal(toJson(registry.createType('Bytes', '0xff00')), '0xff00');
    assert.equal(toJson(registry.createType('u32', 7)), 7);
    assert.equal(toJson(registry.createType('bool', true)), true);
  });
});

describe('walkCall', () => {
  it('walks sudo into the call it wraps', () => {
    const inner = call('Identitee', 'set_username_for', { who: bob.publicKey, name: 'bob' });
    const walked = walkCall(call('Sudo', 'sudo', { call: inner }));
    assert.equal(walked.pallet, 'sudo');
    assert.equal(walked.method, 'sudo');
    assert.equal(walked.inner.length, 1);
    assert.equal(walked.inner[0].pallet, 'identitee');
    assert.equal(walked.inner[0].method, 'set_username_for');
    assert.deepEqual(walked.inner[0].args, { who: BOB, name: 'bob' });
    assert.deepEqual(walked.inner[0].inner, []);
    assert.deepEqual(walked.args, { call: { pallet: 'identitee', method: 'set_username_for' } });
  });

  it('walks deeply nested sudo calls in linear time and size', () => {
    let nested = call('Identitee', 'claim_username', { name: 'alice' });
    for (let i = 0; i < 25; i++) nested = call('Sudo', 'sudo', { call: nested });
    const started = performance.now();
    let walked = walkCall(nested);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `walkCall took ${elapsed.toFixed(0)} ms`);
    assert.ok(JSON.stringify(walked).length < 5_000);
    for (let i = 0; i < 25; i++) {
      assert.equal(walked.method, 'sudo');
      assert.equal(walked.inner.length, 1);
      walked = walked.inner[0];
    }
    assert.deepEqual(walked, { pallet: 'identitee', method: 'claim_username', args: { name: 'alice' }, inner: [] });
  });

  it('keeps snake case argument names and decodes enums', () => {
    const walked = walkCall(
      call('Identitee', 'provide_judgement', {
        who: alice.publicKey,
        key: { Typed: 'Email' },
        expected_commitment: `0x${'00'.repeat(32)}`,
        verdict: 'Verified',
        method: 'EmailCode',
        expires_at: null,
      }),
    );
    assert.deepEqual(walked.args, {
      who: ALICE,
      key: { Typed: 'Email' },
      expected_commitment: `0x${'00'.repeat(32)}`,
      verdict: 'Verified',
      method: 'EmailCode',
      expires_at: null,
    });
  });
});

describe('accountsIn', () => {
  it('finds the who argument and an address nested in a call and an enum', () => {
    const inner = call('Balances', 'transfer_keep_alive', { dest: { Id: bob.publicKey }, value: 1 });
    const outer = call('Sudo', 'sudo_as', { who: { Id: alice.publicKey }, call: inner });
    assert.deepEqual(accountsIn(outer).sort(), [ALICE, BOB].sort());
  });

  it('finds an address nested in a struct', () => {
    const value = registry.createType('{"owner":"AccountId","n":"u32","label":"Bytes"}', { owner: bob.publicKey, n: 1, label: 'bob' });
    assert.deepEqual(accountsIn(value), [BOB]);
  });

  it('finds the signer and the destination of a signed extrinsic', () => {
    const transfer = call('Balances', 'transfer_keep_alive', { dest: { Id: bob.publicKey }, value: 1 });
    const xt = registry.createType('Extrinsic', transfer);
    xt.signFake(alice.address, {
      blockHash: `0x${'33'.repeat(32)}`,
      genesisHash: `0x${'33'.repeat(32)}`,
      nonce: 0,
      runtimeVersion: { specVersion: 8, transactionVersion: 1 } as never,
    });
    assert.ok(xt.isSigned);
    assert.deepEqual(accountsIn(xt).sort(), [ALICE, BOB].sort());
  });

  it('finds every address of an event once', () => {
    assert.deepEqual(accountsIn(transferEvent(alice.publicKey, alice.publicKey, 5n)), [ALICE]);
  });
});

describe('sentence', () => {
  const zeroEvent = (pallet: string, index: number): Event =>
    registry.createType('Event', new Uint8Array([palletIndex(pallet), index, ...new Uint8Array(512)])) as Event;

  it('has a sentence for every identitee event of the runtime', () => {
    const names = variants('Identitee', 'events');
    assert.ok(names.length >= 40);
    for (const v of names) {
      const ev = zeroEvent('Identitee', v.index.toNumber());
      const text = sentence(ev.section, ev.method, eventData(ev), ctx);
      assert.equal(typeof text, 'string', `no sentence for ${v.name.toString()}`);
      assert.ok(text!.length > 0);
      assert.ok(!text!.includes('·') && !text!.includes('—'), text!);
      assert.ok(!text!.includes('undefined') && !text!.includes('[object'), text!);
    }
  });

  it('writes FieldAttested as the field, the account and the authority', () => {
    const data = { who: ALICE, key: { Typed: 'Email' }, authority: 0, verdict: 'Verified', agent: BOB };
    assert.equal(sentence('identitee', 'FieldAttested', data, ctx), `Email attested for ${ALICE.slice(0, 6)}…${ALICE.slice(-6)} by identitee`);
    assert.equal(
      sentence('identitee', 'FieldAttested', { ...data, authority: 4, verdict: 'Rejected' }, ctx),
      `Email rejected for ${ALICE.slice(0, 6)}…${ALICE.slice(-6)} by authority #4`,
    );
  });

  it('writes facts, transfers, new accounts and sudo results', () => {
    const a = `${ALICE.slice(0, 6)}…${ALICE.slice(-6)}`;
    const b = `${BOB.slice(0, 6)}…${BOB.slice(-6)}`;
    assert.equal(
      sentence('identitee', 'FactGranted', { who: ALICE, kind: 'DocumentChecked', authority: 0, agent: BOB }, ctx),
      `Document check recorded for ${a} by identitee`,
    );
    assert.equal(
      sentence('identitee', 'FactRevoked', { who: ALICE, kind: 'Fraud', authority: 0, reason: 'Abuse', agent: BOB }, ctx),
      `Fraud fact for ${a} revoked by identitee, reason: abuse`,
    );
    assert.equal(sentence('balances', 'Transfer', { from: ALICE, to: BOB, amount: '1500000000000' }, ctx), `1.5 IDT sent from ${a} to ${b}`);
    assert.equal(sentence('system', 'NewAccount', { account: ALICE }, ctx), `Account ${a} created`);
    assert.equal(sentence('sudo', 'Sudid', { sudo_result: { Ok: null } }, ctx), 'Sudo call succeeded');
    assert.equal(sentence('sudo', 'Sudid', { sudo_result: { Err: { BadOrigin: null } } }, ctx), 'Sudo call failed');
  });

  it('reads the data of a decoded event', () => {
    assert.deepEqual(eventData(transferEvent(alice.publicKey, bob.publicKey, 2_000_000_000_000n)), { from: ALICE, to: BOB, amount: '2000000000000' });
  });

  it('returns null for the other events and for malformed data', () => {
    assert.equal(sentence('system', 'ExtrinsicSuccess', {}, ctx), null);
    assert.equal(sentence('identitee', 'NoSuchEvent', {}, ctx), null);
    assert.equal(sentence('identitee', 'FieldAttested', {}, ctx), null);
  });
});
