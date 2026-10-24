// Matrix channel (method `MatrixChallenge`): the site gives a command for the bot; the person
// sends it to the bot in a direct message, the bot answers a 6-digit code; typing that code on the page
// that started the flow attests the field, if the Matrix account that sent the command is the one the
// identity holds.
//
//   POST /api/matrix/start {address, packet?}        -> { command: "!identitee <token>", bot: "<bot id>", session }
//   POST /api/matrix/check {address, session, code}  -> { verified: true }
//
// `packet` is only for a private Matrix (the packet inline or the id of /api/packet). The chain is the only
// source of the Matrix id: nothing the request says about it is read. The sender is the one the homeserver
// gives the event (`sender`), compared as a full `@local:server` id without case.
//
// The token, the session and the code work as `botcode.ts` says (shared with Telegram): a forwarded command
// gives its holder a code that is of no use to them, and the bot says nothing about who it would verify.
// The Matrix id is never kept: for a private field it is the value. Rate limits count a keyed digest of
// it; the rooms and the code waiting to be delivered are kept in memory only.
//
// The code is never posted in the room the command came from: whoever set that room up (a member invited
// but not joined yet, history shared with people who left) could read it later. The bot creates a room of
// its own, invites the sender only (a direct, encrypted room whose history is visible from joining), says
// in the command's room "I sent you your code in a private message.", and posts the code once the sender
// has joined that room and nobody else is in it. Refusals (another account, expired) are said in the
// command's room: they give nothing away.
//
// The bot (matrix-bot-sdk with its Rust crypto store, so that encrypted direct messages, Element's default,
// are read) logs in with MATRIX_USER / MATRIX_PASSWORD once and keeps the access token, the sync state and
// the crypto store under `<STATE_DIRECTORY>/matrix/` (mode 0700). It joins direct rooms it is invited to
// (an invite that is not a direct one, or to a room of more than two members, is left at once), answers in
// rooms of two members only (counting the invited ones; in a bigger room it says nothing and leaves),
// ignores its own messages, notices and anything sent before it started. Only event names, error classes,
// Matrix error codes and statuses are logged: never the password, the token, a Matrix id, a room or a text.
// The native crypto module is checked against its pinned SHA-256 (`native.ts`) before it is loaded.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { botCode, CODE_TTL_MS, codeMessage, HOUR, plain, record, TOO_MANY, VERIFIED, type Seen } from './botcode.ts';
import type { Channel } from './channels.ts';
import { hasEnv, type Config } from './config.ts';
import type { Ctx } from './ctx.ts';
import { mac } from './keyed.ts';
import type { Logger } from './log.ts';
import type { Request, Router } from './http.ts';
import { verifyNative } from './native.ts';
import { normalizeMatrixId, sameHandle } from './normalize.ts';

export { CODE_TTL_MS, MAX_ATTEMPTS, MAX_WRONG_PER_HOUR, START_TTL_MS } from './botcode.ts';

/** Commands with a token per sender and hour, help answers per sender and hour, joins per inviter and hour. */
const COMMANDS_PER_SENDER_HOUR = 10;
const HELPS_PER_SENDER_HOUR = 20;
const JOINS_PER_INVITER_HOUR = 20;
/** "I could not read your message" per sender and hour. */
const UNREADABLE_PER_SENDER_HOUR = 3;
/** A direct message: the person and the bot. */
const DM_MEMBERS = 2;

const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** At a stop, how long the answers still being made, and a login under way, are waited for. */
const STOP_WAIT_MS = 15_000;

const MXID = /^@[^:\s]+:[^\s]+$/;
const COMMAND = /^!identitee(?:\s+([\s\S]*))?$/i;

const EXPIRED = 'This command has expired. Start again from identit.ee.';
const FAILED = 'Something went wrong. Try again in a moment.';
const HELP = 'To verify your Matrix, start from your profile on identit.ee and choose Verify next to Matrix.';
const SENT_PRIVATELY = 'I sent you your code in a private message.';
const UNREADABLE = 'I could not read your message. Send it again, or send it in an unencrypted chat.';

