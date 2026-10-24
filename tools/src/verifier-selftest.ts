// Self-test of the verification service on a throwaway `--dev --tmp` node, with a fake Resend and a
// fake Telegram Bot API on the loopback.
//
//   npm run verifier:selftest
//
// Starts `identitee-node` (IDENTITEE_NODE_BIN, default `identitee-node` on the PATH) on a free port,
// makes a fresh agent key an agent of authority 0 with ATTEST_FIELDS | PERSON_FACTS (3) through sudo
// (//Alice), gives //Charlie an identity with a public Email and a public Telegram, then starts the real
// `src/verifier/main.ts` as a child (this file with `--serve`: the real channels, only the Resend URL and
// the Bot API address point at the fakes) and drives it over HTTP like the site would:
//   email     send -> the code read from the fake mail -> a wrong code refused -> check -> FieldAttested EmailCode
//   telegram  start -> a fake `/start <token>` update -> the code from the bot's sendMessage -> check -> BotChallenge
//   stale     send, then the Email changes on chain, then check -> 409 "Your Email changed. Verify it again."
// Whatever ends the run (a failure, Ctrl-C, `timeout`, a dropped ssh), the node and the service are killed
// and the temporary directory removed (selftest-guard.ts), so it is safe to run on a production server.
// It then checks that no secret (agent phrase, API key, bot token, codes, tokens, sessions, the email) is in
// its output, that every stdout line is one JSON object, and that SIGTERM stops it with exit code 0.
// Prints `OK <step>` / `FAIL <step>: <why>`; exit code 0 only if every step passed. Needs no network.

import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToHex } from '@polkadot/util';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';

import { cleanupAll, guardChild, guardDir, installGuard } from './selftest-guard.ts';

const NODE = process.env.IDENTITEE_NODE_BIN || 'identitee-node';
const SS58_PREFIX = 2426;
const RESEND_URL = 'https://api.resend.com/emails';
const BOT = 'identitee_selftest_bot';
const EMAIL = 'selftest@example.org';
const TG_USER = 'Selftest_User';
const TG_ID = 424242;
/** ATTEST_FIELDS | PERSON_FACTS. */
const CAPS = 3;

type Json = any;

// --- The child: the real service, with the two outbound addresses pointed at the fakes -------------

async function serve(): Promise<number> {
  const { main, CHANNELS } = await import('./verifier/main.ts');
  const { emailChannel } = await import('./verifier/email.ts');
  const { telegramChannel } = await import('./verifier/telegram.ts');
  const resend = process.env.SELFTEST_RESEND_URL ?? '';
  const telegramApi = process.env.SELFTEST_TELEGRAM_API ?? '';
  // Only the Resend call is redirected; any other outbound call of the email channel is a failure.
  const redirect: typeof fetch = (input, init) =>
    String(input) === RESEND_URL ? fetch(resend, init) : Promise.reject(new Error('unexpected outbound call'));
  const channels = CHANNELS.map((c) =>
    c.name === 'email'
      ? emailChannel({ fetch: redirect, resolveMx: async () => [{ exchange: 'mx.example.org', priority: 10 }] })
      : c.name === 'telegram'
        ? telegramChannel({ apiBase: telegramApi })
        : c,
  );
  return main(process.env, { channels });
}

