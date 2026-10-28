// The verification service (design: docs/VERIFIER.md): people prove they control an email, an account or a key, and the verifier agent records the
// attestation on chain.
//
//   IDENTITEE_VERIFIER_SURI='<secret uri>' STATE_DIRECTORY=<dir> npx tsx src/verifier/main.ts
//
// Started like the migrator: it connects to the local node (IDENTITEE_WS), checks it runs
// identitee with only known signed extensions, checks the agent can attest fields and record
// facts, then serves HTTP on 127.0.0.1:VERIFIER_PORT behind nginx. SIGTERM or SIGINT: stops
// taking requests, lets a submission in flight end, exits 0. Logs are one JSON object per line on
// stdout, without any secret.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import { connectIdentitee, messageOf, runtimeUpgrade, watchSignals } from '../migrator.ts';
import { LiveChain, SS58_PREFIX } from './chain.ts';
import { channelRegistry, type Channel } from './channels.ts';
import { parseConfig, type Config } from './config.ts';
import type { Ctx } from './ctx.ts';
import { diditChannel } from './didit.ts';
import { emailChannel } from './email.ts';
import { HttpServer } from './http.ts';
import { matrixChannel } from './matrix.ts';
import { oauthChannels } from './oauth.ts';
import { verifierLogger, type Logger } from './log.ts';
import { PacketMemory, registerPacketRoute } from './packet.ts';
import { pgpChannel } from './pgp.ts';
import { Store } from './store.ts';
import { telegramChannel } from './telegram.ts';
import { webChannel } from './web.ts';

/** The channel modules, one per line. */
export const CHANNELS: Channel[] = [
  emailChannel(),
  ...oauthChannels(),
  telegramChannel(),
  matrixChannel(),
  webChannel(),
  pgpChannel(),
  diditChannel(),
];

const SWEEP_MS = 60_000;
/** At a stop, how long a submission in flight is waited for. */
const STOP_WAIT_MS = 30_000;

export interface MainDeps {
  connect: (ws: string) => Promise<ApiPromise>;
  write: (line: string) => void;
  /** Called by a second signal while stopping. */
  exit: (code: number) => void;
  channels: Channel[];
  host: string;
}

export async function main(env: NodeJS.ProcessEnv, overrides: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = {
    connect: connectIdentitee,
    write: (line) => process.stdout.write(line),
    exit: (code) => process.exit(code),
    channels: CHANNELS,
    host: '127.0.0.1',
    ...overrides,
  };
  let cfg: Config;
  try {
    cfg = parseConfig(env);
  } catch (e) {
    process.stderr.write(`${messageOf(e)}\n`);
    return 2;
  }
  const log = verifierLogger(cfg, deps.write);
  const signals = watchSignals(deps);
  try {
    return await run(cfg, log, deps, signals);
  } finally {
    signals.release();
  }
}

async function run(cfg: Config, log: Logger, deps: MainDeps, signals: ReturnType<typeof watchSignals>): Promise<number> {
  let pair: KeyringPair;
  try {
    await cryptoWaitReady();
    pair = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX }).addFromUri(cfg.suri);
  } catch {
    // The reason is not printed: it could quote the key.
    log('error', 'fatal', { error: 'IDENTITEE_VERIFIER_SURI is not a valid secret URI' });
    return 1;
  }

  const connecting = deps.connect(cfg.ws);
  connecting.catch(() => undefined);
  let api: ApiPromise | undefined;
  let store: Store | undefined;
  let chain: LiveChain | undefined;
  let server: HttpServer | undefined;
  let registry: ReturnType<typeof channelRegistry> | undefined;
  let sweeper: NodeJS.Timeout | undefined;
  const shutdown = async (): Promise<void> => {
    clearInterval(sweeper);
    await server?.close();
    await registry?.stop();
    if (chain !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), STOP_WAIT_MS);
      });
      if ((await Promise.race([chain.idle().then(() => 'done' as const), patience])) === 'timeout') {
        log('warn', 'stop-timeout', { reason: 'a transaction is still waiting to be included; leaving it' });
      }
      clearTimeout(timer);
    }
    store?.close();
    await api?.disconnect().catch(() => undefined);
  };

  try {
    const first = await Promise.race([connecting.then((connected) => ({ connected })), signals.stopped.then((signal) => ({ signal }))]);
    if ('signal' in first) {
      log('info', 'stopping', { signal: first.signal, during: 'connecting' });
      void connecting.then((late) => late.disconnect()).catch(() => undefined);
      log('info', 'stopped');
      return 0;
    }
    api = first.connected;
    chain = new LiveChain(api, pair, log);
    await chain.check();
    log('info', 'connected', { ws: cfg.ws, genesis: chain.genesis });
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    store = new Store(join(cfg.stateDir, 'verifier.db'));
    const packets = new PacketMemory();
    const ctx: Ctx = { cfg, log, chain, store, packets, now: Date.now };
    server = new HttpServer({ dev: cfg.dev, log });
    registerPacketRoute(server, ctx);
    registry = channelRegistry(deps.channels, ctx, server);
    await registry.start();
    log('info', 'channels', { enabled: registry.enabled });
    const port = await server.listen(cfg.port, deps.host);
    const live = store;
    sweeper = setInterval(() => {
      try {
        live.sweep();
        packets.sweep();
      } catch (e) {
        log('error', 'sweep-failed', { error: messageOf(e) });
      }
    }, SWEEP_MS);
    sweeper.unref();
    log('info', 'listening', { host: deps.host, port, dev: cfg.dev });
  } catch (e) {
    log('error', 'fatal', { error: messageOf(e) });
    await shutdown();
    return 1;
  }

  const upgrade = runtimeUpgrade(api);
  const stop = await Promise.race([signals.stopped.then((signal) => ({ signal })), upgrade.upgraded.then((specVersion) => ({ specVersion }))]);
  upgrade.stop();
  if ('signal' in stop) log('info', 'stopping', { signal: stop.signal });
  else log('warn', 'stopping', { reason: 'runtime_upgraded', specVersion: stop.specVersion });
  signals.stopping();
  await shutdown();
  log('info', 'stopped');
  // an upgrade is not a failure, but only a failure makes systemd start the service again
  return 'signal' in stop ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fatal: ${messageOf(e)}\n`);
      process.exit(1);
    },
  );
}
