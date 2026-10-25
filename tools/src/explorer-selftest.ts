// Self-test of the explorer indexer on a throwaway `--dev --tmp` node.
//
//   npm run explorer:selftest
//
// Starts `identitee-node` (IDENTITEE_NODE_BIN, default `identitee-node` on the PATH) on a free port,
// runs the indexer into a temporary database from genesis, and submits with the dev keys a transfer
// (//Alice to //Bob), identity fields (//Charlie), a sudo call (//Alice registers an authority), an
// attestation request (//Charlie to that authority) and a sudo call by //Bob that fails. Once the
// indexer has the block of the last one, it checks the stored blocks (author = Alice's Aura key),
// extrinsics (result, fee, decoded error), account history, the transfer feed, identitee sentences,
// that two blocks decode the same through `api.at(hash)` as in the index, and the live state readers.
// Whatever ends the run, the node is killed and the temporary directory removed (selftest-guard.ts).
// Prints `OK <step>` / `FAIL <step>: <why>`, then `explorer self-test: ok` if every step passed.

import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { Call } from '@polkadot/types/interfaces';
import { stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';

import { SS58_PREFIX, walkCall } from './explorer/decode.ts';
import { Indexer } from './explorer/indexer.ts';
import { authorities, health, identitySummary, roles, validators } from './explorer/state.ts';
import { ExplorerStore } from './explorer/store.ts';
import type { Logger } from './migrator.ts';
import { cleanupAll, guardChild, guardDir, installGuard } from './selftest-guard.ts';

const NODE = process.env.IDENTITEE_NODE_BIN || 'identitee-node';
const UNIT = 10n ** 12n;

type Json = any;

const results = { ok: 0, failed: 0 };

async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`OK ${name}`);
    results.ok++;
    return true;
  } catch (e) {
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    results.failed++;
    return false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

class Child {
  readonly lines: string[] = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  readonly proc: ChildProcess;

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    guardChild(this.proc);
    this.proc.once('error', (e) => {
      this.lines.push(`spawn failed: ${e.message}`);
      this.exit = { code: null, signal: null };
    });
    for (const stream of [this.proc.stdout, this.proc.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (line) => this.lines.push(line));
    }
    this.proc.once('exit', (code, signal) => {
      this.exit = { code, signal };
    });
  }

  async stop(graceMs = 10_000): Promise<void> {
    if (this.exit) return;
    this.proc.kill('SIGTERM');
    try {
      await until('the process to exit', graceMs, () => this.exit);
    } catch {
      this.proc.kill('SIGKILL');
      await until('the process to exit after SIGKILL', 5_000, () => this.exit);
    }
  }
}

interface Included {
  block: number;
  hash: string;
  index: number;
  events: string[];
  error: string | null;
}

/** Sign and send `tx`; resolves once it is in a block, with its position and its dispatch error if any. */
async function send(api: ApiPromise, signer: KeyringPair, tx: Json): Promise<Included> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    let done = false;
    const timer = setTimeout(() => reject(new Error('not in a block after 90 s')), 90_000);
    tx.signAndSend(signer, (result: Json) => {
      if (done) return;
      if (result.isError) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`extrinsic ${result.status.type}`));
        return;
      }
      if (!result.status.isInBlock) return;
      done = true;
      clearTimeout(timer);
      unsub?.();
      const hash: string = result.status.asInBlock.toHex();
      const d = result.dispatchError;
      const meta = d?.isModule ? api.registry.findMetaError(d.asModule) : undefined;
      api.rpc.chain.getHeader(hash).then(
        (header) =>
          resolve({
            block: header.number.toNumber(),
            hash,
            index: result.txIndex,
            events: result.events.map(({ event }: Json) => `${event.section}.${event.method}`),
            error: d ? (meta ? `${meta.section}.${meta.name}` : d.toString()) : null,
          }),
        reject,
      );
    })
      .then((u: () => void) => (unsub = u))
      .catch(reject);
  });
}

const current: { node?: Child; logs: string[]; reported: boolean } = { logs: [], reported: false };

function report(why?: string): void {
  if (current.reported) return;
  current.reported = true;
  if (why !== undefined) {
    console.log(`FAIL ${why}`);
    results.failed++;
  }
  if (results.failed === 0) {
    console.log(`PASS ${results.ok} steps`);
    console.log('explorer self-test: ok');
    return;
  }
  console.log(`FAILED ${results.failed} step(s), ${results.ok} passed`);
  console.log('--- indexer, last lines');
  console.log(current.logs.slice(-10).join('\n'));
  if (current.node) {
    console.log('--- node, last lines');
    console.log(current.node.lines.slice(-8).join('\n'));
  }
}