// --- Helpers (as in migrator-selftest.ts) -----------------------------------------------------------

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
  readonly outLines: string[] = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  readonly proc: ChildProcess;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.proc = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    guardChild(this.proc);
    this.proc.once('error', (e) => {
      this.lines.push(`spawn failed: ${e.message}`);
      this.exit = { code: null, signal: null };
    });
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

  logs(event: string): Json[] {
    const out: Json[] = [];
    for (const line of this.outLines) {
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
  async stop(signal: NodeJS.Signals = 'SIGTERM', graceMs = 40_000): Promise<void> {
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// --- The fakes ------------------------------------------------------------------------------------

/** Errors inside the fakes: each answered 500 and recorded here, never an unhandled rejection. */
const fakeFailures: string[] = [];

function safely(what: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handler(req, res).catch((e: unknown) => {
      fakeFailures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      try {
        if (!res.headersSent) reply(res, 500, { ok: false, error_code: 500, description: 'fake failed' });
        else res.end();
      } catch {
        // the connection is gone
      }
    });
  };
}

/** Resend: `POST /emails` with the right key keeps the mail and answers an id. */
async function fakeResend(apiKey: string): Promise<{ url: string; close: () => Promise<void>; mails: Json[]; refused: number }> {
  const state = { mails: [] as Json[], refused: 0 };
  const server = await listen(
    safely('fake Resend', async (req, res) => {
      const body = await readBody(req);
      if (req.method !== 'POST' || req.url !== '/emails' || req.headers.authorization !== `Bearer ${apiKey}`) {
        state.refused++;
        return reply(res, 401, { message: 'refused' });
      }
      state.mails.push(JSON.parse(body));
      reply(res, 200, { id: `selftest-${state.mails.length}` });
    }),
  );
  return {
    url: `${server.url}/emails`,
    close: server.close,
    get mails() {
      return state.mails;
    },
    get refused() {
      return state.refused;
    },
  };
}

interface FakeTelegram {
  url: string;
  close: () => Promise<void>;
  /** Every method called with the right token, in order. */
  calls: string[];
  /** Calls with another token. */
  refused: number;
  sent: Array<{ chat_id: number; text: string }>;
  push(message: Json): void;
}

/** The Bot API: `POST /bot<token>/<method>`; getUpdates long-polls (5 s at most) on a queue the test fills. */
async function fakeTelegram(token: string): Promise<FakeTelegram> {
  const updates: Json[] = [];
  const waiting = new Set<() => void>();
  let nextId = 1;
  const state: Omit<FakeTelegram, 'url' | 'close' | 'push'> = { calls: [], refused: 0, sent: [] };
  const server = await listen(
    safely('fake Telegram', async (req, res) => {
      const raw = await readBody(req);
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || match === null || match[1] !== token) {
        state.refused++;
        return reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      }
      const method = match[2] as string;
      const params: Json = raw === '' ? {} : JSON.parse(raw);
      state.calls.push(method);
      if (method === 'deleteWebhook') return reply(res, 200, { ok: true, result: true });
      if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 1, is_bot: true, username: BOT } });
      if (method === 'sendMessage') {
        state.sent.push({ chat_id: params.chat_id, text: params.text });
        return reply(res, 200, { ok: true, result: { message_id: state.sent.length } });
      }
      if (method === 'getUpdates') {
        const offset: number = typeof params.offset === 'number' ? params.offset : 0;
        const ready = (): Json[] => updates.filter((u) => u.update_id >= offset);
        if (ready().length === 0) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              clearTimeout(timer);
              waiting.delete(done);
              resolve();
            };
            const timer = setTimeout(done, Math.min(Number(params.timeout ?? 0), 5) * 1000);
            waiting.add(done);
            req.socket.once('close', done);
          });
        }
        if (!res.destroyed) reply(res, 200, { ok: true, result: ready() });
        return;
      }
      reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }),
  );
  return {
    url: server.url,
    close: async () => {
      for (const wake of [...waiting]) wake();
      await server.close();
    },
    calls: state.calls,
    sent: state.sent,
    get refused() {
      return state.refused;
    },
    push(message: Json) {
      updates.push({ update_id: nextId++, message });
      for (const wake of [...waiting]) wake();
    },
  };
}

// --- The test ---------------------------------------------------------------------------------------

/** What the report needs, whichever way the run ends. */
const current: { node?: Child; verifier?: Child; secrets: string[]; reported: boolean } = { secrets: [], reported: false };

const redact = (line: string): string => current.secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('<redacted>')), line);

/** The summary, then on a failure the last lines of the node and the service with every secret replaced; once. */
function report(why?: string): void {
  if (current.reported) return;
  current.reported = true;
  if (why !== undefined) {
    console.log(`FAIL ${redact(why)}`);
    results.failed++;
  }
  console.log(results.failed === 0 ? `PASS ${results.ok} steps` : `FAILED ${results.failed} step(s), ${results.ok} passed`);
  if (results.failed === 0) return;
  for (const failure of fakeFailures) console.log(`--- fake: ${redact(failure)}`);
  if (current.node) {
    console.log('--- node, last lines');
    console.log(current.node.lines.slice(-8).map(redact).join('\n'));
  }
  if (current.verifier) {
    console.log('--- verifier, last lines (secrets redacted)');
    console.log(current.verifier.lines.slice(-15).map(redact).join('\n'));
  }
}

