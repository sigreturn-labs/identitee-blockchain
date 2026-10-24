// The flow the bot channels share (Telegram, Matrix): the site asks for a start token, the person hands
// it to the bot from the account their identity names, the bot answers a 6-digit code, and typing that
// code on the page that started the flow attests the field.
//
//   start  {address, packet?}         -> token (the bot takes it) and session (the page keeps it)
//   bot    token + the account seen   -> code (said to that account only)
//   check  {address, session, code}   -> attestation
//
// A token can be forwarded (someone sets their field to the victim's account, then sends the victim
// their token), so the bot handing a code proves nothing by itself, and it says nothing about who it
// would verify. What attests is the code, and only the browser that started the flow holds the `session`
// (16 random bytes, kept hashed with the token) the code is checked under: a code that reaches another
// person is useless to them, and a code typed under another session finds nothing.
//
// The token is 16 random bytes (base64url), kept 10 minutes under its SHA-256 with the address, the
// field's commitment at the start, the hashed session and, for a private field, the id of its packet (never
// the value), and taken once. The pending code keeps its keyed hash, a keyed digest of the account's
// handle, the commitment of the start and the packet id. The check refuses a wrong code (5 tries per code,
// 10 wrong codes per hour and account), reads the field again and refuses it as stale when its commitment
// is not the one of the start, and the chain refuses the attestation too if it changed meanwhile
// (`StaleCommitment`).
//
// Hashes and row ids are HMACs under a key generated once and kept in `<STATE_DIRECTORY>/<prefix>.key`
// (mode 0600), outside the database: whoever reads `verifier.db` can brute-force no live code (10^6
// values) and learn no account name. The account name itself is never kept: for a private field it is the value.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { canonicalAddress, explain, FIELD_LABELS, type FieldKey, type FieldKind, type Method } from './chain.ts';
import { startAllowed } from './channels.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Request } from './http.ts';
import { loadKey, mac } from './keyed.ts';
import { resolvePrivate } from './packet.ts';

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** How long a token from the site, and the code the bot answers, stay good. */
export const START_TTL_MS = 10 * MINUTE;
export const CODE_TTL_MS = 10 * MINUTE;
/** Guesses per code. */
export const MAX_ATTEMPTS = 5;
/** Wrong codes per account and hour, whatever the codes they were for. */
export const MAX_WRONG_PER_HOUR = 10;

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const SESSION = /^[A-Za-z0-9_-]{22}$/;

export const TOO_MANY = 'Too many attempts. Try again later.';
export const VERIFIED = 'Verified. You can go back to identit.ee.';
export const codeMessage = (code: string): string =>
  `Your identitee code is ${code}. Type it on identit.ee where you started. If you did not start this, ignore this message and never share the code.`;

/** What a token from the site keeps: never a private value, never the token or the session. */
export interface StartRow {
  address: string;
  field: FieldKind;
  commitment: string;
  /** SHA-256 (base64url) of the session only the browser that started the flow holds. */
  session: string;
  /** The id of the packet of a private field. */
  packet?: string;
}

/** What a pending code keeps: its keyed hash, never the code, the account name or the private value; plus what the channel adds. */
export type Pending<Extra extends object> = {
  hash: string;
  /** Keyed digest of the account's normalized handle. */
  handle: string;
  commitment: string;
  packet?: string;
  /** Milliseconds since the epoch, to put the row back with its remaining time. */
  expires: number;
} & Extra;

/** The field as it is now. */
export interface Seen {
  value: string;
  private: boolean;
  commitment: string;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url');
const random = (): string => randomBytes(16).toString('base64url');
export const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A name from the chain or from a chat service as one short plain line: no control or direction characters. */
export function plain(value: string | null | undefined, max = 80): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : clean;
}

export interface BotCodeOptions {
  /** The field the flow attests. */
  kind: FieldKind;
  /** Names its rows (`<prefix>-start`, `<prefix>-code`), its buckets, its log events and its key file. */
  prefix: string;
  method: Method;
  /** How a handle is compared: the digest kept with the code is made of it. */
  normalize: (handle: string) => string;
}

