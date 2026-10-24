// Telegram channel (method `BotChallenge`): the person opens a t.me link from the site and
// taps Start in the bot, which answers a 6-digit code; typing that code on the page that started the flow
// attests the field, if the Telegram account that tapped Start is the one the identity holds.
//
//   POST /api/telegram/start {address, packet?}        -> { url: "https://t.me/<bot>?start=<token>", session }
//   POST /api/telegram/check {address, session, code}  -> { verified: true }
//
// `packet` is only for a private Telegram (the packet inline or the id of /api/packet). The chain is the
// only source of the username: nothing the request says about it is read.
//
// The link, the session and the code work as `botcode.ts` says (shared with Matrix): a forwarded link
// gives its holder a code that is of no use to them, and the bot says nothing about who it would verify.
// The Telegram username is never kept: for a private field it is the value.
//
// The bot long-polls `getUpdates` (no webhook, `deleteWebhook` once at start), answers private chats only,
// and keeps its offset in the store. The token of the bot is in the URL path of every call: only method
// names and status codes are logged, never an error's message, a name, a text or a Telegram id.

import { botCode, codeMessage, HOUR, plain, record, TOO_MANY, VERIFIED, type Seen } from './botcode.ts';
import type { Channel } from './channels.ts';
import { hasEnv, type Config } from './config.ts';
import type { Ctx } from './ctx.ts';
import type { Request, Router } from './http.ts';
import { normalizeHandle, sameHandle } from './normalize.ts';

export { CODE_TTL_MS, MAX_ATTEMPTS, MAX_WRONG_PER_HOUR, START_TTL_MS } from './botcode.ts';

const OFFSET_KIND = 'telegram';
const OFFSET_ID = 'offset';
/** Telegram keeps unacknowledged updates 24 hours: a longer silence loses nothing the offset would save. */
const OFFSET_TTL_MS = 7 * 24 * HOUR;
/** `/start <link>` per Telegram user and hour, and replies to messages that are not a link. */
const STARTS_PER_USER_HOUR = 10;
const HELPS_PER_USER_HOUR = 20;

const API_BASE = 'https://api.telegram.org';
const POLL_SECONDS = 30;
const CALL_TIMEOUT_MS = 15_000;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** A poll that gave nothing usable and came back sooner than this is followed by a pause: a long poll never does. */
const MIN_POLL_MS = 1000;
/** At a stop, how long the answers still being made are waited for. */
const STOP_WAIT_MS = 15_000;

const BOT_NAME = /^[A-Za-z0-9_]{3,64}$/;
const COMMAND = /^\/(start|help)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/;

const EXPIRED = 'This link expired. Start again from identit.ee.';
const NO_USERNAME = 'Set a Telegram username first, then try again.';
const FAILED = 'Something went wrong. Try again in a moment.';
const HELP = 'To verify your Telegram, start from your profile on identit.ee and choose Verify next to Telegram.';

export interface TelegramOptions {
  /** For every call to the Bot API (tests stub it). */
  fetch?: typeof fetch;
  /** The Bot API's address, without `/bot<token>` (tests point it at a fake). */
  apiBase?: string;
  /** The pause between two retries after an API error (tests skip it). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The least a poll that gave nothing usable may take before the next one starts (tests set 0). */
  minPollMs?: number;
}

/** The channel, and `idle()` to wait until every update taken so far has been answered. */
export interface TelegramChannel extends Channel {
  idle(): Promise<void>;
}

const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const botName = (cfg: Config): string => (cfg.env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');

const mismatch = (seen: Seen, username: string): string =>
  `This identity's Telegram is ${seen.private ? 'something else' : `@${plain(seen.value.replace(/^\s*@/, ''))}`}, but you are @${plain(username)}.`;

// --- The Bot API ---------------------------------------------------------------------------------------

/** A failed call: its method and status (or the class of the network error), never what the API said. */
class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | null,
    readonly retryAfter: number | null,
    readonly kind: string,
  ) {
    super(`${method} failed`);
  }
}

/** The fields of a failure that are safe to log. */
const why = (e: unknown): Record<string, unknown> =>
  e instanceof ApiError ? { method: e.method, ...(e.status !== null ? { status: e.status } : { error: e.kind }) } : { error: e instanceof Error ? e.name : typeof e };

interface Api {
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  /** The same, for answers to people: a failure is logged and goes no further. */
  say(method: string, params: Record<string, unknown>): Promise<void>;
}