async function selftest(): Promise<number> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX });
  const alice = keyring.addFromUri('//Alice');
  const charlie = keyring.addFromUri('//Charlie');
  // A fresh agent key, so that its phrase can be looked for in the logs.
  const agentPhrase = mnemonicGenerate();
  const agent = keyring.addFromUri(agentPhrase);
  const resendKey = `re_${randomBytes(18).toString('hex')}`;
  const botToken = `7${randomBytes(4).readUInt32BE(0)}:${randomBytes(26).toString('base64url')}`;
  /** Everything that must never reach the service's output. */
  const secrets: Array<[string, string]> = [
    ['the agent phrase', agentPhrase],
    ['the Resend key', resendKey],
    ['the bot token', botToken],
    ['the email', EMAIL],
  ];
  current.secrets.push(...secrets.map(([, value]) => value));
  const codes: string[] = [];
  const sessions: string[] = [];
  /** A code, link token or session: looked for in the output and redacted from the report. */
  const keep = (list: string[], ...values: string[]): void => {
    list.push(...values);
    current.secrets.push(...values);
  };

  const dir = mkdtempSync(join(tmpdir(), 'identitee-verifier-selftest-'));
  guardDir(dir);
  let node: Child | undefined;
  let verifier: Child | undefined;
  let resend: Awaited<ReturnType<typeof fakeResend>> | undefined;
  let telegram: FakeTelegram | undefined;
  let api: ApiPromise | undefined;
  const attested: Array<{ who: string; key: Json; agent: string }> = [];

  try {
    const nodePort = await freePort();
    const ws = `ws://127.0.0.1:${nodePort}`;
    const chainNode = (node = current.node = new Child(NODE, ['--dev', '--tmp', '--no-prometheus', '--no-telemetry', '--rpc-port', String(nodePort)]));
    const fakeMail = (resend = await fakeResend(resendKey));
    const bot = (telegram = await fakeTelegram(botToken));
    let live: ApiPromise | undefined;
    const connected = await step(`start a dev node (${NODE}) and connect`, async () => {
      await until('the node RPC port', 60_000, async () => {
        if (chainNode.exit) throw new Error(`the node exited: ${chainNode.lines.slice(-5).join(' | ')}`);
        return (await accepts(nodePort)) ? true : undefined;
      });
      live = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
      same(live.runtimeVersion.specName.toString(), 'identitee', 'spec name');
      api = live;
    });
    if (!connected || !live) return 1;
    const rpc: ApiPromise = live;
    const tx = rpc.tx as Json;

    await rpc.query.system.events((records: Json) => {
      for (const { event } of records) {
        if (event.section === 'identitee' && event.method === 'FieldAttested') {
          // FieldAttested { who, key, authority, verdict, agent }
          attested.push({ who: event.data[0].toString(), key: json(event.data[1]), agent: event.data[4].toString() });
        }
      }
    });
    const profile = async (): Promise<Json> => json(await (rpc.call as Json).identiteeApi.profile(charlie.address));
    const attestation = async (kind: string): Promise<Json[] | undefined> =>
      ((await profile()).attestations as Json[]).find(([key]) => key.typed === kind);

    let authority = 0;
    await step('a fresh agent key becomes an agent of authority 0 (capabilities 3) through sudo', async () => {
      if (json(await (rpc.query as Json).identitee.authorities(0)) === null) {
        authority = json(await (rpc.query as Json).identitee.nextAuthorityId());
        await send(rpc, alice, tx.sudo.sudo(tx.identitee.addAuthority(stringToHex('identitee'))));
      }
      await send(rpc, alice, tx.sudo.sudo(tx.identitee.setAgent(authority, agent.address, CAPS)));
      same(json(await (rpc.query as Json).identitee.agents(agent.address)), [authority, CAPS], 'agents(agent)');
    });

    await step('Charlie sets a public Email and a public Telegram', async () => {
      const a = await send(rpc, charlie, tx.identitee.setField({ Typed: 'Email' }, { Public: stringToHex(EMAIL) }));
      const b = await send(rpc, charlie, tx.identitee.setField({ Typed: 'Telegram' }, { Public: stringToHex(`@${TG_USER}`) }));
      assert(a.includes('identitee.FieldSet') && b.includes('identitee.FieldSet'), 'no FieldSet event');
    });

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    verifier = current.verifier = new Child(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--serve'], {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      IDENTITEE_WS: ws,
      IDENTITEE_VERIFIER_SURI: agentPhrase,
      VERIFIER_PORT: String(port),
      VERIFIER_DEV: '1',
      STATE_DIRECTORY: join(dir, 'state'),
      RESEND_API_KEY: resendKey,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_BOT_USERNAME: `@${BOT}`,
      SELFTEST_RESEND_URL: fakeMail.url,
      SELFTEST_TELEGRAM_API: bot.url,
    });
    const service = verifier;
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    const started = await step('the verifier starts, checks its agent and listens', async () => {
      await until('the "listening" log', 60_000, () => {
        if (service.exit) throw new Error(`the verifier exited early: ${service.lines.slice(-5).join(' | ')}`);
        return service.logs('listening')[0];
      });
      const a = service.logs('agent')[0];
      same([a?.agent, a?.authority, a?.capabilities], [agent.address, authority, CAPS], 'agent log');
    });
    if (!started) return 1;

    await step('/api/health and /api/channels: email, pgp, telegram and web enabled, a disabled channel answers 503', async () => {
      const health = await call('GET', '/api/health');
      same([health.status, health.body.ok, health.body.genesis], [200, true, rpc.genesisHash.toHex()], 'health');
      const channels = await call('GET', '/api/channels');
      same([...channels.body.channels].sort(), ['email', 'pgp', 'telegram', 'web'], 'enabled channels');
      same(channels.body.telegramBot, BOT, 'telegramBot');
      const off = await call('POST', '/api/matrix/start', { address: charlie.address });
      same([off.status, off.body.error], [503, 'This verification is not available yet.'], 'a disabled channel');
      await until('deleteWebhook and getMe', 10_000, () => (bot.calls.includes('deleteWebhook') && bot.calls.includes('getMe') ? true : undefined));
      same(bot.calls.slice(0, 2), ['deleteWebhook', 'getMe'], 'first Bot API calls');
    });

    await step('email: the code goes to the address on chain through Resend; a wrong code is refused; the right one attests EmailCode', async () => {
      const sent = await call('POST', '/api/email/send', { address: charlie.address });
      same([sent.status, sent.body.sent], [200, true], 'send');
      keep(sessions, sent.body.session);
      same(fakeMail.mails.length, 1, 'mails at the fake Resend');
      const mail = fakeMail.mails[0];
      same(mail.to, [EMAIL], 'recipient');
      const code = /code is (\d{6})/.exec(mail.text)?.[1];
      assert(code !== undefined, 'no code in the mail');
      keep(codes, code);
      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
      const bad = await call('POST', '/api/email/check', { address: charlie.address, session: sent.body.session, code: wrong });
      same([bad.status, bad.body.error], [400, 'That code is not right.'], 'wrong code');
      const ok = await call('POST', '/api/email/check', { address: charlie.address, session: sent.body.session, code });
      same([ok.status, ok.body], [200, { verified: true }], 'check');
      const event = await until('FieldAttested for the Email', 30_000, () => attested.find((e) => e.key?.typed === 'Email'));
      same([event.who, event.agent], [charlie.address, agent.address], 'FieldAttested who and agent');
      const entry = await attestation('Email');
      assert(entry !== undefined, 'no Email attestation in the profile');
      same([entry[1], entry[2].verdict, entry[2].method, entry[3]], [authority, 'Verified', { emailCode: null }, true], 'Email attestation');
      const again = await call('POST', '/api/email/check', { address: charlie.address, session: sent.body.session, code });
      same(again.status, 400, 'the same code a second time');
    });

    await step('telegram: /start with the link token gets a code from the bot; the check attests BotChallenge', async () => {
      const start = await call('POST', '/api/telegram/start', { address: charlie.address });
      same(start.status, 200, 'start');
      const prefix = `https://t.me/${BOT}?start=`;
      assert(typeof start.body.url === 'string' && start.body.url.startsWith(prefix), `url ${start.body.url}`);
      const token = start.body.url.slice(prefix.length);
      keep(sessions, token, start.body.session);
      bot.push({
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: TG_ID, type: 'private', username: TG_USER },
        from: { id: TG_ID, is_bot: false, first_name: 'Self', username: TG_USER },
        text: `/start ${token}`,
      });
      const message = await until('the code from the bot', 30_000, () => bot.sent.find((m) => m.chat_id === TG_ID && /\b\d{6}\b/.test(m.text)));
      const code = /\b(\d{6})\b/.exec(message.text)?.[1] as string;
      keep(codes, code);
      const ok = await call('POST', '/api/telegram/check', { address: charlie.address, session: start.body.session, code });
      same([ok.status, ok.body], [200, { verified: true }], 'check');
      await until('FieldAttested for the Telegram', 30_000, () => attested.find((e) => e.key?.typed === 'Telegram'));
      const entry = await attestation('Telegram');
      assert(entry !== undefined, 'no Telegram attestation in the profile');
      same([entry[1], entry[2].verdict, entry[2].method, entry[3]], [authority, 'Verified', { botChallenge: null }, true], 'Telegram attestation');
      await until('"Verified." in the chat', 10_000, () => bot.sent.find((m) => m.chat_id === TG_ID && m.text.startsWith('Verified.')));
    });

    await step('stale: the Email changes between the send and the check, the check answers "Your Email changed. Verify it again."', async () => {
      const before = attested.length;
      const sent = await call('POST', '/api/email/send', { address: charlie.address });
      same(sent.status, 200, 'send');
      keep(sessions, sent.body.session);
      const code = /code is (\d{6})/.exec(fakeMail.mails.at(-1)?.text ?? '')?.[1];
      assert(code !== undefined, 'no code in the second mail');
      keep(codes, code);
      await send(rpc, charlie, tx.identitee.setField({ Typed: 'Email' }, { Public: stringToHex('changed@example.org') }));
      const res = await call('POST', '/api/email/check', { address: charlie.address, session: sent.body.session, code });
      same([res.status, res.body.error], [409, 'Your Email changed. Verify it again.'], 'check');
      same(attested.length, before, 'FieldAttested events since the change');
      same((await attestation('Email'))?.[3], false, 'the old Email attestation is no longer valid');
    });

    await step('no secret in the output (agent phrase, keys, token, codes, link tokens, sessions, email); stdout is JSON lines', async () => {
      const all = [...secrets, ...codes.map((c, i): [string, string] => [`code ${i + 1}`, c]), ...sessions.map((s, i): [string, string] => [`token/session ${i + 1}`, s])];
      for (const line of service.lines) {
        for (const [what, value] of all) assert(!line.includes(value), `${what} is in the output: ${line.slice(0, 120)}`);
      }
      for (const line of service.outLines) JSON.parse(line);
      assert(service.outLines.length > 5, 'the verifier logged almost nothing');
      same([fakeMail.refused, bot.refused], [0, 0], 'calls refused by the fakes');
      same(fakeFailures, [], 'errors inside the fakes');
      assert(service.logs('attested').length === 2, 'expected two "attested" logs');
    });

    await step('SIGTERM stops the verifier cleanly (exit 0)', async () => {
      await service.stop('SIGTERM');
      same(service.exit, { code: 0, signal: null }, 'exit status');
      assert(service.logs('stopped').length === 1, 'no "stopped" log');
    });
  } catch (e) {
    console.log(`FAIL fatal: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e))}`);
    results.failed++;
  } finally {
    await verifier?.stop('SIGTERM', 10_000).catch(() => undefined);
    await (api as ApiPromise | undefined)?.disconnect().catch(() => undefined);
    await node?.stop('SIGTERM', 10_000).catch(() => undefined);
    await resend?.close().catch(() => undefined);
    await telegram?.close().catch(() => undefined);
    cleanupAll();
    report();
  }
  return results.failed === 0 ? 0 : 1;
}

// --- Entry point (last, so that everything above is initialised) ----------------------------------

if (process.argv.includes('--serve')) {
  serve().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.name : typeof e}\n`);
      process.exit(1);
    },
  );
} else {
  installGuard((why) => report(why));
  selftest().then(
    (code) => process.exit(code),
    (e: unknown) => {
      report(`fatal: ${e instanceof Error ? e.message : String(e)}`);
      cleanupAll();
      process.exit(1);
    },
  );
}
