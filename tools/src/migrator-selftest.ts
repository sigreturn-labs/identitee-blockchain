// Self-test of the migrator on a throwaway `--dev --tmp` node, with a snapshot file as the source.
//
//   npm run migrator:selftest
//
// Starts `identitee-node` (IDENTITEE_NODE_BIN, default ../target/release/identitee-node) on a free
// port, then the real `src/migrator.ts` as //Bob (the agent that holds MIGRATE in the dev preset),
// and drives it as never-funded accounts:
//   Ferdie  requests BEFORE the migrator starts     -> served by the start-up sweep (Reasonable)
//   Dave    requests while it runs                  -> served from its finalized event (KnownGood)
//   Charlie has invalid entries in the snapshot     -> sanitised, the rest imported
//   Eve     is absent from the snapshot             -> reject_migration
//   One     has a REAL People Chain payload         -> all nine fields, a 20-byte PGP, KnownGood: Certified
//   Two     asks, then creates an identity          -> reject_migration(Other), not retried for ever
//   Alice   asks for Kusama, which has no snapshot  -> left pending, no transaction
// then sends SIGTERM and checks that it stops cleanly. With `--live` it also starts the migrator
// WITHOUT a snapshot, so that it reads the real People Chains (network needed): Eve, who has no
// identity there, and Alice's pending Kusama request are rejected after a real finalized read,
// then once more with PEOPLE_AT_BLOCK_POLKADOT pinned to a block. Prints `OK <step>` / `FAIL <step>: <why>`;
// exit code 0 only if every step passed. Without `--live` it needs no network at all (it passes in an
// empty network namespace) and no key but the public dev ones. Whatever ends the run (a failure,
// Ctrl-C, `timeout`, a dropped ssh), the node and the migrators are killed and the temporary directory
// removed (selftest-guard.ts).

import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { hexToString, stringToHex } from '@polkadot/util';
import { cryptoWaitReady, decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { connectPeople, mapIdentity, type MigrationPayloadJson } from './people.ts';
import { cleanupAll, guardChild, guardDir, installGuard } from './selftest-guard.ts';
import type { SnapshotJson } from './snapshot-file.ts';

const NODE = process.env.IDENTITEE_NODE_BIN ?? new URL('../../target/release/identitee-node', import.meta.url).pathname;
const SS58_PREFIX = 2426;
/** A real Polkadot People Chain finalized block: what the snapshot claims to have been read at. */
const SOURCE_BLOCK = 11_294_320;
const SOURCE_HASH = '0x40a22df1a505c1f7256680f67ff83bfb9b45620a487d66ff433a5038c1fc2c21';

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

const json = (value: { toJSON(): unknown }): Json => JSON.parse(JSON.stringify(value.toJSON()));

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Whether something listens on the local `port`. */
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
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A child process with its output lines kept (and parsed, for the migrator's JSON logs). */
class Child {
  /** Every output line, stdout and stderr; `outLines` is stdout alone. */
  readonly lines: string[] = [];
  readonly outLines: string[] = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  readonly proc: ChildProcess;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.proc = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    guardChild(this.proc);
    if (this.proc.stdout) {
      createInterface({ input: this.proc.stdout }).on('line', (line) => {
        this.lines.push(line);
        this.outLines.push(line);
      });
    }
    if (this.proc.stderr) createInterface({ input: this.proc.stderr }).on('line', (line) => this.lines.push(line));
    this.proc.once('exit', (code, signal) => {
      this.exit = { code, signal };
    });
  }

  /** The JSON log lines whose `event` is `event`. */
  logs(event: string): Json[] {
    const out: Json[] = [];
    for (const line of this.lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event === event) out.push(entry);
      } catch {
        // not a log line
      }
    }
    return out;
  }

  /** Send `signal`, and SIGKILL if the process has not exited after `graceMs`. */
  async stop(signal: NodeJS.Signals = 'SIGTERM', graceMs = 20_000): Promise<void> {
    if (this.exit) return;
    this.proc.kill(signal);
    try {
      await until('the process to exit', graceMs, () => this.exit);
    } catch {
      this.proc.kill('SIGKILL');
      await until('the process to exit after SIGKILL', 5_000, () => this.exit);
    }
  }
}