export interface BotCode<Extra extends object> {
  readonly key: FieldKey;
  /** The sentence for a field that changed since the start. */
  readonly stale: string;
  /** The channel's key (made on first use: call it at start so that an unwritable directory stops the service). */
  keyOf(ctx: Ctx): Buffer;
  /**
   * The field as it is now, or the sentence that says why not. From the site a private field needs its packet;
   * from the bot and the check a packet is the one the start kept (a field private now but not at the start is a changed one).
   */
  current(ctx: Ctx, address: string, packet: unknown, fromSite: boolean): Promise<Seen | string>;
  /** `POST .../start`: the token for the bot and the session for the page. */
  start(ctx: Ctx, req: Request): Promise<{ token: string; session: string }>;
  /** The start a token stands for, without spending it; null when malformed, unknown or expired. */
  lookup(ctx: Ctx, token: string): { id: string; row: StartRow } | null;
  /**
   * Spend the start and keep a pending code for `handle` (the account seen by the bot): the code, or null when
   * the start was spent meanwhile. Also gives the id of the pending row, which the check reports.
   */
  issue(ctx: Ctx, found: { id: string; row: StartRow }, seen: Seen, handle: string, extra: Extra): { code: string; row: string } | null;
  /** `POST .../check`: attested, or an HttpError with the sentence. Gives the pending code that was used and its row id. */
  check(ctx: Ctx, req: Request): Promise<{ address: string; row: string; pending: Pending<Extra> }>;
}