/** The room the bot makes for one code: direct, encrypted, by invitation, its history visible from joining only. */
export const codeRoomOptions = (sender: string): Record<string, unknown> => ({
  preset: 'trusted_private_chat',
  is_direct: true,
  invite: [sender],
  initial_state: [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
  ],
});

/** What the channel needs of a Matrix client: matrix-bot-sdk's `MatrixClient`, or a fake in the tests. */
export interface MatrixClientLike {
  /** The bot's own id, as the homeserver says it. */
  readonly userId: string;
  /**
   * As matrix-bot-sdk emits them: `room.message` (decrypted when the room is encrypted), `room.invite`,
   * `room.event` (every timeline event, memberships included) and `room.failed_decryption`.
   */
  on(event: 'room.message' | 'room.invite' | 'room.event' | 'room.failed_decryption', listener: (roomId: string, event: unknown) => void): void;
  /** Resolves once syncing has begun. */
  start(): Promise<void>;
  stop(): void;
  sendNotice(roomId: string, text: string): Promise<unknown>;
  joinRoom(roomId: string): Promise<unknown>;
  leaveRoom(roomId: string): Promise<unknown>;
  /** How many members the room has, joined or invited. */
  memberCount(roomId: string): Promise<number>;
  /** Create a room (`codeRoomOptions`): its id. */
  createRoom(options: Record<string, unknown>): Promise<string>;
}

/** The native crypto module is missing, altered, or cannot load: retrying will not help. */
export class MatrixCryptoMissing extends Error {
  override readonly name = 'MatrixCryptoMissing';
  constructor(readonly reason: string) {
    super(`matrix crypto module ${reason}`);
  }
}

export interface MatrixLogin {
  homeserver: string;
  user: string;
  password: string;
  /** Where the session, the sync state and the crypto store live. */
  dir: string;
  log: Logger;
}

export type MatrixConnect = (login: MatrixLogin) => Promise<MatrixClientLike>;