/** Sign, send, and wait for the block; an extrinsic that fails is an error. */
async function send(api: ApiPromise, signer: KeyringPair, tx: Json): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => reject(new Error('not in a block after 90 s')), 90_000);
    tx.signAndSend(signer, (result: Json) => {
      if (result.isError) reject(new Error(`extrinsic ${result.status.type}`));
      if (!result.status.isInBlock) return;
      clearTimeout(timer);
      unsub?.();
      const events: string[] = result.events.map(({ event }: Json) => `${event.section}.${event.method}`);
      if (result.dispatchError) {
        const d = result.dispatchError;
        const meta = d.isModule ? api.registry.findMetaError(d.asModule) : undefined;
        reject(new Error(`dispatch error ${meta ? `${meta.section}.${meta.name}` : d.toString()}`));
      } else {
        resolve(events);
      }
    })
      .then((u: () => void) => (unsub = u))
      .catch(reject);
  });
}

const text = (s: string): string => stringToHex(s);

async function main(): Promise<number> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX });
  const [dave, eve, ferdie, charlie, alice, one, two] = ['//Dave', '//Eve', '//Ferdie', '//Charlie', '//Alice', '//One', '//Two'].map((uri) =>
    keyring.addFromUri(uri),
  ) as [KeyringPair, KeyringPair, KeyringPair, KeyringPair, KeyringPair, KeyringPair, KeyringPair];
  const names: Record<string, string> = {
    [dave.address]: 'Dave',
    [eve.address]: 'Eve',
    [ferdie.address]: 'Ferdie',
    [charlie.address]: 'Charlie',
    [alice.address]: 'Alice',
    [one.address]: 'One',
    [two.address]: 'Two',
  };
  /** `--live` adds the steps that read the real People Chains (network needed). */
  const withNetwork = process.argv.includes('--live');

  // A People Chain identity (test/fixtures/people-polkadot.json), mapped by the real code.
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/people-polkadot.json', import.meta.url), 'utf8'));
  const real = mapIdentity(fixture.accounts.all_fields_with_pgp.identityOf, { source: 'Polkadot' });
  assert(real !== null && real.payload.typed.length === 9, 'the fixture maps to nine fields');

  // The snapshot file, written by hand: its keys are in the Polkadot SS58 format (0), as an address copied from the People Chain.
  const polkadotForm = (p: KeyringPair): string => encodeAddress(decodeAddress(p.address), 0);
  const identities: Record<string, MigrationPayloadJson> = {
    [polkadotForm(dave)]: {
      typed: [
        ['DisplayName', text('Dave')],
        ['Email', text('dave@example.org')],
      ],
      custom: [],
      judgements: [
        [0, 'Reasonable'],
        [5, 'KnownGood'],
      ],
    },
    [polkadotForm(ferdie)]: {
      typed: [['Email', text('ferdie@example.org')]],
      custom: [],
      judgements: [[5, 'Reasonable']],
    },
    [polkadotForm(charlie)]: {
      // Invalid on purpose: the runtime would refuse the whole call on any of the first three.
      typed: [
        ['DisplayName', '0x4120ff42'],
        ['Web', `0x${'61'.repeat(300)}`],
        ['Pgp', `0x${'ab'.repeat(19)}`],
        ['Email', text('charlie@example.org')],
      ],
      custom: [],
      judgements: [[5, 'Reasonable']],
    },
  };
  identities[polkadotForm(one)] = real.payload;
  const snapshot: SnapshotJson = { source: 'Polkadot', block: SOURCE_BLOCK, blockHash: SOURCE_HASH, identities };

  const dir = mkdtempSync(join(tmpdir(), 'identitee-selftest-'));
  guardDir(dir);
  const snapshotFile = join(dir, 'polkadot.json');
  writeFileSync(snapshotFile, JSON.stringify(snapshot));

  const port = await freePort();
  const ws = `ws://127.0.0.1:${port}`;
  const node = new Child(NODE, ['--dev', '--tmp', '--no-prometheus', '--no-telemetry', '--rpc-port', String(port)]);
  let migrator: Child | undefined;
  // The guard kills the node and the migrators on a signal or an unhandled rejection, after this report.
  let reported = false;
  const report = (why?: string): void => {
    if (reported) return;
    reported = true;
    if (why !== undefined) {
      console.log(`FAIL ${why}`);
      results.failed++;
    }
    console.log(results.failed === 0 ? `PASS ${results.ok} steps` : `FAILED ${results.failed} step(s), ${results.ok} passed`);
    if (results.failed > 0) {
      console.log('--- node, last lines');
      console.log(node.lines.slice(-8).join('\n'));
      if (migrator) {
        console.log('--- migrator, last lines');
        console.log(migrator.lines.slice(-12).join('\n'));
      }
    }
  };
  installGuard(report);
  let api: ApiPromise | undefined;
  const chainEvents: Array<{ name: string; who: string; reason?: string }> = [];

  try {
    let live: ApiPromise | undefined;
    const connected = await step('start a dev node and connect', async () => {
      await until('the node RPC port', 60_000, async () => {
        if (node.exit) throw new Error(`the node exited: ${node.lines.slice(-5).join(' | ')}`);
        return (await accepts(port)) ? true : undefined;
      });
      live = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
      same(live.runtimeVersion.specName.toString(), 'identitee', 'spec name');
      api = live;
    });
    if (!connected || !live) return 1;
    const rpc: ApiPromise = live;

    await rpc.query.system.events((records: Json) => {
      for (const { event } of records) {
        if (event.section !== 'identitee') continue;
        if (event.method === 'MigrationFulfilled') chainEvents.push({ name: 'fulfilled', who: event.data[0].toString() });
        if (event.method === 'MigrationRejected') chainEvents.push({ name: 'rejected', who: event.data[0].toString(), reason: event.data[2].toString() });
      }
    });

    const eventFor = (name: string, who: string): Promise<{ name: string; who: string; reason?: string }> =>
      until(`${name} of ${names[who]}`, 90_000, () => chainEvents.find((e) => e.name === name && e.who === who));
    const trust = async (p: KeyringPair): Promise<string | null> => json(await (rpc.call as Json).identiteeApi.trustLevel(p.address));
    const profile = async (p: KeyringPair): Promise<Json> => json(await (rpc.call as Json).identiteeApi.profile(p.address));
    const pending = async (p: KeyringPair): Promise<Json> => json(await (rpc.query as Json).identitee.migrationRequests(p.address));
    const request = (p: KeyringPair, source: 'Polkadot' | 'Kusama') => send(rpc, p, (rpc.tx as Json).identitee.requestMigration(source));

    await step('Bob is the migration agent of the dev preset', async () => {
      const bob = keyring.addFromUri('//Bob');
      assert(json(await (rpc.query as Json).identitee.agents(bob.address))?.[1] === 8, 'Bob lacks MIGRATE only');
    });

    // Ferdie asks while no migrator runs.
    await step('Ferdie (zero balance) requests a migration from Polkadot, nobody serves it yet', async () => {
      const events = await request(ferdie, 'Polkadot');
      assert(events.includes('identitee.MigrationRequested'), 'no MigrationRequested');
      assert(events.includes('skipFeelessPayment.FeeSkipped'), 'the call was not feeless');
      assert((await pending(ferdie)) !== null, 'the request is not stored');
    });

    // Two asks, then creates an identity before anybody serves the request: it can never be fulfilled.
    await step('Two requests a migration, then creates an identity (set_bio) before the migrator runs', async () => {
      await request(two, 'Polkadot');
      const events = await send(rpc, two, (rpc.tx as Json).identitee.setBio(text('Two, the account that did not wait')));
      assert(events.includes('identitee.BioSet'), 'no BioSet event');
      assert((await pending(two)) !== null, 'the request is still pending');
      assert((await profile(two)) !== null, 'Two has an identity');
    });

    migrator = new Child(process.execPath, ['--import', 'tsx', new URL('./migrator.ts', import.meta.url).pathname, '--snapshot', snapshotFile], {
      ...process.env,
      IDENTITEE_WS: ws,
      IDENTITEE_MIGRATOR_SURI: '//Bob',
    });
    const service = migrator;

    await step('the migrator starts, reads the snapshot and sweeps the pending request', async () => {
      await until('the "started" log', 60_000, () => {
        if (service.exit) throw new Error(`the migrator exited early: ${service.lines.slice(-5).join(' | ')}`);
        return service.logs('started')[0];
      });
      const loaded = service.logs('snapshot')[0];
      assert(loaded?.source === 'Polkadot' && loaded.identities === 4, `snapshot log: ${JSON.stringify(loaded)}`);
      assert(service.logs('agent')[0]?.agent === keyring.addFromUri('//Bob').address, 'the agent is not Bob');
    });

    await step('Ferdie, requested before the start, is fulfilled by the start-up sweep (FullyVerified)', async () => {
      await eventFor('fulfilled', ferdie.address);
      assert((await pending(ferdie)) === null, 'the request is still pending');
      same(await trust(ferdie), 'FullyVerified', 'trust of Ferdie');
      const p = await profile(ferdie);
      same(hexToString(p.identity.typed.Email.public), 'ferdie@example.org', 'Ferdie email');
    });

    await step('Two, who created an identity after its request, is rejected with Other (not retried for ever)', async () => {
      const rejected = await eventFor('rejected', two.address);
      same(rejected.reason, 'Other', 'reason');
      assert((await pending(two)) === null, 'the request is still pending');
      const log = service.logs('rejected').find((l) => l.who === two.address);
      assert(log && /created an identity/.test(log.cause), 'no "rejected" log that says why');
      assert(!service.logs('request-failed').some((l) => l.who === two.address), 'a failure was logged for Two');
      assert(hexToString((await profile(two)).identity.bio) === 'Two, the account that did not wait', 'the identity of Two is untouched');
    });

    await step('Dave requests while it runs: fulfilled from the finalized event, trust Certified', async () => {
      const events = await request(dave, 'Polkadot');
      assert(events.includes('identitee.MigrationRequested'), 'no MigrationRequested');
      await eventFor('fulfilled', dave.address);
      same(await trust(dave), 'Certified', 'api.call.identiteeApi.trustLevel(Dave)');
      const p = await profile(dave);
      same(p.imported.source, 'Polkadot', 'imported source');
      same(p.imported.block, SOURCE_BLOCK, 'imported source block');
      same(p.imported.blockHash, SOURCE_HASH, 'imported source block hash');
      same(p.imported.judgements, [[0, 'Reasonable'], [5, 'KnownGood']], 'imported judgements');
      const fulfilled = service.logs('fulfilled').find((l) => l.who === dave.address);
      assert(fulfilled && fulfilled.sourceBlock === SOURCE_BLOCK, 'no "fulfilled" log for Dave');
    });

    await step('One carries a People Chain payload: nine fields, a 20-byte PGP, KnownGood by dotID: Certified', async () => {
      await request(one, 'Polkadot');
      await eventFor('fulfilled', one.address);
      same(await trust(one), 'Certified', 'trust of One');
      const p = await profile(one);
      same(
        Object.keys(p.identity.typed).sort(),
        ['Discord', 'DisplayName', 'Email', 'GitHub', 'LegalName', 'Matrix', 'Pgp', 'Web', 'X'],
        'imported kinds',
      );
      same(p.identity.typed.Pgp.public, real.payload.typed.find(([k]) => k === 'Pgp')?.[1], 'PGP bytes');
      same(p.identity.typed.DisplayName.public, real.payload.typed.find(([k]) => k === 'DisplayName')?.[1], 'display name');
    });

    await step('Charlie: the invalid entries of the snapshot are dropped, the rest is imported', async () => {
      const loaded = service.logs('snapshot')[0];
      const drops: string[] = loaded.dropped.flatMap((d: Json) => d.dropped);
      same(drops.sort(), ['DisplayName:invalid-utf8', 'Pgp:bad-pgp-length', 'Web:too-long'], 'dropped at load');
      await request(charlie, 'Polkadot');
      await eventFor('fulfilled', charlie.address);
      const p = await profile(charlie);
      same(Object.keys(p.identity.typed), ['Email'], 'imported kinds');
      same(hexToString(p.identity.typed.Email.public), 'charlie@example.org', 'Charlie email');
    });

    await step('Eve, absent from the snapshot, is rejected', async () => {
      await request(eve, 'Polkadot');
      const rejected = await eventFor('rejected', eve.address);
      same(rejected.reason, 'Unspecified', 'reason');
      assert((await pending(eve)) === null, 'the request is still pending');
      same(await trust(eve), null, 'Eve has no identity');
      const log = service.logs('rejected').find((l) => l.who === eve.address);
      assert(log, 'no "rejected" log for Eve');
    });

    await step('a request for Kusama, which has no snapshot, stays pending without a transaction', async () => {
      await request(alice, 'Kusama');
      await until('the "not-served" log', 60_000, () => service.logs('not-served').find((l) => l.who === alice.address));
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      assert((await pending(alice)) !== null, 'the request was consumed');
      assert(!chainEvents.some((e) => e.who === alice.address), 'an event concerns Alice');
    });

    await step('the key is never logged and every line of stdout is one JSON object', async () => {
      for (const line of service.lines) assert(!line.includes('//Bob'), `the secret URI is in the output: ${line.slice(0, 80)}`);
      for (const line of service.outLines) JSON.parse(line);
      assert(service.outLines.length > 5, 'the migrator logged almost nothing');
    });

    await step('SIGTERM stops the migrator cleanly (exit 0)', async () => {
      await service.stop('SIGTERM');
      same(service.exit, { code: 0, signal: null }, 'exit status');
      assert(service.logs('stopped').length === 1, 'no "stopped" log');
    });

    if (withNetwork) {
      // No snapshot: the migrator reads the real People Chains, at their finalized head.
      const liveService = new Child(process.execPath, ['--import', 'tsx', new URL('./migrator.ts', import.meta.url).pathname], {
        ...process.env,
        IDENTITEE_WS: ws,
        IDENTITEE_MIGRATOR_SURI: '//Bob',
      });
      migrator = liveService;
      await step('live mode: Alice\'s pending Kusama request is rejected after a real read of the Kusama People Chain', async () => {
        const rejected = await eventFor('rejected', alice.address);
        same(rejected.reason, 'Unspecified', 'reason');
        const connected = liveService.logs('people-connected').find((l) => l.source === 'Kusama');
        assert(connected, 'no "people-connected" log for Kusama');
        assert(String(connected.endpoint).startsWith('wss://'), `endpoint ${connected.endpoint}`);
        assert((await pending(alice)) === null, 'the request is still pending');
      });
      await step('live mode: Eve asks again and, with no identity on the Polkadot People Chain, is rejected', async () => {
        const before = chainEvents.filter((e) => e.name === 'rejected' && e.who === eve.address).length;
        await request(eve, 'Polkadot');
        await until('a second rejection of Eve', 90_000, () =>
          chainEvents.filter((e) => e.name === 'rejected' && e.who === eve.address).length > before ? true : undefined,
        );
        assert(liveService.logs('people-connected').some((l) => l.source === 'Polkadot'), 'no Polkadot connection');
        const log = liveService.logs('rejected').find((l) => l.who === eve.address);
        assert(log, 'no "rejected" log for Eve');
      });
      await step('live mode: SIGTERM stops it cleanly', async () => {
        await liveService.stop('SIGTERM');
        same(liveService.exit, { code: 0, signal: null }, 'exit status');
      });

      // Pinned to a People Chain block (here a recent finalized one: the public nodes keep its state).
      const pinned = await connectPeople('Polkadot');
      const pinnedHash = (await pinned.api.rpc.chain.getFinalizedHead()).toHex();
      await pinned.api.disconnect();
      const pinnedService = new Child(process.execPath, ['--import', 'tsx', new URL('./migrator.ts', import.meta.url).pathname], {
        ...process.env,
        IDENTITEE_WS: ws,
        IDENTITEE_MIGRATOR_SURI: '//Bob',
        PEOPLE_AT_BLOCK_POLKADOT: pinnedHash,
      });
      migrator = pinnedService;
      await step('live mode pinned (PEOPLE_AT_BLOCK_POLKADOT): Eve is rejected after a read of that block', async () => {
        const before = chainEvents.filter((e) => e.name === 'rejected' && e.who === eve.address).length;
        await until('the "started" log', 60_000, () => pinnedService.logs('started')[0]);
        await request(eve, 'Polkadot');
        await until('a third rejection of Eve', 90_000, () =>
          chainEvents.filter((e) => e.name === 'rejected' && e.who === eve.address).length > before ? true : undefined,
        );
        const log = pinnedService.logs('people-pinned')[0];
        same([log?.source, log?.at], ['Polkadot', pinnedHash], 'people-pinned log');
        assert(pinnedService.logs('rejected').some((l) => l.who === eve.address), 'no "rejected" log for Eve');
        await pinnedService.stop('SIGTERM');
        same(pinnedService.exit, { code: 0, signal: null }, 'exit status');
      });
    }
  } catch (e) {
    console.log(`FAIL fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    results.failed++;
  } finally {
    await migrator?.stop().catch(() => undefined);
    await (api as ApiPromise | undefined)?.disconnect().catch(() => undefined);
    await node.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupAll();
    report();
  }
  return results.failed === 0 ? 0 : 1;
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.log(`FAIL fatal: ${e instanceof Error ? e.message : String(e)}`);
    cleanupAll();
    process.exit(1);
  },
);