export function botCode<Extra extends object>(options: BotCodeOptions): BotCode<Extra> {
  const KEY: FieldKey = { Typed: options.kind };
  const label = FIELD_LABELS[options.kind];
  const START = `${options.prefix}-start`;
  const CODE = `${options.prefix}-code`;
  const WRONG = `${options.prefix}-wrong`;
  const ADD_FIRST = `Add your ${label} to your identity first.`;
  const UNLOCK = `Unlock your identity to verify a private ${label}.`;
  const STALE = explain(KEY, { ok: false, reason: 'stale' });
  const expired = (): HttpError => new HttpError(400, 'This code has expired. Ask for a new one.');
  let root: Buffer | undefined;
  const keyOf = (ctx: Ctx): Buffer => (root ??= loadKey(ctx.cfg.stateDir, `${options.prefix}.key`));
  const addressOf = (body: Record<string, unknown>): string => {
    const given = body.address;
    const address = typeof given === 'string' ? canonicalAddress(given) : null;
    if (address === null) throw new HttpError(400, 'This is not a valid account address.');
    return address;
  };

  async function current(ctx: Ctx, address: string, packet: unknown, fromSite: boolean): Promise<Seen | string> {
    const field = await ctx.chain.field(address, KEY);
    if (field === null) return fromSite ? ADD_FIRST : explain(KEY, { ok: false, reason: 'gone' });
    if (!field.private) return field.value?.trim() ? { value: field.value, private: false, commitment: field.commitment } : ADD_FIRST;
    if (packet === undefined || packet === null) return fromSite ? UNLOCK : STALE;
    const resolved = await resolvePrivate(ctx, address, KEY, packet);
    return 'error' in resolved ? resolved.error : { value: resolved.value, private: true, commitment: resolved.commitment };
  }

  return {
    key: KEY,
    stale: STALE,
    keyOf,
    current,

    async start(ctx, req) {
      const body = record(req.body) ?? {};
      const address = addressOf(body);
      if (!startAllowed(ctx, req.ip)) throw new HttpError(429, TOO_MANY);
      const seen = await current(ctx, address, body.packet ?? body.packetId, true);
      if (typeof seen === 'string') throw new HttpError(400, seen);
      const token = random();
      const session = random();
      const row: StartRow = { address, field: options.kind, commitment: seen.commitment, session: sha256(session) };
      // The value of a private field stays in memory, under a packet of its own that lives as long as the token.
      if (seen.private) row.packet = ctx.packets.put({ address, key: KEY, value: seen.value, commitment: seen.commitment });
      ctx.store.put(START, sha256(token), row, START_TTL_MS);
      ctx.log('info', `${options.prefix}-started`, { who: address });
      return { token, session };
    },

    lookup(ctx, token) {
      if (!TOKEN.test(token)) return null;
      const id = sha256(token);
      const row = ctx.store.get<StartRow>(START, id);
      return row === null ? null : { id, row };
    },

    issue(ctx, found, seen, handle, extra) {
      const { row } = found;
      if (ctx.store.take<StartRow>(START, found.id) === null) return null;
      const key = keyOf(ctx);
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const pending = {
        hash: mac(key, 'code', row.address, row.session, code).toString('hex'),
        handle: mac(key, 'handle', options.normalize(handle)).toString('hex'),
        commitment: row.commitment,
        ...extra,
        expires: ctx.now() + CODE_TTL_MS,
      } as Pending<Extra>;
      // A packet of its own, so that the value lives as long as the code does (never in the database).
      if (seen.private) pending.packet = ctx.packets.put({ address: row.address, key: KEY, value: seen.value, commitment: seen.commitment });
      const id = mac(key, 'row', row.address, row.session).toString('base64url');
      ctx.store.put(CODE, id, pending, CODE_TTL_MS);
      ctx.log('info', `${options.prefix}-code-sent`, { who: row.address });
      return { code, row: id };
    },

    async check(ctx, req) {
      const key = keyOf(ctx);
      const body = record(req.body) ?? {};
      const address = addressOf(body);
      const typed = body.code;
      const code = typeof typed === 'string' ? typed.replace(/\s+/g, '') : '';
      if (!/^\d{6}$/.test(code)) throw new HttpError(400, `Enter the 6-digit code from ${label}.`);
      if (typeof body.session !== 'string' || !SESSION.test(body.session)) throw expired();
      const session = sha256(body.session);
      const id = mac(key, 'row', address, session).toString('base64url');
      const pending = ctx.store.get<Pending<Extra>>(CODE, id);
      if (pending === null) throw expired();
      // Wrong codes add up across the codes of an account: a new start does not reset them.
      if (ctx.store.count(WRONG, address, HOUR) >= MAX_WRONG_PER_HOUR) throw new HttpError(429, 'Too many wrong codes. Try again in an hour.');
      const attempts = ctx.store.bump(CODE, id);
      if (attempts === null) throw expired();
      if (attempts > MAX_ATTEMPTS) {
        ctx.store.drop(CODE, id);
        throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
      }
      if (!timingSafeEqual(mac(key, 'code', address, session, code), Buffer.from(pending.hash, 'hex'))) {
        ctx.store.record(WRONG, address, HOUR);
        throw new HttpError(400, 'That code is not right.');
      }
      // Taken in one statement: two checks with the right code never both attest.
      const taken = ctx.store.take<Pending<Extra>>(CODE, id);
      if (taken === null) throw expired();
      /** The code was right: if only the chain or a read failed, it stays good for the time it had left (never over a row put there since). */
      const keep = (): void => {
        if (ctx.store.get(CODE, id) === null) ctx.store.put(CODE, id, taken, Math.max(taken.expires - ctx.now(), 1));
      };
      try {
        const seen = await current(ctx, address, taken.packet, false);
        if (typeof seen === 'string') throw new HttpError(409, seen);
        // The field is the one of the start, and it still names the account the bot saw.
        if (seen.commitment.toLowerCase() !== taken.commitment.toLowerCase()) throw new HttpError(409, STALE);
        const same = mac(key, 'handle', options.normalize(seen.value));
        const kept = Buffer.from(taken.handle, 'hex');
        if (same.length !== kept.length || !timingSafeEqual(same, kept)) throw new HttpError(409, STALE);
        const result = await ctx.chain.attest(address, KEY, taken.commitment, options.method);
        if (!result.ok) {
          if (result.reason === 'failed') keep();
          throw new HttpError(result.reason === 'failed' ? 502 : 409, explain(KEY, result));
        }
      } catch (e) {
        if (!(e instanceof HttpError)) keep();
        throw e;
      }
      ctx.log('info', `${options.prefix}-verified`, { who: address });
      return { address, row: id, pending: taken };
    },
  };
}