function makeApi(ctx: Ctx, options: TelegramOptions): Api {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.apiBase ?? API_BASE).replace(/\/+$/, '');
  const token = ctx.cfg.env.TELEGRAM_BOT_TOKEN ?? '';
  async function call(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const limit = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
      });
    } catch (e) {
      throw new ApiError(method, null, null, e instanceof Error ? e.name : 'unknown');
    }
    // The answer may quote what was sent: read, never logged.
    const body = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      json = record(JSON.parse(body));
    } catch {
      json = null;
    }
    if (res.ok && json?.ok === true) return json.result;
    throw new ApiError(method, integer(json?.error_code) ?? res.status, integer(record(json?.parameters)?.retry_after), 'status');
  }
  return {
    call,
    async say(method, params) {
      try {
        await call(method, params);
      } catch (e) {
        ctx.log('warn', 'telegram-api-failed', why(e));
      }
    },
  };
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

/** The pause after a failure: 1 s, then twice the last one up to 60 s, and at least what Telegram asked for. */
function nextPause(last: number, e: unknown): number {
  const doubled = last === 0 ? BACKOFF_FIRST_MS : Math.min(last * 2, BACKOFF_MAX_MS);
  const asked = e instanceof ApiError && e.retryAfter !== null ? Math.min(e.retryAfter * 1000, BACKOFF_MAX_MS) : 0;
  return Math.max(doubled, asked);
}

// --- The channel ---------------------------------------------------------------------------------------

