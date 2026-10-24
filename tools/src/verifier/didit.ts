// KYC channel (fact `DocumentChecked`): Didit checks an identity document, and only
// Didit's own decision, fetched by this service, decides.
//
//   POST /api/kyc/start {address, signature, message} -> { url }   (the Didit page to open)
//   GET  /api/kyc/status?address=<addr>  -> { status: "none" | "pending" | "approved" | "declined" }
//   POST /didit/webhook                  (Didit only: X-Signature = hex HMAC-SHA256 of the raw body)
//
// The browser's return to identit.ee/me?kyc=done decides nothing. A webhook is checked (signature,
// age), answered 200 at once, and the work goes on in the background, one session at a time: the
// decision is fetched from Didit (GET /v2/session/<id>/decision/), and only its status counts.
// `Approved` grants `DocumentChecked`; then the session and the vendor user are deleted at Didit, as
// dotID does. A failed deletion, a failed grant, a missed webhook and a session left pending are all
// taken up again by a sweep.
//
// Starting needs the address's wallet signature of `kycMessage(genesis, address, time)`, fresh (5
// minutes) and used once: otherwise anyone could certify someone else's address with their own
// document.
//
// One identity document certifies one address. From the decision, the document (number and issuing
// country, as ISO alpha-3) becomes an HMAC under a key kept in `<STATE_DIRECTORY>/didit.key` (mode
// 0600), mapped to the address it certified. A document already used for another address is declined
// (`declined_duplicate`). An approval without a document number and country is not granted: it waits
// in `review` (kept at Didit, for the operator to look at in Didit's console and grant by hand from
// /authority) for at most 7 days. Nothing else of the decision is read, stored or logged: what is kept
// is the session id, the address, a status and timestamps.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalAddress } from './chain.ts';
import { objectOf, startAllowed, type Channel } from './channels.ts';
import { hasEnv } from './config.ts';
import { alpha3 } from './countries.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Request, type Router } from './http.ts';
import { loadKey, mac } from './keyed.ts';
import { walletSigned } from './packet.ts';

const DEFAULT_BASE = 'https://verification.didit.me';
const KEY_FILE = 'didit.key';
const SESSION_KIND = 'kyc-session';
const ADDRESS_KIND = 'kyc-address';
const DOCUMENT_KIND = 'kyc-document';
const SIGNATURE_KIND = 'kyc-signature';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Sessions per day per (IP, address): someone else's IP cannot lock the owner out. */
export const SESSIONS_PER_DAY = 3;
/** A pending session is asked about in the sweep once it is this old (its webhook may have been missed). */
const SETTLE_AFTER_MS = 10 * MINUTE;
/** A session without a final decision (not started, in progress, unreadable) after this long is abandoned and deleted at Didit. */
export const PENDING_MAX_MS = DAY;
/** A session in review, at Didit ("In Review") or here (`review`), is abandoned only after this long. */
export const REVIEW_MAX_MS = 7 * DAY;
/** How far the time of a start signature may be from now, either side. */
export const SIGNATURE_WINDOW_MS = 5 * MINUTE;
/** How long a used start message is remembered: longer than the whole window (both sides), so it never comes back. */
const SIGNATURE_MEMORY_MS = 11 * MINUTE;
/** How long a session row and an address's status are kept. */
const KEEP_MS = 30 * DAY;
/** The document HMACs are kept for good. */
const FOREVER_MS = 100 * 365 * DAY;
/** A webhook whose timestamp is further than this from now is refused (replays). */
const MAX_AGE_MS = 10 * MINUTE;
const TIMEOUT_MS = 10_000;
const SWEEP_MS = 5 * MINUTE;
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

const APPROVED = new Set(['Approved']);
const DECLINED = new Set(['Declined', 'Rejected']);
const ABANDONED = new Set(['Abandoned', 'Expired', 'KYC Expired']);
const IN_REVIEW = 'In Review';

/**
 * `granting`: approved by Didit, the grant on chain is still to be done. `review`: approved by Didit
 * but without a document key, left to the operator.
 */
