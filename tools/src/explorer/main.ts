// The block explorer: indexes the finalized blocks of the local node into SQLite and serves the
// read-only API.
//
//   EXPLORER_DB=./explorer.db EXPLORER_DEV=1 npx tsx src/explorer/main.ts
//
// The API listens first and keeps serving the index whatever the node does: until the node answers,
// and while it is away, /api/status says `node: "down"`. The WebSocket provider reconnects by
// itself; an indexer start that fails (catch-up interrupted) is retried in-process with a growing
// wait. SIGTERM or SIGINT: stops the indexer, then the HTTP server, then closes the store, exits 0.
// Logs are one JSON object per line on stdout.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ApiPromise, WsProvider } from '@polkadot/api';

import { makeLogger, messageOf, watchSignals, type Logger } from '../migrator.ts';
import { chainLive, ExplorerApi } from './api.ts';
import { parseConfig, type ExplorerConfig } from './config.ts';
import { Indexer } from './indexer.ts';
import { ExplorerStore } from './store.ts';

const STOP_WAIT_MS = 30_000;

export interface KeepIndexingOptions {
  retryMs?: number;
  maxRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `start` until it resolves (the indexer is caught up and follows on its own); after each
 * rejection, log it and wait 1 s, doubling up to 30 s. `stop()` ends the retries.
 */
export function keepIndexing(start: () => Promise<void>, log: Logger, options: KeepIndexingOptions = {}): { done: Promise<void>; stop(): void } {
  const retryMs = options.retryMs ?? 1000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  let stopped = false;
  let wake: (() => void) | null = null;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }));
  const done = (async () => {
    for (let failures = 0; !stopped; ) {
      try {
        await start();
        return;
      } catch (e) {
        failures++;
        const wait = Math.min(retryMs * 2 ** (failures - 1), maxRetryMs);
        log('warn', 'indexer_failed', { error: messageOf(e), retryInMs: wait });
        if (!stopped) await sleep(wait);
        wake = null;
      }
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      wake?.();
    },
  };
}

export interface MainDeps {
  connect: (ws: string) => Promise<ApiPromise>;
  write: (line: string) => void;
  exit: (code: number) => void;
}

const connect = (ws: string): Promise<ApiPromise> => ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });

export async function main(env: NodeJS.ProcessEnv, overrides: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = { connect, write: (line) => process.stdout.write(line), exit: (code) => process.exit(code), ...overrides };
  let cfg: ExplorerConfig;
  try {
    cfg = parseConfig(env);
  } catch (e) {
    process.stderr.write(`${messageOf(e)}\n`);
    return 2;
  }
  const log = makeLogger([], deps.write);
  const signals = watchSignals(deps);
  try {
    return await run(cfg, log, deps, signals);
  } finally {
    signals.release();
  }
}

async function run(cfg: ExplorerConfig, log: Logger, deps: MainDeps, signals: ReturnType<typeof watchSignals>): Promise<number> {
  let store: ExplorerStore;
  let server: ExplorerApi;
  try {
    if (cfg.db !== ':memory:') mkdirSync(dirname(cfg.db), { recursive: true });
    store = new ExplorerStore(cfg.db);
    server = new ExplorerApi({ store, origins: cfg.origins, labels: cfg.labels, log });
    const port = await server.listen(cfg.port, cfg.host);
    log('info', 'listening', { host: cfg.host, port, origins: cfg.origins });
  } catch (e) {
    log('error', 'fatal', { error: messageOf(e) });
    return 1;
  }

  // ApiPromise.create resolves on the first successful connection; the provider retries until then.
  const connecting = deps.connect(cfg.node);
  connecting.catch(() => undefined);
  let api: ApiPromise | undefined;
  let indexer: Indexer | undefined;
  let loop: ReturnType<typeof keepIndexing> | undefined;
  let signal: string;

  const first = await Promise.race([connecting.then((connected) => ({ connected }), (e: unknown) => ({ failed: e })), signals.stopped.then((s) => ({ signal: s }))]);
  if ('signal' in first) {
    signal = first.signal;
    void connecting.then((late) => late.disconnect()).catch(() => undefined);
  } else if ('failed' in first) {
    log('error', 'fatal', { error: messageOf(first.failed) });
    await server.close();
    store.close();
    return 1;
  } else {
    api = first.connected;
    log('info', 'connected', { node: cfg.node, genesis: api.genesisHash.toHex() });
    indexer = new Indexer(api, store, log);
    server.attach(chainLive(api, cfg.labels), indexer);
    const running = indexer;
    loop = keepIndexing(() => running.start(), log);
    signal = await signals.stopped;
  }

  log('info', 'stopping', { signal });
  signals.stopping();
  loop?.stop();
  await indexer?.stop();
  // a catch-up block in flight is written whole or not at all; a node that hangs is not waited for
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([loop?.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)))]);
  clearTimeout(timer);
  await server.close();
  await api?.disconnect().catch(() => undefined);
  store.close();
  log('info', 'stopped');
  return 0;
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