async function selftest(): Promise<number> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX });
  const alice = keyring.addFromUri('//Alice');
  const bob = keyring.addFromUri('//Bob');
  const charlie = keyring.addFromUri('//Charlie');
  const aliceAura = u8aToHex(alice.publicKey);
  const aliceGrandpa = u8aToHex(new Keyring({ type: 'ed25519' }).addFromUri('//Alice').publicKey);

  const dir = mkdtempSync(join(tmpdir(), 'identitee-explorer-selftest-'));
  guardDir(dir);
  let node: Child | undefined;
  let api: ApiPromise | undefined;
  let indexer: Indexer | undefined;
  let store: ExplorerStore | undefined;
  const log: Logger = (level, event, fields = {}) => current.logs.push(JSON.stringify({ level, event, ...fields }));

  try {
    const port = await freePort();
    const chainNode = (node = current.node = new Child(NODE, ['--dev', '--tmp', '--no-prometheus', '--no-telemetry', '--rpc-port', String(port)]));
    const connected = await step(`start a dev node (${NODE}) and connect`, async () => {
      await until('the node RPC port', 60_000, async () => {
        if (chainNode.exit) throw new Error(`the node exited: ${chainNode.lines.slice(-5).join(' | ')}`);
        return (await accepts(port)) ? true : undefined;
      });
      api = await ApiPromise.create({ provider: new WsProvider(`ws://127.0.0.1:${port}`), noInitWarn: true });
      same(api.runtimeVersion.specName.toString(), 'identitee', 'spec name');
    });
    if (!connected || !api) return 1;
    const rpc: ApiPromise = api;
    const tx = rpc.tx as Json;

    const db = (store = new ExplorerStore(join(dir, 'explorer.db')));
    const ix = (indexer = new Indexer(rpc, db, log, { retryMs: 200 }));
    const heads: Array<{ best: number; finalized: number }> = [];
    ix.onHead((h) => heads.push(h));
    await step('the indexer starts from genesis and catches up', async () => {
      await ix.start();
      assert(db.lastIndexed() !== null, 'nothing indexed');
      same(db.block(0)?.hash, rpc.genesisHash.toHex(), 'block 0 hash');
    });

    const sent: Record<string, Included> = {};
    let authority = 0;
    const submitted = await step('submit a transfer, identity fields, a sudo call, an attestation request and a failing sudo call', async () => {
      sent.transfer = await send(rpc, alice, tx.balances.transferKeepAlive(bob.address, UNIT));
      same(sent.transfer.error, null, 'transfer error');
      sent.display = await send(rpc, charlie, tx.identitee.setField({ Typed: 'DisplayName' }, { Public: stringToHex('charlie') }));
      sent.email = await send(rpc, charlie, tx.identitee.setField({ Typed: 'Email' }, { Public: stringToHex('charlie@example.com') }));
      same([sent.display.error, sent.email.error], [null, null], 'setField errors');
      authority = Number((await (rpc.query as Json).identitee.nextAuthorityId()).toString());
      sent.sudo = await send(rpc, alice, tx.sudo.sudo(tx.identitee.addAuthority(stringToHex('selftest'))));
      assert(sent.sudo.events.includes('identitee.AuthorityRegistered'), `no AuthorityRegistered: ${sent.sudo.events}`);
      sent.request = await send(rpc, charlie, tx.identitee.requestJudgement(authority, { Field: { Typed: 'Email' } }));
      same(sent.request.error, null, 'request error');
      sent.failed = await send(rpc, bob, tx.sudo.sudo(tx.system.remark('0xff')));
      same(sent.failed.error, 'sudo.RequireSudo', 'the failing call');
    });
    if (!submitted) return 1;

    const last = Math.max(...Object.values(sent).map((s) => s.block));
    await step(`the indexer follows finality up to block ${last}`, async () => {
      await until(`block ${last} in the index`, 120_000, () => ((db.lastIndexed() ?? -1) >= last ? true : undefined));
      const h = heads.at(-1);
      assert(h !== undefined && h.finalized >= last && h.best >= h.finalized, `heads ${JSON.stringify(h)}`);
    });

    const xt = (s: Included) => {
      const row = db.extrinsic(`${s.block}-${s.index}`);
      assert(row !== null, `no extrinsic ${s.block}-${s.index}`);
      return row;
    };

    await step('blocks: every block in order, produced by Alice (Aura), GRANDPA set 0, signers if any are Alice', async () => {
      const lastIndexed = db.lastIndexed()!;
      same(db.counts().blocks, lastIndexed + 1, 'block count');
      for (let n = 0; n <= lastIndexed; n++) {
        const b = db.block(n);
        assert(b !== null, `block ${n} missing`);
        same(b.hash, (await rpc.rpc.chain.getBlockHash(n)).toHex(), `hash of block ${n}`);
        if (n > 0) {
          same(b.author, aliceAura, `author of block ${n}`);
          assert(b.timestamp !== null && b.timestamp > 0, `timestamp of block ${n}`);
        }
        same(b.authoritySetId, 0, `set id of block ${n}`);
        assert(b.justificationSigners === null || b.justificationSigners.every((k) => k === aliceGrandpa), `signers of block ${n}`);
        same(b.specVersion, rpc.runtimeVersion.specVersion.toNumber(), `spec of block ${n}`);
      }
      same(db.runtimes(), [{ specVersion: rpc.runtimeVersion.specVersion.toNumber(), fromBlock: 0, specName: 'identitee' }], 'runtime versions');
    });

    await step('the transfer: success, fee paid, transfer row, in the history of Alice and Bob', async () => {
      const row = xt(sent.transfer);
      same([row.pallet, row.method, row.success, row.error, row.signer], ['balances', 'transfer_keep_alive', true, null, alice.address], 'transfer extrinsic');
      same((row.args as Json).dest, bob.address, 'dest');
      same((row.args as Json).value, UNIT.toString(), 'value');
      assert(row.fee !== null && BigInt(row.fee) > 0n, `fee ${row.fee}`);
      same(row.tip, '0', 'tip');
      const transfers = db.transfers(alice.address, null, 10).items;
      const t = transfers.find((r) => r.extrinsicId === row.id);
      assert(t !== undefined, 'no transfer row');
      same([t.from, t.to, t.amount], [alice.address, bob.address, UNIT.toString()], 'transfer row');
      same(t.sentence, `1 IDT sent from ${alice.address.slice(0, 6)}…${alice.address.slice(-6)} to ${bob.address.slice(0, 6)}…${bob.address.slice(-6)}`, 'transfer sentence');
      const history = db.accountHistory(alice.address, null, 100).items;
      assert(history.some((h) => h.kind === 'extrinsic' && h.item.id === row.id), 'transfer not in the history of Alice');
      assert(db.accountHistory(bob.address, null, 100).items.some((h) => h.item.id === row.id), 'transfer not in the history of Bob');
    });

    await step('the failed sudo call by Bob: success false, decoded RequireSudo error with its doc, fee paid', async () => {
      const row = xt(sent.failed);
      same([row.pallet, row.method, row.success, row.signer], ['sudo', 'sudo', false, bob.address], 'failed extrinsic');
      same([row.error?.pallet, row.error?.name], ['sudo', 'RequireSudo'], 'error');
      assert((row.error?.docs ?? '').length > 0, 'no error doc');
      same((row.args as Json).call, { pallet: 'system', method: 'remark', args: { remark: '0xff' } }, 'nested call');
      assert(row.fee !== null && BigInt(row.fee) > 0n, `fee ${row.fee}`);
    });

    await step('identitee: field set sentences, feeless fee 0, authority registered, attestation request in the feed', async () => {
      const display = xt(sent.display);
      same([display.pallet, display.method, display.success, display.fee], ['identitee', 'set_field', true, '0'], 'set_field extrinsic');
      const events = db.eventsOfBlock(sent.email.block).filter((e) => e.extrinsicIndex === sent.email.index);
      const fieldSet = events.find((e) => e.pallet === 'identitee' && e.method === 'FieldSet');
      same(fieldSet?.sentence, `Email set by ${charlie.address.slice(0, 6)}…${charlie.address.slice(-6)}`, 'FieldSet sentence');
      const registered = db.eventsOfBlock(sent.sudo.block).find((e) => e.method === 'AuthorityRegistered');
      same(registered?.sentence, `Authority "selftest" registered as #${authority}`, 'AuthorityRegistered sentence');
      const sudid = db.eventsOfBlock(sent.sudo.block).find((e) => e.method === 'Sudid');
      same(sudid?.sentence, 'Sudo call succeeded', 'Sudid sentence');
      const sudo = xt(sent.sudo);
      same((sudo.args as Json).call, { pallet: 'identitee', method: 'add_authority', args: { name: 'selftest' } }, 'sudo nested call');
      const feed = db.attestations(null, 10).items;
      const req = feed.find((a) => a.block === sent.request.block);
      assert(req !== undefined, 'no attestation row');
      same([req.who, req.authorityId, req.kind, req.target], [charlie.address, authority, 'requested', { Field: { Typed: 'Email' } }], 'attestation row');
      same(req.sentence, `${charlie.address.slice(0, 6)}…${charlie.address.slice(-6)} asked selftest to check the email`, 'request sentence');
      assert(db.accountHistory(charlie.address, null, 100).items.length >= 6, 'history of Charlie');
    });

    await step('two blocks decode through api.at(hash) as they are in the index', async () => {
      for (const s of [sent.transfer, sent.failed]) {
        const at = await rpc.at(s.hash);
        const block = await rpc.rpc.chain.getBlock(s.hash);
        const again = at.registry.createType('Extrinsic', block.block.extrinsics[s.index]!.toU8a());
        const walked = walkCall(again.method as unknown as Call);
        const row = xt(s);
        same([walked.pallet, walked.method, again.hash.toHex()], [row.pallet, row.method, row.hash], `extrinsic ${row.id}`);
        same(at.runtimeVersion.specVersion.toNumber(), db.block(s.block)?.specVersion, `spec of block ${s.block}`);
        const events = (await (at.query as Json).system.events()) as Json[];
        same(events.length, db.block(s.block)?.eventCount, `events of block ${s.block}`);
      }
    });

    await step('live state: authorities, identity summary, roles, validators, health', async () => {
      const list = await authorities(rpc);
      const mine = list.find((a) => a.id === authority);
      same([mine?.name, mine?.active], ['selftest', true], 'the new authority');
      const summary = await identitySummary(rpc, charlie.address);
      same([summary.display, summary.username], ['charlie', null], 'identity of Charlie');
      assert(typeof summary.trust === 'string', `trust ${summary.trust}`);
      same(await identitySummary(rpc, bob.address), { display: null, username: null, trust: null }, 'identity of Bob');
      const r = await roles(rpc, alice.address);
      same([r.sudo, r.validator], [true, true], 'roles of Alice');
      const rb = await roles(rpc, bob.address);
      // the dev genesis makes Bob the migration agent of authority 0
      same([rb.sudo, rb.validator, rb.agent], [false, false, [{ authority: 0, name: list[0]?.name, capabilities: 8, capabilityNames: ['migrate'] }]], 'roles of Bob');
      assert(list[0]?.agents.some((a) => a.address === bob.address), 'Bob not among the agents of authority 0');
      const v = await validators(rpc, { [aliceAura]: 'identitee-01' });
      same(v.aura, [{ key: aliceAura, label: 'identitee-01' }], 'aura validators');
      same(v.grandpa.map((g) => g.key), [aliceGrandpa], 'grandpa validators');
      same(v.setId, 0, 'set id');
      const h = await health(rpc);
      same([typeof h.peers, typeof h.isSyncing], ['number', 'boolean'], 'health');
    });

    await step('the dev node metadata matches test/fixtures/explorer-metadata.hex', async () => {
      const live = (await rpc.rpc.state.getMetadata()).toHex();
      const fixture = readFileSync(new URL('../test/fixtures/explorer-metadata.hex', import.meta.url), 'utf8').trim();
      same(blake2AsHex(live), blake2AsHex(fixture), 'metadata hash');
    });

    await step('the indexer stops', async () => {
      await ix.stop();
      const n = db.lastIndexed();
      await new Promise((resolve) => setTimeout(resolve, 7000));
      same(db.lastIndexed(), n, 'blocks indexed after stop');
    });
  } catch (e) {
    console.log(`FAIL fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    results.failed++;
  } finally {
    await indexer?.stop().catch(() => undefined);
    store?.close();
    await (api as ApiPromise | undefined)?.disconnect().catch(() => undefined);
    await node?.stop().catch(() => undefined);
    if (node) console.log(`node pid ${node.proc.pid} exited: ${JSON.stringify(node.exit)}`);
    cleanupAll();
    report();
  }
  return results.failed === 0 ? 0 : 1;
}

installGuard((why) => report(why));
selftest().then(
  (code) => process.exit(code),
  (e: unknown) => {
    report(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    cleanupAll();
    process.exit(1);
  },
);
