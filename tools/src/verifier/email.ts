// Email channel (method `EmailCode`): a 6-digit code goes, through Resend, to the email the
// chain holds for the account; typing it back attests the field.
//
//   POST /api/email/send  {address, packet?}         -> { sent: true, session }
//   POST /api/email/check {address, session, code}   -> { verified: true }
//
// `packet` is only for a private Email (the packet inline or the id of /api/packet). The chain is the
// only source of the address: nothing the request says about the email is read.
//
// Each send makes its own pending code, bound to a random `session` that only the client that asked
// for it holds: a third party's guesses or sends never touch another session's code, so nobody can
// burn or replace the owner's code. Several codes may coexist for one account, each with its own 5
// attempts and 10 minutes. What stops guessing across re-sends is a cumulative limit of wrong codes
// per account and per mailbox and hour.
//
// A private Email is read from its packet to know where to send, then forgotten: what is kept is the
// code's keyed hash and the field's commitment, never the email, in SQLite or in memory. The
// attestation carries the commitment of the start, so a field changed meanwhile is refused by the
// chain (`StaleCommitment`) and the person is told to start again.
//
// Hashes, row ids and mailbox keys are HMACs under a key generated once and kept in
// `<STATE_DIRECTORY>/email.key` (mode 0600), outside the database: whoever reads `verifier.db` cannot
// brute-force a live code (10^6 values) nor learn which mailbox a limit counts.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { canonicalAddress, explain, FIELD_LABELS, type FieldKey } from './chain.ts';
import { objectOf as object, startAllowed, type Channel } from './channels.ts';
import { hasEnv } from './config.ts';
import type { Ctx } from './ctx.ts';
import { isDisposableEmail, type MxResolver, systemMx } from './disposable.ts';
import { HttpError, type Request, type Router } from './http.ts';
import { loadKey, mac } from './keyed.ts';
import { resolvePrivate } from './packet.ts';

const KEY: FieldKey = { Typed: 'Email' };
const KIND = 'email-code';
const RESEND_URL = 'https://api.resend.com/emails';
const FROM = 'identitee <verify@identit.ee>';
const SUBJECT = 'Your identitee code';
const KEY_FILE = 'email.key';

export const CODE_TTL_MS = 10 * 60_000;
/** Guesses per code. */
export const MAX_ATTEMPTS = 5;
/** Wrong codes per account, and per mailbox, and hour, whatever the codes they were for. */
export const MAX_WRONG_PER_HOUR = 10;
const HOUR = 60 * 60_000;
/** Delivered codes per (IP, account), and per mailbox, and hour. The account limit counts per
 * IP as KYC does, so that a third party sending to someone's account cannot lock its owner out; the
 * mailbox limit is the one against spam. */
const SENDS_PER_HOUR = 5;
const SEND_TIMEOUT_MS = 10_000;
const SESSION = /^[A-Za-z0-9_-]{22}$/;

export interface EmailOptions {
  /** For the call to Resend (tests stub it). */
  fetch?: typeof fetch;
  /** For the disposable check (tests stub it). */
  resolveMx?: MxResolver;
}

/** What a pending code keeps: its keyed hash (never the code), the mailbox's keyed digest, the commitment of the start. */
interface Pending {
  hash: string;
  mailbox: string;
  commitment: string;
  /** Milliseconds since the epoch, to put the row back with its remaining time. */
  expires: number;
}

const expired = (): HttpError => new HttpError(400, 'This code has expired. Ask for a new one.');

/**
 * The mailbox an email lands in, so that variants share a limit: lowercase, no spaces, no trailing dot
 * on the domain, no `+tag` on the local part, and for Gmail (`googlemail.com` is the same service) no
 * dots in the local part.
 */