type State = 'pending' | 'granting' | 'review' | 'approved' | 'declined' | 'declined_duplicate' | 'abandoned';

interface Session {
  address: string;
  state: State;
  /**
   * Whether the session is deleted at Didit, and the vendor user too, or that deletion left to the
   * last other session of the address still at Didit.
   */
  purged: boolean;
  /** Whether the session itself is deleted at Didit (the user deletion may still be to do). */
  sessionGone?: boolean;
  /** Whether Didit last said "In Review" (the longer limit applies). */
  inReview?: boolean;
  /** The Didit page of the session, given back to a signed start while it is pending (never logged). */
  url?: string;
  created: number;
  updated: number;
}

interface AddressStatus {
  session: string;
  state: State;
  /** When that session started: the newest session of the address gives its status. */
  created?: number;
  updated: number;
}

/** States of a session decided at Didit but not done here: no new session meanwhile. */
const BUSY: ReadonlySet<State> = new Set<State>(['granting', 'review']);

const PUBLIC: Record<State, 'pending' | 'approved' | 'declined' | 'none'> = {
  pending: 'pending',
  granting: 'pending',
  review: 'pending',
  approved: 'approved',
  declined: 'declined',
  declined_duplicate: 'declined',
  abandoned: 'none',
};

export interface DiditOptions {
  /** For the calls to Didit (tests stub it). */
  fetch?: typeof fetch;
  /** Didit's API base, without a trailing slash. */
  baseUrl?: string;
  /** Sweep period; 0: no timer (tests call `sweep`). */
  sweepMs?: number;
}

export interface KycChannel extends Channel {
  /** Take up what is left to do: grants, deletions at Didit, pending sessions. */
  sweep(): Promise<void>;
  /** Wait until the background work queued so far has ended. */
  idle(): Promise<void>;
}

const errorClass = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