export function telegramChannel(options: TelegramOptions = {}): TelegramChannel {
  const sleep = options.sleep ?? sleepFor;
  const minPoll = options.minPollMs ?? MIN_POLL_MS;
  let bot: Api | undefined;
  let controller: AbortController | undefined;
  let polling: Promise<void> | undefined;
  const flow = botCode<{ user: number }>({ kind: 'Telegram', prefix: 'telegram', method: 'BotChallenge', normalize: normalizeHandle });
  /** Answers being made. */
  const inflight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    const tracked: Promise<void> = work.then(() => {
      inflight.delete(tracked);
    });
    inflight.add(tracked);
  };

  // --- The site's requests ---

  async function start(ctx: Ctx, req: Request): Promise<unknown> {
    const { token, session } = await flow.start(ctx, req);
    return { url: `https://t.me/${botName(ctx.cfg)}?start=${token}`, session };
  }

  async function check(ctx: Ctx, req: Request): Promise<unknown> {
    const { pending } = await flow.check(ctx, req);
    if (bot !== undefined) track(bot.say('sendMessage', { chat_id: pending.user, text: VERIFIED, link_preview_options: { is_disabled: true } }));
    return { verified: true };
  }

  // --- The bot ---

  async function onStart(ctx: Ctx, api: Api, chatId: number, userId: number, username: string | null, payload: string): Promise<void> {
    const user = String(userId);
    const reply = (words: string): Promise<void> => api.say('sendMessage', { chat_id: chatId, text: words, link_preview_options: { is_disabled: true } });
    if (!ctx.store.hit('telegram-user', user, STARTS_PER_USER_HOUR, HOUR)) {
      // Said once an hour: more would only feed whoever keeps asking.
      if (ctx.store.hit('telegram-notice', user, 1, HOUR)) await reply(TOO_MANY);
      return;
    }
    try {
      const found = flow.lookup(ctx, payload);
      if (found === null) return await reply(EXPIRED);
      const { row } = found;
      // Nothing is spent until the code can be given: a missing username or another account leaves the link good.
      if (username === null || username === '') return await reply(NO_USERNAME);
      const seen = await flow.current(ctx, row.address, row.packet, false);
      if (typeof seen === 'string') return await reply(seen);
      if (seen.commitment.toLowerCase() !== row.commitment.toLowerCase()) return await reply(flow.stale);
      if (!sameHandle('Telegram', seen.value, username)) {
        ctx.log('info', 'telegram-refused', { who: row.address, reason: 'other-account' });
        return await reply(mismatch(seen, username));
      }
      const issued = flow.issue(ctx, found, seen, username, { user: userId });
      if (issued === null) return await reply(EXPIRED);
      await reply(codeMessage(issued.code));
    } catch (e) {
      ctx.log('error', 'telegram-failed', { step: 'start', ...why(e) });
      await reply(FAILED);
    }
  }

  async function onMessage(ctx: Ctx, api: Api, message: Record<string, unknown>): Promise<void> {
    const chat = record(message.chat);
    const from = record(message.from);
    const chatId = integer(chat?.id);
    const userId = integer(from?.id);
    // Private chats only: there the chat is the user's own, and a group's messages are nobody's code.
    if (chat?.type !== 'private' || chatId === null || userId === null || chatId !== userId || from?.is_bot === true) return;
    const command = COMMAND.exec((text(message.text) ?? '').trim());
    if (command === null) return;
    if (command[2] !== undefined && command[2].toLowerCase() !== botName(ctx.cfg).toLowerCase()) return;
    const payload = (command[3] ?? '').trim();
    if (command[1] === 'start' && payload !== '') return onStart(ctx, api, chatId, userId, text(from?.username), payload);
    if (!ctx.store.hit('telegram-help', String(userId), HELPS_PER_USER_HOUR, HOUR)) return;
    await api.say('sendMessage', { chat_id: chatId, text: HELP, link_preview_options: { is_disabled: true } });
  }

  /** Each update is answered on its own, so that one slow answer does not hold the others. */
  function dispatch(ctx: Ctx, api: Api, update: Record<string, unknown>): void {
    track(
      (async (): Promise<void> => {
        try {
          const message = record(update.message);
          if (message !== null) await onMessage(ctx, api, message);
        } catch (e) {
          ctx.log('error', 'telegram-update-failed', { error: e instanceof Error ? e.name : typeof e });
        }
      })(),
    );
  }

  /** Once at start: a webhook left on the bot would answer every poll with 409, and the bot's name is checked against the token's. */
  async function prepare(ctx: Ctx, api: Api, signal: AbortSignal): Promise<void> {
    try {
      await api.call('deleteWebhook', {}, signal);
    } catch (e) {
      if (!signal.aborted) ctx.log('warn', 'telegram-api-failed', why(e));
    }
    try {
      const actual = text(record(await api.call('getMe', {}, signal))?.username);
      if (actual !== null && actual.toLowerCase() !== botName(ctx.cfg).toLowerCase()) {
        ctx.log('warn', 'telegram-bot-name-mismatch', { configured: botName(ctx.cfg), actual });
      }
    } catch (e) {
      if (!signal.aborted) ctx.log('warn', 'telegram-api-failed', why(e));
    }
  }

  async function poll(ctx: Ctx, api: Api, signal: AbortSignal, state: { offset: number }): Promise<void> {
    await prepare(ctx, api, signal);
    let pause = 0;
    while (!signal.aborted) {
      let updates: unknown[];
      const began = Date.now();
      try {
        const result = await api.call(
          'getUpdates',
          { ...(state.offset > 0 ? { offset: state.offset } : {}), timeout: POLL_SECONDS, allowed_updates: ['message'] },
          signal,
          (POLL_SECONDS + 15) * 1000,
        );
        if (!Array.isArray(result)) throw new ApiError('getUpdates', null, null, 'shape');
        updates = result;
      } catch (e) {
        if (signal.aborted) break;
        pause = nextPause(pause, e);
        ctx.log('warn', 'telegram-poll-failed', { ...why(e), retryMs: pause });
        await sleep(pause, signal);
        continue;
      }
      pause = 0;
      let top = -1;
      for (const raw of updates) {
        const update = record(raw);
        const id = integer(update?.update_id);
        if (update === null || id === null) continue;
        top = Math.max(top, id);
        dispatch(ctx, api, update);
      }
      if (top >= 0) {
        // At most once: a crash while answering loses that update, the person taps again; a poison one is never replayed.
        state.offset = top + 1;
        try {
          ctx.store.put(OFFSET_KIND, OFFSET_ID, { offset: state.offset }, OFFSET_TTL_MS);
        } catch (e) {
          ctx.log('error', 'telegram-offset-failed', { error: e instanceof Error ? e.name : typeof e });
        }
      } else {
        // Nothing usable and back sooner than a long poll can be: a misbehaving API must not make this loop spin.
        const wait = minPoll - (Date.now() - began);
        if (wait > 0) await sleep(wait, signal);
      }
    }
  }

  const idle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };

  return {
    name: 'telegram',
    enabled: (cfg) => hasEnv(cfg, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME') && BOT_NAME.test(botName(cfg)),
    register(router: Router, ctx: Ctx): void {
      router.route('POST', '/api/telegram/start', (req) => start(ctx, req));
      router.route('POST', '/api/telegram/check', (req) => check(ctx, req));
    },
    publicInfo: (cfg) => ({ telegramBot: botName(cfg) }),
    /** Make the key (an unwritable state directory stops the service, not the first request) and begin polling in the background: it returns at once. */
    async start(ctx: Ctx): Promise<void> {
      flow.keyOf(ctx);
      const api = (bot = makeApi(ctx, options));
      const state = { offset: ctx.store.get<{ offset: number }>(OFFSET_KIND, OFFSET_ID)?.offset ?? 0 };
      controller = new AbortController();
      polling = poll(ctx, api, controller.signal, state).catch((e: unknown) => ctx.log('error', 'telegram-poll-stopped', { error: e instanceof Error ? e.name : typeof e }));
    },
    /** Abort the long poll, then wait (a little) for the answers being made. */
    async stop(): Promise<void> {
      controller?.abort();
      await polling;
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      });
      await Promise.race([idle(), patience]);
      clearTimeout(timer);
    },
    idle,
  };
}