export interface MatrixOptions {
  /** Log in and make the client (tests hand a fake; the default is matrix-bot-sdk, loaded only then). */
  connect?: MatrixConnect;
  /** The pause between two login attempts (tests skip it). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The channel, and `idle()` to wait until every event taken so far has been answered. */
export interface MatrixChannel extends Channel {
  idle(): Promise<void>;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const botId = (cfg: Config): string => (cfg.env.MATRIX_USER ?? '').trim();
const homeserverOf = (cfg: Config): string => (cfg.env.MATRIX_HOMESERVER ?? '').trim().replace(/\/+$/, '');

const mismatch = (seen: Seen, sender: string): string =>
  `This identity's Matrix is ${seen.private ? 'something else' : `@${plain(seen.value.replace(/\s+/g, '').replace(/^@/, ''))}`}, but you are ${plain(sender)}.`;

/** The fields of a failure that are safe to log: its class, and the status and Matrix error code it carries. */
function why(e: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { error: e instanceof Error ? e.name : typeof e };
  const r = record(e);
  const errcode = text(r?.errcode);
  if (errcode !== null && /^M_[A-Z_]{1,40}$/.test(errcode)) fields.errcode = errcode;
  const status = r?.statusCode;
  if (typeof status === 'number' && Number.isInteger(status)) fields.status = status;
  return fields;
}

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

// --- The real client -----------------------------------------------------------------------------------

/**
 * The SDK's logger: its messages can quote URLs, rooms and events, so only the module name and a Matrix error
 * code are kept. `M_NOT_FOUND` is what it gets, and logs as an error, for the missing `m.direct` at each start: info.
 */
export function sdkLogger(log: Logger) {
  const line = (level: 'warn' | 'error', module: string, args: unknown[]): void => {
    const errcode = args.map((a) => text(record(a)?.errcode)).find((c) => c !== null && c !== undefined && /^M_[A-Z_]{1,40}$/.test(c));
    log(errcode === 'M_NOT_FOUND' ? 'info' : level, 'matrix-sdk', { module: plain(module, 40), ...(errcode ? { errcode } : {}) });
  };
  return {
    info: (..._args: unknown[]) => undefined,
    debug: (..._args: unknown[]) => undefined,
    trace: (..._args: unknown[]) => undefined,
    warn: (module: string, ...args: unknown[]) => line('warn', module, args),
    error: (module: string, ...args: unknown[]) => line('error', module, args),
  };
}

/** `process.emitWarning` without DEP0060 (`util._extend`, used by the SDK's `request`); every other warning goes through. */
export function withoutDep0060(emit: typeof process.emitWarning): typeof process.emitWarning {
  return function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const options = rest[0];
    const code = typeof options === 'object' && options !== null ? (options as { code?: unknown }).code : rest[1];
    if (code === 'DEP0060' || (warning instanceof Error && (warning as { code?: unknown }).code === 'DEP0060')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
}

let warningsFiltered = false;

interface Session {
  homeserver: string;
  user: string;
  accessToken: string;
}

function readSession(path: string): Session | null {
  try {
    const s = record(JSON.parse(readFileSync(path, 'utf8')));
    if (s !== null && typeof s.homeserver === 'string' && typeof s.user === 'string' && typeof s.accessToken === 'string' && s.accessToken !== '') {
      return { homeserver: s.homeserver, user: s.user, accessToken: s.accessToken };
    }
  } catch {
    // none, or unreadable: log in again
  }
  return null;
}

/**
 * matrix-bot-sdk with the Rust crypto store. Logs in once and keeps the access token (mode 0600); a token the
 * homeserver no longer knows is dropped, and the next attempt logs in again with a new device and a new crypto store.
 */
export const connectMatrix: MatrixConnect = async (login) => {
  // The binary downloaded by the module's postinstall must be the pinned one, before anything loads it.
  const native = verifyNative();
  if (!native.ok) throw new MatrixCryptoMissing(native.reason);
  if (!warningsFiltered) {
    process.emitWarning = withoutDep0060(process.emitWarning);
    warningsFiltered = true;
  }
  // Loaded here only: the native crypto module is needed only when the channel runs.
  let rust: typeof import('@matrix-org/matrix-sdk-crypto-nodejs');
  try {
    rust = await import('@matrix-org/matrix-sdk-crypto-nodejs');
  } catch {
    throw new MatrixCryptoMissing('unloadable');
  }
  const sdk = await import('matrix-bot-sdk');
  sdk.LogService.setLevel(sdk.LogLevel.WARN);
  sdk.LogService.setLogger(sdkLogger(login.log));

  mkdirSync(login.dir, { recursive: true, mode: 0o700 });
  chmodSync(login.dir, 0o700);
  const sessionFile = join(login.dir, 'session.json');
  const cryptoDir = join(login.dir, 'crypto');
  const syncFile = join(login.dir, 'sync.json');
  let session = readSession(sessionFile);
  if (session !== null && (session.homeserver !== login.homeserver || session.user.toLowerCase() !== login.user.toLowerCase())) session = null;
  if (session === null) {
    // A new login is a new device: the crypto store of the old one would not match it.
    rmSync(cryptoDir, { recursive: true, force: true });
    rmSync(syncFile, { force: true });
    const fresh = await new sdk.MatrixAuth(login.homeserver).passwordLogin(login.user, login.password, 'identitee verifier');
    session = { homeserver: login.homeserver, user: login.user, accessToken: fresh.accessToken };
    writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
    chmodSync(sessionFile, 0o600);
    login.log('info', 'matrix-logged-in');
  }
  const client = new sdk.MatrixClient(
    login.homeserver,
    session.accessToken,
    new sdk.SimpleFsStorageProvider(syncFile),
    new sdk.RustSdkCryptoStorageProvider(cryptoDir, rust.StoreType.Sqlite),
  );
  let userId: string;
  try {
    userId = await client.getUserId();
  } catch (e) {
    if (record(e)?.errcode === 'M_UNKNOWN_TOKEN') rmSync(sessionFile, { force: true });
    throw e;
  }
  return {
    userId,
    on: (event, listener) => void client.on(event, listener),
    start: async () => {
      await client.start();
    },
    stop: () => client.stop(),
    sendNotice: (roomId, words) => client.sendNotice(roomId, words),
    joinRoom: (roomId) => client.joinRoom(roomId),
    leaveRoom: (roomId) => client.leaveRoom(roomId),
    memberCount: async (roomId) => (await client.getRoomMembers(roomId)).filter((m) => m.membership === 'join' || m.membership === 'invite').length,
    createRoom: (options) => client.createRoom(options),
  };
};

// --- The channel ---------------------------------------------------------------------------------------

export function matrixChannel(options: MatrixOptions = {}): MatrixChannel {
  const connect = options.connect ?? connectMatrix;
  const sleep = options.sleep ?? sleepFor;
  const flow = botCode<Record<never, never>>({ kind: 'Matrix', prefix: 'matrix', method: 'MatrixChallenge', normalize: normalizeMatrixId });
  let client: MatrixClientLike | undefined;
  let self = '';
  let startedAt = Number.POSITIVE_INFINITY;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  /** The room the bot made for each pending code, by the code's row id: where "Verified." is said. Memory only. */
  const rooms = new Map<string, { room: string; expires: number }>();
  /** Codes waiting for their sender to join the room the bot made, by that room. Memory only, never in the database. */
  const deliveries = new Map<string, { code: string; sender: string; expires: number }>();
  const prune = (now: number): void => {
    for (const [id, kept] of rooms) if (kept.expires <= now) rooms.delete(id);
    for (const [id, kept] of deliveries) if (kept.expires <= now) deliveries.delete(id);
  };
  /** Answers being made. */
  const inflight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    const tracked: Promise<void> = work.then(() => {
      inflight.delete(tracked);
    });
    inflight.add(tracked);
  };
  /** A digest of a Matrix id for the rate limits: the id itself is never stored. */
  const digest = (ctx: Ctx, id: string): string => mac(flow.keyOf(ctx), 'sender', normalizeMatrixId(id)).toString('base64url');

  const leave = (ctx: Ctx, api: MatrixClientLike, room: string): Promise<unknown> =>
    api.leaveRoom(room).catch((e: unknown) => ctx.log('warn', 'matrix-api-failed', { action: 'leave', ...why(e) }));

  /** Say something in a room: a failure is logged and goes no further. */
  async function say(ctx: Ctx, api: MatrixClientLike, room: string, words: string): Promise<void> {
    try {
      await api.sendNotice(room, words);
    } catch (e) {
      ctx.log('warn', 'matrix-api-failed', { action: 'send', ...why(e) });
    }
  }

  // --- The site's requests ---

  async function start(ctx: Ctx, req: Request): Promise<unknown> {
    const { token, session } = await flow.start(ctx, req);
    return { command: `!identitee ${token}`, bot: botId(ctx.cfg), session };
  }

  async function check(ctx: Ctx, req: Request): Promise<unknown> {
    const { row } = await flow.check(ctx, req);
    const where = rooms.get(row);
    rooms.delete(row);
    if (client !== undefined && where !== undefined) track(say(ctx, client, where.room, VERIFIED));
    return { verified: true };
  }

  // --- The bot ---

  async function onCommand(ctx: Ctx, api: MatrixClientLike, room: string, sender: string, payload: string): Promise<void> {
    const reply = (words: string): Promise<void> => say(ctx, api, room, words);
    try {
      const found = /\s/.test(payload) ? null : flow.lookup(ctx, payload);
      if (found === null) return await reply(EXPIRED);
      const { row } = found;
      // Nothing is spent until the code can be given: another account leaves the command good.
      const seen = await flow.current(ctx, row.address, row.packet, false);
      if (typeof seen === 'string') return await reply(seen);
      if (seen.commitment.toLowerCase() !== row.commitment.toLowerCase()) return await reply(flow.stale);
      if (!sameHandle('Matrix', seen.value, sender)) {
        ctx.log('info', 'matrix-refused', { who: row.address, reason: 'other-account' });
        return await reply(mismatch(seen, sender));
      }
      // A room of its own for the code, the sender its only guest: nothing of the command's room is reused.
      const privateRoom = await api.createRoom(codeRoomOptions(sender));
      const issued = flow.issue(ctx, found, seen, sender, {});
      if (issued === null) {
        await leave(ctx, api, privateRoom);
        return await reply(EXPIRED);
      }
      const now = ctx.now();
      prune(now);
      rooms.set(issued.row, { room: privateRoom, expires: now + CODE_TTL_MS });
      deliveries.set(privateRoom, { code: issued.code, sender: normalizeMatrixId(sender), expires: now + CODE_TTL_MS });
      await reply(SENT_PRIVATELY);
    } catch (e) {
      ctx.log('error', 'matrix-failed', { step: 'command', ...why(e) });
      await reply(FAILED);
    }
  }

  async function onMessage(ctx: Ctx, api: MatrixClientLike, room: string, raw: unknown): Promise<void> {
    const event = record(raw);
    const content = record(event?.content);
    const sender = text(event?.sender);
    const sent = event?.origin_server_ts;
    if (event === null || content === null || sender === null || !MXID.test(sender)) return;
    // Its own messages, and anything from before it started (a first sync replays the history).
    if (sender.toLowerCase() === self || typeof sent !== 'number' || sent < startedAt) return;
    // Notices are what bots send: answering them could start a loop between bots.
    if (content.msgtype !== 'm.text') return;
    const command = COMMAND.exec((text(content.body) ?? '').trim());
    if (command === null) return;
    const payload = (command[1] ?? '').trim();
    // The limits come first: a flood of commands must not turn into calls to the homeserver.
    const who = digest(ctx, sender);
    if (payload === '') {
      if (!ctx.store.hit('matrix-help', who, HELPS_PER_SENDER_HOUR, HOUR)) return;
    } else if (!ctx.store.hit('matrix-user', who, COMMANDS_PER_SENDER_HOUR, HOUR)) {
      // Said once an hour: more would only feed whoever keeps asking.
      if (ctx.store.hit('matrix-notice', who, 1, HOUR) && (await api.memberCount(room)) <= DM_MEMBERS) await say(ctx, api, room, TOO_MANY);
      return;
    }
    // Direct messages only (invited members count): the bot does not talk in a bigger room.
    if ((await api.memberCount(room)) > DM_MEMBERS) {
      ctx.log('info', 'matrix-left-room', { reason: 'not-a-direct-message' });
      await leave(ctx, api, room);
      return;
    }
    if (payload === '') return say(ctx, api, room, HELP);
    await onCommand(ctx, api, room, sender, payload);
  }

  /** The sender joined the room the bot made for their code: the code is posted there, if nobody else is in it. */
  async function onEvent(ctx: Ctx, api: MatrixClientLike, room: string, raw: unknown): Promise<void> {
    const event = record(raw);
    if (event?.type !== 'm.room.member' || record(event.content)?.membership !== 'join') return;
    const delivery = deliveries.get(room);
    const member = text(event.state_key);
    if (delivery === undefined || member === null || normalizeMatrixId(member) !== delivery.sender) return;
    deliveries.delete(room);
    if (delivery.expires <= ctx.now()) return;
    if ((await api.memberCount(room)) > DM_MEMBERS) {
      ctx.log('info', 'matrix-left-room', { reason: 'not-a-direct-message' });
      await leave(ctx, api, room);
      return;
    }
    // Delivered only once the homeserver took it: a failed send is said in the journal as such (the
    // error's class), never as a delivery; the person sees no code and asks for a new one.
    try {
      await api.sendNotice(room, codeMessage(delivery.code));
    } catch (e) {
      ctx.log('warn', 'matrix-code-send-failed', why(e));
      return;
    }
    ctx.log('info', 'matrix-code-delivered');
  }

  async function onUndecryptable(ctx: Ctx, api: MatrixClientLike, room: string, raw: unknown): Promise<void> {
    const event = record(raw);
    const sender = text(event?.sender);
    const sent = event?.origin_server_ts;
    if (sender === null || !MXID.test(sender) || sender.toLowerCase() === self || typeof sent !== 'number' || sent < startedAt) return;
    ctx.log('info', 'matrix-undecryptable', { error: 'DecryptionError' });
    if (ctx.store.hit('matrix-unreadable', digest(ctx, sender), UNREADABLE_PER_SENDER_HOUR, HOUR)) await say(ctx, api, room, UNREADABLE);
  }

  async function onInvite(ctx: Ctx, api: MatrixClientLike, room: string, raw: unknown): Promise<void> {
    const inviter = text(record(raw)?.sender);
    if (inviter === null || inviter.toLowerCase() === self) return;
    if (!ctx.store.hit('matrix-invite', digest(ctx, inviter), JOINS_PER_INVITER_HOUR, HOUR)) return;
    // Only direct rooms: an invite that is not one is declined at once.
    if (record(record(raw)?.content)?.is_direct !== true) {
      ctx.log('info', 'matrix-left-room', { reason: 'not-a-direct-invite' });
      await leave(ctx, api, room);
      return;
    }
    try {
      await api.joinRoom(room);
    } catch (e) {
      ctx.log('warn', 'matrix-api-failed', { action: 'join', ...why(e) });
      return;
    }
    if ((await api.memberCount(room)) > DM_MEMBERS) {
      ctx.log('info', 'matrix-left-room', { reason: 'not-a-direct-message' });
      await leave(ctx, api, room);
    }
  }

  /** Each event is answered on its own, so that one slow answer does not hold the others. */
  function dispatch(ctx: Ctx, work: () => Promise<void>): void {
    track(
      work().catch((e: unknown) => {
        ctx.log('error', 'matrix-event-failed', why(e));
      }),
    );
  }

  /** Log in and start syncing, again after a pause while it fails. */
  async function run(ctx: Ctx, signal: AbortSignal): Promise<void> {
    const login: MatrixLogin = { homeserver: homeserverOf(ctx.cfg), user: botId(ctx.cfg), password: ctx.cfg.env.MATRIX_PASSWORD ?? '', dir: join(ctx.cfg.stateDir, 'matrix'), log: ctx.log };
    let pause = 0;
    while (!signal.aborted) {
      let api: MatrixClientLike | undefined;
      try {
        api = await connect(login);
        if (signal.aborted) return;
        const live = api;
        self = live.userId.toLowerCase();
        live.on('room.message', (room, event) => dispatch(ctx, () => onMessage(ctx, live, room, event)));
        live.on('room.invite', (room, event) => dispatch(ctx, () => onInvite(ctx, live, room, event)));
        live.on('room.event', (room, event) => dispatch(ctx, () => onEvent(ctx, live, room, event)));
        live.on('room.failed_decryption', (room, event) => dispatch(ctx, () => onUndecryptable(ctx, live, room, event)));
        client = live;
        await live.start();
        if (signal.aborted) {
          live.stop();
          return;
        }
        ctx.log('info', 'matrix-ready');
        return;
      } catch (e) {
        client = undefined;
        api?.stop();
        if (signal.aborted) return;
        if (e instanceof MatrixCryptoMissing) {
          // A missing or altered binary does not fix itself: say it once, clearly, and stop.
          ctx.log('error', 'matrix-crypto-missing', { reason: e.reason, fix: 'run npm ci, then npm run verify:native' });
          return;
        }
        pause = pause === 0 ? BACKOFF_FIRST_MS : Math.min(pause * 2, BACKOFF_MAX_MS);
        ctx.log('warn', 'matrix-connect-failed', { ...why(e), retryMs: pause });
        await sleep(pause, signal);
      }
    }
  }

  const idle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };

  return {
    name: 'matrix',
    enabled: (cfg) => hasEnv(cfg, 'MATRIX_HOMESERVER', 'MATRIX_USER', 'MATRIX_PASSWORD') && MXID.test(botId(cfg)) && /^https?:\/\/[^\s/]+/.test(homeserverOf(cfg)),
    register(router: Router, ctx: Ctx): void {
      router.route('POST', '/api/matrix/start', (req) => start(ctx, req));
      router.route('POST', '/api/matrix/check', (req) => check(ctx, req));
    },
    publicInfo: (cfg) => ({ matrixBot: botId(cfg) }),
    /** Make the key (an unwritable state directory stops the service), then log in and sync in the background: it returns at once. */
    async start(ctx: Ctx): Promise<void> {
      flow.keyOf(ctx);
      startedAt = ctx.now();
      controller = new AbortController();
      running = run(ctx, controller.signal).catch((e: unknown) => ctx.log('error', 'matrix-stopped', why(e)));
    },
    /** Stop syncing and the login retries, then wait (a little) for the answers being made. */
    async stop(): Promise<void> {
      controller?.abort();
      client?.stop();
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      });
      await Promise.race([Promise.all([running, idle()]), patience]);
      clearTimeout(timer);
    },
    idle,
  };
}