export function normalizeMailbox(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return email.trim().toLowerCase();
  let local = email.slice(0, at).trim().toLowerCase();
  let domain = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

function addressOf(req: Request): string {
  const address = object(req.body).address;
  const canonical = typeof address === 'string' ? canonicalAddress(address) : null;
  if (canonical === null) throw new HttpError(400, 'This is not a valid account address.');
  return canonical;
}

const PART = '[^\\s@<>(),;:"\\\\\\[\\]]+';
const SHAPE = new RegExp(`^${PART}@${PART}\\.${PART}$`);
const validEmail = (email: string): boolean => email.length <= 254 && SHAPE.test(email);

/** The email to write to and the commitment it has on chain, as the chain says (a private one, as its packet proves). */
async function destination(ctx: Ctx, address: string, body: Record<string, unknown>): Promise<{ email: string; commitment: string }> {
  const field = await ctx.chain.field(address, KEY);
  if (field === null) throw new HttpError(400, 'Add an email to your identity first.');
  let email: string;
  let commitment: string;
  if (field.private) {
    const packet = body.packet ?? body.packetId;
    if (packet === undefined || packet === null) throw new HttpError(400, `Unlock your identity to verify a private ${FIELD_LABELS.Email.toLowerCase()}.`);
    const resolved = await resolvePrivate(ctx, address, KEY, packet);
    if ('error' in resolved) throw new HttpError(400, resolved.error);
    ({ value: email, commitment } = resolved);
  } else {
    email = field.value ?? '';
    commitment = field.commitment;
  }
  email = email.trim();
  if (!validEmail(email)) throw new HttpError(400, 'The email on your identity is not a valid address.');
  return { email, commitment };
}

function mail(code: string): { text: string; html: string } {
  const text = `Your identitee code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.\n`;
  const html =
    '<div style="font-family:Inter,Helvetica,Arial,sans-serif;color:#111">' +
    `<p>Your identitee code is</p><p style="font-size:28px;letter-spacing:4px;font-weight:600">${code}</p>` +
    '<p>It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p></div>';
  return { text, html };
}

export function emailChannel(options: EmailOptions = {}): Channel {
  const doFetch = options.fetch ?? globalThis.fetch;
  const resolveMx = options.resolveMx ?? systemMx;
  let root: Buffer | undefined;
  const keyOf = (ctx: Ctx): Buffer => (root ??= loadKey(ctx.cfg.stateDir, KEY_FILE));
  /** Deliveries under way per limit key: a limit read before sending counts them, so parallel sends cannot overshoot it. */
  const inFlight = new Map<string, number>();
  const busy = (bucket: string, key: string): number => inFlight.get(`${bucket}:${key}`) ?? 0;
  const reserve = (bucket: string, key: string, by: 1 | -1): void => void inFlight.set(`${bucket}:${key}`, busy(bucket, key) + by);
  const full = (ctx: Ctx, bucket: string, key: string): boolean => ctx.store.count(bucket, key, HOUR) + busy(bucket, key) >= SENDS_PER_HOUR;

  async function deliver(ctx: Ctx, to: string, code: string): Promise<boolean> {
    const apiKey = ctx.cfg.env.RESEND_API_KEY ?? '';
    try {
      const res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [to], subject: SUBJECT, ...mail(code) }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await res.text().catch(() => ''); // Resend's answer may quote the address: read, never logged
      if (res.ok) return true;
      ctx.log('error', 'email-send-failed', { status: res.status });
    } catch (e) {
      // Only the error's class: its message could quote the key or the address.
      ctx.log('error', 'email-send-failed', { error: e instanceof Error ? e.name : typeof e });
    }
    return false;
  }

  async function send(ctx: Ctx, req: Request): Promise<unknown> {
    const key = keyOf(ctx);
    const address = addressOf(req);
    if (!startAllowed(ctx, req.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const { email, commitment } = await destination(ctx, address, object(req.body));
    if (await isDisposableEmail(email, resolveMx)) throw new HttpError(400, 'Disposable email addresses cannot be verified.');
    const mailbox = mac(key, 'mailbox', normalizeMailbox(email)).toString('hex');
    // Only delivered codes count against the limits: read here, recorded below once Resend took the email.
    const sender = `${req.ip}|${address}`;
    if (full(ctx, 'email-send', sender)) throw new HttpError(429, 'Too many codes were sent for this account. Try again in an hour.');
    if (full(ctx, 'email-to', mailbox)) throw new HttpError(429, 'Too many codes were sent to this email. Try again in an hour.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const session = randomBytes(16).toString('base64url');
    reserve('email-send', sender, 1);
    reserve('email-to', mailbox, 1);
    try {
      if (!(await deliver(ctx, email, code))) throw new HttpError(502, 'The email could not be sent. Try again in a moment.');
      ctx.store.record('email-send', sender, HOUR);
      ctx.store.record('email-to', mailbox, HOUR);
    } finally {
      reserve('email-send', sender, -1);
      reserve('email-to', mailbox, -1);
    }
    // The code exists only once Resend took the email, under a session nobody else holds.
    const pending: Pending = { hash: mac(key, 'code', address, session, code).toString('hex'), mailbox, commitment, expires: ctx.now() + CODE_TTL_MS };
    ctx.store.put(KIND, mac(key, 'row', address, session).toString('base64url'), pending, CODE_TTL_MS);
    ctx.log('info', 'email-code-sent', { who: address });
    return { sent: true, session };
  }

  async function check(ctx: Ctx, req: Request): Promise<unknown> {
    const key = keyOf(ctx);
    const address = addressOf(req);
    const body = object(req.body);
    const given = body.code;
    const code = typeof given === 'string' ? given.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code from the email.');
    if (typeof body.session !== 'string' || !SESSION.test(body.session)) throw expired();
    const session = body.session;
    const id = mac(key, 'row', address, session).toString('base64url');
    const pending = ctx.store.get<Pending>(KIND, id);
    if (pending === null) throw expired();
    // Wrong codes add up across the codes of an account and of a mailbox: a new send does not reset them.
    if (ctx.store.count('email-wrong', address, HOUR) >= MAX_WRONG_PER_HOUR || ctx.store.count('email-wrong-to', pending.mailbox, HOUR) >= MAX_WRONG_PER_HOUR) {
      throw new HttpError(429, 'Too many wrong codes. Try again in an hour.');
    }
    const attempts = ctx.store.bump(KIND, id);
    if (attempts === null) throw expired();
    if (attempts > MAX_ATTEMPTS) {
      ctx.store.drop(KIND, id);
      throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
    }
    const right = timingSafeEqual(mac(key, 'code', address, session, code), Buffer.from(pending.hash, 'hex'));
    if (!right) {
      ctx.store.record('email-wrong', address, HOUR);
      ctx.store.record('email-wrong-to', pending.mailbox, HOUR);
      throw new HttpError(400, 'That code is not right.');
    }
    // Taken in one statement: two checks with the right code never both attest.
    const taken = ctx.store.take<Pending>(KIND, id);
    if (taken === null) throw expired();
    const result = await ctx.chain.attest(address, KEY, taken.commitment, 'EmailCode');
    if (result.ok) return { verified: true };
    // The code was right: if the chain only failed, it stays good for the time it had left (never over a row put there since).
    if (result.reason === 'failed' && ctx.store.get(KIND, id) === null) ctx.store.put(KIND, id, taken, Math.max(taken.expires - ctx.now(), 1));
    throw new HttpError(result.reason === 'failed' ? 502 : 409, explain(KEY, result));
  }

  return {
    name: 'email',
    enabled: (cfg) => hasEnv(cfg, 'RESEND_API_KEY'),
    register(router: Router, ctx: Ctx): void {
      router.route('POST', '/api/email/send', (req) => send(ctx, req));
      router.route('POST', '/api/email/check', (req) => check(ctx, req));
    },
    /** Make the key at startup (an unwritable state directory stops the service, not the first request). */
    async start(ctx: Ctx): Promise<void> {
      keyOf(ctx);
    },
  };
}