function addressOf(value: unknown): string {
  const canonical = typeof value === 'string' ? canonicalAddress(value) : null;
  if (canonical === null) throw new HttpError(400, 'This is not a valid account address.');
  return canonical;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** A document number as compared: NFKC, uppercase, letters and digits of any script only. */
export const normalizeDocumentNumber = (value: string): string => value.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The documents of a decision for the one-document rule, as `[issuing country (alpha-3), number]`,
 * from `id_verification` (v2) or each entry of `id_verifications` (newer decisions). An entry
 * without both is skipped; empty when none has them.
 */
export function documentKeys(decision: Record<string, unknown>): Array<[string, string]> {
  const list = Array.isArray(decision.id_verifications) ? decision.id_verifications : [decision.id_verification];
  const keys: Array<[string, string]> = [];
  for (const entry of list) {
    const idv = objectOf(entry);
    const country = alpha3(text(idv.issuing_state));
    const number = normalizeDocumentNumber(text(idv.document_number));
    if (country !== '' && number !== '') keys.push([country, number]);
  }
  return keys;
}

/** The text a wallet signs to start a KYC: `time` in Unix milliseconds. */
export const kycMessage = (genesis: string, address: string, time: number): string => `identitee kyc\nchain: ${genesis}\naddress: ${address}\ntime: ${time}`;

export function diditChannel(options: DiditOptions = {}): KycChannel {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  let root: Buffer | undefined;
  let context: Ctx | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** The tail of the background work: one session step at a time. */
  let tail: Promise<unknown> = Promise.resolve();
  /** Set by `stop`: nothing new is queued (the store is about to close). */
  let stopped = false;
  /** Session creations under way per (IP, address): the daily limit counts them before Didit answers. */
  const creating = new Map<string, number>();

  const keyOf = (ctx: Ctx): Buffer => (root ??= loadKey(ctx.cfg.stateDir, KEY_FILE));
  const apiKey = (ctx: Ctx): string => ctx.cfg.env.DIDIT_API_KEY ?? '';

  /** Run `work` after everything queued before it; a crash is logged by its class only. */
  function enqueue(ctx: Ctx, work: () => Promise<void>): Promise<void> {
    if (stopped) return Promise.resolve();
    const run = tail.then(work).catch((e: unknown) => ctx.log('error', 'kyc-background-failed', { error: errorClass(e) }));
    tail = run;
    return run;
  }

  async function didit(ctx: Ctx, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    return doFetch(`${base}${path}`, {
      method,
      headers: { 'x-api-key': apiKey(ctx), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  const putSession = (ctx: Ctx, id: string, session: Session): void => ctx.store.put(SESSION_KIND, id, { ...session, updated: ctx.now() }, KEEP_MS);

  /** The address's status is the one of its newest session (an abandoned one reads "none"). */
  function putStatus(ctx: Ctx, id: string, session: Session): void {
    const now = ctx.store.get<AddressStatus>(ADDRESS_KIND, session.address);
    if (now !== null && now.session !== id && (now.created ?? 0) > session.created) return;
    const row: AddressStatus = { session: id, state: session.state, created: session.created, updated: ctx.now() };
    ctx.store.put(ADDRESS_KIND, session.address, row, KEEP_MS);
  }

  /** The sessions of `address` this service still holds. */
  const sessionsOf = (ctx: Ctx, address: string): Array<{ id: string; data: Session }> =>
    ctx.store.list<Session>(SESSION_KIND).filter((r) => r.data.address === address);

  // --- POST /api/kyc/start ----------------------------------------------------------------------------

  /** That the address's wallet signed a fresh start message, never used before; throws otherwise. */
  async function owner(ctx: Ctx, address: string, signature: string, message: string): Promise<void> {
    const invalid = new HttpError(400, 'This signature is not valid. Try again.');
    const time = /\ntime: (\d{1,16})$/.exec(message);
    if (time === null) throw invalid;
    const at = Number(time[1]);
    if (message !== kycMessage(ctx.chain.genesis, address, at) || Math.abs(ctx.now() - at) > SIGNATURE_WINDOW_MS) throw invalid;
    // 64 bytes, or the 65-byte MultiSignature form of an sr25519 one (type byte 0x01), taken as its 64 bytes.
    const form = /^0x(01)?([0-9a-fA-F]{128})$/.exec(signature);
    if (form === null || !(await walletSigned(message, `0x${form[2]}`, address))) throw invalid;
    // The message (address and time to the millisecond) is used once, whatever signature carries it.
    const used = createHash('sha256').update(message).digest('hex');
    // Read and written in the same tick: two requests with one message never both pass.
    if (ctx.store.get(SIGNATURE_KIND, used) !== null) throw invalid;
    ctx.store.put(SIGNATURE_KIND, used, {}, SIGNATURE_MEMORY_MS);
  }

  async function start(ctx: Ctx, req: Request): Promise<unknown> {
    const body = objectOf(req.body);
    const address = addressOf(body.address);
    if (typeof body.signature !== 'string' || typeof body.message !== 'string' || body.signature === '' || body.message === '') {
      throw new HttpError(400, 'Sign the request with your wallet to start.');
    }
    if (!startAllowed(ctx, req.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    await owner(ctx, address, body.signature, body.message);
    const checked = await ctx.chain.documentChecked(address);
    if (checked === null) throw new HttpError(400, 'Create your identity first.');
    if (checked) throw new HttpError(409, 'Your identity document is already checked.');
    const held = sessionsOf(ctx, address);
    // Submitted at Didit ("In Review"), approved and being granted, or in our review: nothing to resume.
    if (held.some((r) => BUSY.has(r.data.state) || (r.data.state === 'pending' && r.data.inReview === true))) {
      throw new HttpError(409, 'Your identity document is already being checked.');
    }
    // Still to be done at Didit ("Not Started", "In Progress"): the same page again, no new session.
    const resume = held.filter((r) => r.data.state === 'pending' && r.data.url !== undefined).sort((a, b) => b.data.created - a.data.created)[0];
    if (resume !== undefined) {
      ctx.log('info', 'kyc-resumed', { who: address });
      return { url: resume.data.url };
    }
    // Only sessions Didit created count against the daily limit; those under way count meanwhile.
    const limitKey = `${req.ip}|${address}`;
    if (ctx.store.count('kyc-start', limitKey, DAY) + (creating.get(limitKey) ?? 0) >= SESSIONS_PER_DAY) {
      throw new HttpError(429, 'Too many identity checks today. Try again tomorrow.');
    }
    creating.set(limitKey, (creating.get(limitKey) ?? 0) + 1);
    try {
      const out = await create(ctx, address);
      ctx.store.record('kyc-start', limitKey, DAY);
      return out;
    } finally {
      const left = (creating.get(limitKey) ?? 1) - 1;
      if (left > 0) creating.set(limitKey, left);
      else creating.delete(limitKey);
    }
  }

  /** Create the Didit session of `address`: `{ url }`, or a 502. */
  async function create(ctx: Ctx, address: string): Promise<{ url: string }> {
    const failed = new HttpError(502, 'The identity check could not be started. Try again in a moment.');
    let answer: Record<string, unknown>;
    try {
      const res = await didit(ctx, 'POST', '/v2/session/', {
        workflow_id: ctx.cfg.env.DIDIT_WORKFLOW_ID,
        vendor_data: address,
        callback: `${ctx.cfg.frontOrigin}/me?kyc=done`,
      });
      const body = await res.text();
      if (!res.ok) {
        ctx.log('error', 'kyc-start-failed', { status: res.status });
        throw failed;
      }
      answer = objectOf(JSON.parse(body));
    } catch (e) {
      if (e === failed) throw e;
      ctx.log('error', 'kyc-start-failed', { error: errorClass(e) });
      throw failed;
    }
    const id = answer.session_id;
    const url = answer.url;
    if (typeof id !== 'string' || !SESSION_ID.test(id) || typeof url !== 'string' || !url.startsWith('https://')) {
      ctx.log('error', 'kyc-start-failed', { reason: 'unexpected answer' });
      throw failed;
    }
    const session: Session = { address, state: 'pending', purged: false, created: ctx.now(), updated: ctx.now(), url };
    putSession(ctx, id, session);
    putStatus(ctx, id, session);
    ctx.log('info', 'kyc-started', { who: address });
    return { url };
  }

  // --- GET /api/kyc/status ----------------------------------------------------------------------------

  function status(ctx: Ctx, req: Request): unknown {
    const address = addressOf(req.query.get('address'));
    const row = ctx.store.get<AddressStatus>(ADDRESS_KIND, address);
    return { status: row === null ? 'none' : PUBLIC[row.state] };
  }

  // --- POST /didit/webhook ----------------------------------------------------------------------------

  function signed(ctx: Ctx, req: Request): boolean {
    const header = req.headers['x-signature'];
    const given = typeof header === 'string' ? header.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = createHmac('sha256', ctx.cfg.env.DIDIT_WEBHOOK_SECRET ?? '').update(req.rawBody).digest();
    return timingSafeEqual(Buffer.from(given, 'hex'), expected);
  }

  /** Whether a timestamp (unix seconds) is within `MAX_AGE_MS` of now. */
  const fresh = (ctx: Ctx, seconds: number): boolean => Math.abs(ctx.now() - seconds * 1000) <= MAX_AGE_MS;

  function webhook(ctx: Ctx, req: Request): unknown {
    if (!signed(ctx, req)) throw new HttpError(401, 'The signature is not valid.');
    let event: Record<string, unknown>;
    try {
      event = objectOf(JSON.parse(req.rawBody.toString('utf8')));
    } catch {
      return { ok: true };
    }
    // The body's timestamp is signed; X-Timestamp is not, so it can only refuse, never vouch.
    const header = Number(req.headers['x-timestamp']);
    if (typeof event.timestamp === 'number' && !fresh(ctx, event.timestamp)) throw new HttpError(401, 'This event is too old.');
    if (req.headers['x-timestamp'] !== undefined && (!Number.isFinite(header) || !fresh(ctx, header))) throw new HttpError(401, 'This event is too old.');
    const id = event.session_id;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return { ok: true };
    const session = ctx.store.get<Session>(SESSION_KIND, id);
    if (session === null || session.state !== 'pending') return { ok: true };
    void enqueue(ctx, () => settle(ctx, id, false));
    return { ok: true };
  }

  // --- The background work ----------------------------------------------------------------------------

  /** Didit's decision for session `id`, `null` if it could not be read. */
  async function decision(ctx: Ctx, id: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await didit(ctx, 'GET', `/v2/session/${encodeURIComponent(id)}/decision/`);
      const body = await res.text();
      if (!res.ok) {
        ctx.log('error', 'kyc-decision-failed', { status: res.status });
        return null;
      }
      return objectOf(JSON.parse(body));
    } catch (e) {
      ctx.log('error', 'kyc-decision-failed', { error: errorClass(e) });
      return null;
    }
  }

  /**
   * Act on the decision of a pending session, if Didit has a final one. `sweeping`: abandon it once it
   * is past its limit without one (also when the decision cannot be read or does not match).
   */
  async function settle(ctx: Ctx, id: string, sweeping: boolean): Promise<void> {
    const session = ctx.store.get<Session>(SESSION_KIND, id);
    if (session === null || session.state !== 'pending') return;
    let found = await decision(ctx, id);
    if (found !== null) {
      const vendor = typeof found.vendor_data === 'string' ? canonicalAddress(found.vendor_data) : null;
      if ((found.session_id !== undefined && found.session_id !== id) || vendor !== session.address) {
        ctx.log('error', 'kyc-mismatch', { who: session.address });
        found = null;
      }
    }
    const verdict = found === null ? '' : text(found.status);
    if (found !== null && APPROVED.has(verdict)) {
      session.state = approve(ctx, session.address, found);
    } else if (DECLINED.has(verdict)) {
      session.state = 'declined';
      ctx.log('info', 'kyc-declined', { who: session.address });
    } else if (ABANDONED.has(verdict)) {
      session.state = 'abandoned';
    } else {
      if (verdict !== '' && (verdict === IN_REVIEW) !== (session.inReview === true)) {
        session.inReview = verdict === IN_REVIEW;
        putSession(ctx, id, session);
      }
      if (!sweeping || ctx.now() - session.created < (session.inReview ? REVIEW_MAX_MS : PENDING_MAX_MS)) return;
      session.state = 'abandoned';
    }
    if (session.state === 'abandoned') ctx.log('info', 'kyc-abandoned', { who: session.address });
    putSession(ctx, id, session);
    putStatus(ctx, id, session);
    if (session.state === 'granting') await grant(ctx, id, session);
    // A session in review stays at Didit for the operator.
    if (session.state !== 'review') await purge(ctx, id, session);
  }

  /** The one-document rule for an approved decision: `granting`, `declined_duplicate`, or `review` without a document. */
  function approve(ctx: Ctx, address: string, found: Record<string, unknown>): State {
    const key = keyOf(ctx);
    const ids = documentKeys(found).map(([country, number]) => mac(key, 'kyc-document', country, number).toString('hex'));
    if (ids.length === 0) {
      ctx.log('warn', 'kyc-needs-review', { who: address });
      return 'review';
    }
    const taken = ids.some((h) => {
      const owner = ctx.store.get<{ address: string }>(DOCUMENT_KIND, h);
      return owner !== null && owner.address !== address;
    });
    if (taken) {
      ctx.log('warn', 'kyc-duplicate', { who: address });
      return 'declined_duplicate';
    }
    for (const h of ids) ctx.store.put(DOCUMENT_KIND, h, { address }, FOREVER_MS);
    return 'granting';
  }

  async function grant(ctx: Ctx, id: string, session: Session): Promise<void> {
    const result = await ctx.chain.grantDocument(session.address);
    if (result.ok) {
      session.state = 'approved';
      ctx.log('info', 'kyc-approved', { who: session.address });
    } else if (result.reason === 'failed') {
      ctx.log('error', 'kyc-grant-failed', { who: session.address });
      return; // stays `granting`: the sweep tries again
    } else {
      session.state = 'declined';
      ctx.log('warn', 'kyc-grant-refused', { who: session.address, reason: result.reason });
    }
    putSession(ctx, id, session);
    putStatus(ctx, id, session);
  }

  /**
   * Delete the session at Didit, then the vendor user, which takes every session of the address
   * with it: so only once no other session of the address is left at Didit (one in review must stay
   * for the operator; the last one to go deletes the user). The row goes once done and nothing is
   * left to do.
   */
  async function purge(ctx: Ctx, id: string, session: Session): Promise<void> {
    if (!session.purged) {
      if (session.sessionGone !== true) {
        if (!(await remove(ctx, 'session', 'DELETE', `/v1/session/${encodeURIComponent(id)}/delete/`, undefined))) return;
        session.sessionGone = true;
        putSession(ctx, id, session);
      }
      const others = sessionsOf(ctx, session.address).some((r) => r.id !== id && !r.data.purged);
      if (!others && !(await remove(ctx, 'user', 'POST', '/v3/users/delete/', { vendor_data_list: [session.address] }))) return;
      session.purged = true;
      putSession(ctx, id, session);
    }
    if (session.state !== 'granting') ctx.store.drop(SESSION_KIND, id);
  }

  /** One deletion at Didit: done on a 2xx, and on a 404 (nothing left there), which is logged apart so
   * that a wrong path shows in the journal. Never with the address or anything personal. */
  async function remove(ctx: Ctx, what: 'session' | 'user', method: 'DELETE' | 'POST', path: string, body: unknown): Promise<boolean> {
    try {
      const res = await didit(ctx, method, path, body);
      await res.text().catch(() => '');
      if (res.status === 404) {
        ctx.log('warn', 'kyc-purge-not-found', { what, status: res.status });
        return true;
      }
      if (res.ok) {
        ctx.log('info', 'kyc-purged', { what });
        return true;
      }
      ctx.log('error', 'kyc-delete-failed', { what, status: res.status });
    } catch (e) {
      ctx.log('error', 'kyc-delete-failed', { what, error: errorClass(e) });
    }
    return false;
  }

  async function sweep(ctx: Ctx): Promise<void> {
    if (stopped) return;
    for (const { id } of ctx.store.list<Session>(SESSION_KIND)) {
      if (stopped) return;
      await enqueue(ctx, async () => {
        // Read again: a webhook may have settled it since the list.
        const session = ctx.store.get<Session>(SESSION_KIND, id);
        if (session === null) return;
        if (session.state === 'pending') {
          if (ctx.now() - session.created >= SETTLE_AFTER_MS) await settle(ctx, id, true);
          return;
        }
        if (session.state === 'review') {
          // Left to the operator, at Didit, for at most REVIEW_MAX_MS.
          if (ctx.now() - session.created < REVIEW_MAX_MS) return;
          session.state = 'abandoned';
          ctx.log('info', 'kyc-abandoned', { who: session.address });
          putSession(ctx, id, session);
          putStatus(ctx, id, session);
        }
        if (session.state === 'granting') await grant(ctx, id, session);
        await purge(ctx, id, session);
      });
    }
  }

  const live = (): Ctx => {
    if (context === undefined) throw new Error('the KYC channel is not registered');
    return context;
  };

  return {
    name: 'kyc',
    enabled: (cfg) => hasEnv(cfg, 'DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_WEBHOOK_SECRET'),
    register(router: Router, ctx: Ctx): void {
      context = ctx;
      router.route('POST', '/api/kyc/start', (req) => start(ctx, req));
      router.route('GET', '/api/kyc/status', (req) => status(ctx, req));
      // A webhook carries the whole decision: more than the default 16 KB.
      router.route('POST', '/didit/webhook', (req) => webhook(ctx, req), { maxBody: 1024 * 1024 });
    },
    async start(ctx: Ctx): Promise<void> {
      keyOf(ctx);
      if (sweepMs > 0) {
        timer = setInterval(() => void sweep(ctx).catch((e: unknown) => ctx.log('error', 'kyc-sweep-failed', { error: errorClass(e) })), sweepMs);
        timer.unref();
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await this.idle();
    },
    sweep: () => sweep(live()),
    async idle(): Promise<void> {
      let before: Promise<unknown>;
      do {
        before = tail;
        await before;
      } while (before !== tail);
    },
  };
}
