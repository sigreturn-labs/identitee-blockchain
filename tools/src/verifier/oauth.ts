// OAuth channels (method `OAuth`): the person signs in to X, Discord or
// GitHub, and the account the provider names must be the one the identity holds.
//
//   GET /oauth/<x|discord|github>/start?address=…&mode=popup|redirect[&packet=<id>]  -> 302 to the provider
//   GET /oauth/<x|discord|github>/callback?code=…&state=…                               -> the result
//
// `packet` is only for a private field: the id `POST /api/packet` gave (never the packet itself in
// a URL). The result goes back to the site (`VERIFIER_FRONT_ORIGIN`, https://identit.ee):
//   popup:    a small page that posts `{type:'identitee-verified', channel}` or
//             `{type:'identitee-verify-error', message}` to that origin only, then closes. With no
//             opener (a provider such as X cuts the window from the site) it stays: the sentence
//             and a link back to `<front>/me`, no answer in the address; the site reads the chain.
//   redirect: 302 to `<front>/me?verified=<channel>` or `<front>/me?verify_error=<sentence>`.
//
// The state is 32 random bytes, kept 10 minutes under its SHA-256 and taken once, with a PKCE S256
// verifier, the field's commitment at the start and, for a private field, the packet id (never the
// value). The start also sets a cookie `__Host-identitee-oauth-<provider>` (32 random bytes, HttpOnly,
// Secure, SameSite=Lax, 10 minutes) whose hash the state keeps: the callback refuses a browser
// without it, so an authorize link forwarded to someone else finishes nothing (login CSRF).
// A start must come from the site: `Sec-Fetch-Site` same-site or same-origin (see `fromFront`). The
// access token is used for one call and forgotten; no token, code or verifier is logged.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalAddress, explain, FIELD_LABELS, type FieldKey, type FieldKind } from './chain.ts';
import { startAllowed, type Channel } from './channels.ts';
import { hasEnv, type ChannelEnvName } from './config.ts';
import type { Ctx } from './ctx.ts';
import { cookies, HttpError, type Reply, type Request, type Router } from './http.ts';
import { sameHandle, type ProvedAccount } from './normalize.ts';
import { resolvePrivate } from './packet.ts';

export type Provider = 'x' | 'discord' | 'github';

export interface Endpoints {
  authorize: string;
  token: string;
  user: string;
}

export const ENDPOINTS: Record<Provider, Endpoints> = {
  x: { authorize: 'https://twitter.com/i/oauth2/authorize', token: 'https://api.twitter.com/2/oauth2/token', user: 'https://api.twitter.com/2/users/me' },
  discord: { authorize: 'https://discord.com/api/oauth2/authorize', token: 'https://discord.com/api/oauth2/token', user: 'https://discord.com/api/users/@me' },
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user' },
};

interface Spec {
  kind: FieldKind;
  id: ChannelEnvName;
  secret: ChannelEnvName;
  scope: string | null;
  /** How the account is named in a sentence. */
  at: string;
  /** What the person is asked to add or unlock. */
  thing: string;
}

const SPECS: Record<Provider, Spec> = {
  x: { kind: 'X', id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET', scope: 'users.read tweet.read', at: '@', thing: 'X account' },
  discord: { kind: 'Discord', id: 'DISCORD_CLIENT_ID', secret: 'DISCORD_CLIENT_SECRET', scope: 'identify', at: '', thing: 'Discord account' },
  github: { kind: 'GitHub', id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET', scope: null, at: '@', thing: 'GitHub account' },
};

export const STATE_TTL_MS = 10 * 60_000;
const KIND = 'oauth-state';
const CALL_TIMEOUT_MS = 10_000;
const USER_AGENT = 'identitee-verifier';
const STATE = /^[A-Za-z0-9_-]{43}$/;
const PACKET_ID = /^[A-Za-z0-9_-]{24}$/;
const EXPIRED = 'This verification has expired. Start again.';
const OTHER_BROWSER = 'This verification was started in another browser. Start again.';
const FROM_PROFILE = 'Start the verification from your profile on identit.ee.';
const NOT_RECORDED = 'The verification could not be recorded. Try again in a moment.';
/** How long the browser cookie lives, in seconds: the state's lifetime. */
const COOKIE_MAX_AGE = STATE_TTL_MS / 1000;

type Mode = 'popup' | 'redirect';

/** What a state row holds; never a private value, never a token. */
interface State {
  provider: Provider;
  address: string;
  field: FieldKind;
  mode: Mode;
  verifier: string;
  /** SHA-256 (base64url) of the browser cookie set at the start: the callback must come from that browser. */
  browser: string;
  commitment: string;
  /** The packet id of a private field. */
  packet?: string;
}

export interface OAuthOptions {
  /** For the token and user calls (tests may stub it). */
  fetch?: typeof fetch;
  /** Other provider URLs (tests point them at a fake provider). */
  endpoints?: Partial<Record<Provider, Partial<Endpoints>>>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url');
const stateId = sha256;
const random = (): string => randomBytes(32).toString('base64url');

/** A sentence for the person: `failed` in a short form shown in place of the result. */
class Refusal extends Error {}

// --- The result page -----------------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
/** JSON that can sit in a <script> element: no `<`, `>`, `&` or line separators in clear. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function page(front: string, message: Record<string, string>, text: string): Reply {
  const nonce = randomBytes(18).toString('base64');
  const back = `${front}/me`;
  const data = scriptJson({ message, origin: front });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>identitee</title>
<style nonce="${nonce}">body{font-family:Inter,system-ui,sans-serif;color:#111;margin:48px 24px;line-height:1.5}a{color:#111}</style>
</head>
<body>
<p>${escapeHtml(text)}</p>
<p><a href="${escapeHtml(back)}">Back to identit.ee</a></p>
<script nonce="${nonce}">
const data = ${data};
if (window.opener) {
  window.opener.postMessage(data.message, data.origin);
  window.close();
}
</script>
</body>
</html>
`;
  return {
    status: message.type === 'identitee-verified' ? 200 : 400,
    html,
    headers: {
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  };
}

function outcome(ctx: Ctx, mode: Mode, channel: Provider, error: string | null, extra: Record<string, string> = {}): Reply {
  const front = ctx.cfg.frontOrigin;
  if (mode === 'redirect') {
    const back = error === null ? `${front}/me?verified=${channel}` : `${front}/me?verify_error=${encodeURIComponent(error)}`;
    return { status: 302, redirect: back, headers: extra };
  }
  const reply =
    error === null
      ? page(front, { type: 'identitee-verified', channel }, `Your ${SPECS[channel].thing} is verified. You can close this window.`)
      : page(front, { type: 'identitee-verify-error', message: error }, error);
  return { ...reply, headers: { ...('headers' in reply ? reply.headers : {}), ...extra } };
}

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Whether a start is a navigation the site opened (window.open or a location change from an
 * identit.ee page), from the browser's fetch-metadata headers: `Sec-Fetch-Site` same-site or
 * same-origin, and `Sec-Fetch-Dest` document when present. A link forwarded by mail or typed
 * (`none`) or followed from another site (`cross-site`) would bind someone else's browser to the
 * flow. A missing header is accepted only with VERIFIER_DEV (curl, tests).
 */
function fromFront(ctx: Ctx, req: Request): boolean {
  const site = header(req, 'sec-fetch-site');
  const dest = header(req, 'sec-fetch-dest');
  if (dest !== undefined && dest !== 'document') return false;
  if (site === undefined) return ctx.cfg.dev;
  return site === 'same-site' || site === 'same-origin';
}

/**
 * The cookie that binds a flow to the browser that started it (a forwarded authorize link finishes
 * nothing). `__Host-` and `Secure` always, except in VERIFIER_DEV over plain http where a browser
 * would drop a Secure cookie.
 */
function browserCookie(ctx: Ctx, provider: Provider): { name: string; set(value: string, maxAge: number): string } {
  const secure = !(ctx.cfg.dev && ctx.cfg.publicUrl.startsWith('http://'));
  const name = `${secure ? '__Host-' : ''}identitee-oauth-${provider}`;
  return { name, set: (value, maxAge) => `${name}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAge}` };
}

// --- The channels --------------------------------------------------------------------------------------

function oauthChannel(provider: Provider, options: OAuthOptions): Channel {
  const spec = SPECS[provider];
  const key: FieldKey = { Typed: spec.kind };
  const urls: Endpoints = { ...ENDPOINTS[provider], ...(options.endpoints?.[provider] ?? {}) };
  const doFetch = options.fetch ?? globalThis.fetch;
  const callbackUrl = (ctx: Ctx): string => `${ctx.cfg.publicUrl}/oauth/${provider}/callback`;
  const label = FIELD_LABELS[spec.kind];
  const failed = `${label} did not confirm the sign-in. Try again.`;

  /** The commitment the field has now and, for a private one, its value from the packet. */
  async function current(ctx: Ctx, address: string, packet: string | undefined): Promise<{ commitment: string; value: string; private: boolean }> {
    const field = await ctx.chain.field(address, key);
    if (field === null) throw new Refusal(`Add your ${spec.thing} to your identity first.`);
    if (!field.private) {
      if (!field.value?.trim()) throw new Refusal(`Add your ${spec.thing} to your identity first.`);
      return { commitment: field.commitment, value: field.value, private: false };
    }
    if (packet === undefined) throw new Refusal(`Unlock your identity to verify a private ${spec.thing}.`);
    if (!PACKET_ID.test(packet)) throw new Refusal(EXPIRED);
    const resolved = await resolvePrivate(ctx, address, key, packet);
    if ('error' in resolved) throw new Refusal(resolved.error);
    return { commitment: resolved.commitment, value: resolved.value, private: true };
  }

  async function start(ctx: Ctx, req: Request): Promise<Reply> {
    const modeText = req.query.get('mode') ?? 'popup';
    if (modeText !== 'popup' && modeText !== 'redirect') throw new HttpError(400, 'This is not a valid verification mode.');
    const mode: Mode = modeText;
    try {
      if (!fromFront(ctx, req)) throw new Refusal(FROM_PROFILE);
      const given = req.query.get('address');
      const address = given === null ? null : canonicalAddress(given);
      if (address === null) throw new Refusal('This is not a valid account address.');
      if (!startAllowed(ctx, req.ip)) throw new Refusal('Too many attempts. Try again later.');
      const packet = req.query.get('packet') ?? undefined;
      const field = await current(ctx, address, packet);
      const state = random();
      const verifier = random();
      const browser = random();
      const row: State = { provider, address, field: spec.kind, mode, verifier, browser: sha256(browser), commitment: field.commitment, ...(field.private ? { packet } : {}) };
      ctx.store.put(KIND, stateId(state), row, STATE_TTL_MS);
      const to = new URL(urls.authorize);
      const q = to.searchParams;
      q.set('response_type', 'code');
      q.set('client_id', ctx.cfg.env[spec.id] ?? '');
      q.set('redirect_uri', callbackUrl(ctx));
      if (spec.scope !== null) q.set('scope', spec.scope);
      q.set('state', state);
      q.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      q.set('code_challenge_method', 'S256');
      ctx.log('info', 'oauth-started', { who: address, channel: provider });
      return { status: 302, redirect: to.toString(), headers: { 'set-cookie': browserCookie(ctx, provider).set(browser, COOKIE_MAX_AGE) } };
    } catch (e) {
      if (e instanceof Refusal) return outcome(ctx, mode, provider, e.message);
      // The chain or the packet memory failed: said on the person's page, only the error's class logged.
      ctx.log('error', 'oauth-failed', { channel: provider, step: 'start', error: e instanceof Error ? e.name : typeof e });
      return outcome(ctx, mode, provider, NOT_RECORDED);
    }
  }

  /** The provider's answer as JSON, or `null` (its text is read, never logged: it may quote a token). */
  async function call(ctx: Ctx, step: 'token' | 'user', url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const text = await res.text();
      if (!res.ok) {
        ctx.log('warn', 'oauth-provider-failed', { channel: provider, step, status: res.status });
        return null;
      }
      const json: unknown = JSON.parse(text);
      return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    } catch (e) {
      ctx.log('warn', 'oauth-provider-failed', { channel: provider, step, error: e instanceof Error ? e.name : typeof e });
      return null;
    }
  }

  /** Exchange the code for a token, read the account, forget the token. */
  async function account(ctx: Ctx, code: string, verifier: string): Promise<{ shown: string; proved: ProvedAccount } | null> {
    const id = ctx.cfg.env[spec.id] ?? '';
    const secret = ctx.cfg.env[spec.secret] ?? '';
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(ctx), code_verifier: verifier, client_id: id });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (provider === 'x') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    else form.set('client_secret', secret);
    const token = await call(ctx, 'token', urls.token, { method: 'POST', headers, body: form.toString() });
    const accessToken = token?.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    const user = await call(ctx, 'user', urls.user, {
      headers: { authorization: `Bearer ${accessToken}`, accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json', 'user-agent': USER_AGENT },
    });
    if (user === null) return null;
    const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    if (provider === 'x') {
      const data = user.data;
      const username = typeof data === 'object' && data !== null ? text((data as Record<string, unknown>).username) : null;
      return username === null ? null : { shown: username, proved: username };
    }
    if (provider === 'discord') {
      const username = text(user.username);
      const idText = text(user.id);
      return username === null && idText === null ? null : { shown: username ?? idText!, proved: { username, id: idText } };
    }
    const login = text(user.login);
    return login === null ? null : { shown: login, proved: login };
  }

  const short = (value: string): string => {
    const clean = value.trim().replace(/^@/, '');
    return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
  };

  async function callback(ctx: Ctx, req: Request): Promise<Reply> {
    const cookie = browserCookie(ctx, provider);
    const clear = { 'set-cookie': cookie.set('', 0) };
    const given = req.query.get('state');
    const state = given !== null && STATE.test(given) ? ctx.store.take<State>(KIND, stateId(given)) : null;
    // Without a state, the mode is unknown: the page also works as a full page (it goes back to the site).
    if (state === null || state.provider !== provider) {
      ctx.log('info', 'oauth-refused', { channel: provider, reason: 'state' });
      return outcome(ctx, 'popup', provider, EXPIRED, clear);
    }
    const refuse = (reason: string, sentence: string): Reply => {
      ctx.log('info', 'oauth-refused', { who: state.address, channel: provider, reason });
      return outcome(ctx, state.mode, provider, sentence, clear);
    };
    // The browser that comes back must be the one that started: the state alone could be a link someone forwarded.
    const browser = cookies(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined).get(cookie.name) ?? '';
    const expected = Buffer.from(state.browser, 'utf8');
    const seen = Buffer.from(sha256(browser), 'utf8');
    if (browser === '' || seen.length !== expected.length || !timingSafeEqual(seen, expected)) return refuse('browser', OTHER_BROWSER);
    try {
      return await finish(ctx, req, state, refuse, clear);
    } catch (e) {
      ctx.log('error', 'oauth-failed', { channel: provider, step: 'callback', error: e instanceof Error ? e.name : typeof e });
      return outcome(ctx, state.mode, provider, NOT_RECORDED, clear);
    }
  }

  async function finish(ctx: Ctx, req: Request, state: State, refuse: (reason: string, sentence: string) => Reply, clear: Record<string, string>): Promise<Reply> {
    if (req.query.get('error') !== null) return refuse('provider-error', `The sign-in to ${label} was cancelled.`);
    const code = req.query.get('code');
    if (code === null || code === '') return refuse('no-code', failed);
    const proved = await account(ctx, code, state.verifier);
    if (proved === null) return refuse('provider', failed);

    let field: { commitment: string; value: string; private: boolean };
    try {
      field = await current(ctx, state.address, state.packet);
    } catch (e) {
      if (e instanceof Refusal) return refuse('field', e.message);
      throw e;
    }
    if (field.commitment.toLowerCase() !== state.commitment.toLowerCase()) return refuse('stale', explain(key, { ok: false, reason: 'stale' }));
    if (!sameHandle(spec.kind, field.value, proved.proved)) {
      const onChain = field.private ? 'something else' : `${spec.at}${short(field.value)}`;
      return refuse('other-account', `You signed in to ${label} as ${spec.at}${short(proved.shown)}, but this identity says ${onChain}.`);
    }
    const result = await ctx.chain.attest(state.address, key, state.commitment, 'OAuth');
    if (!result.ok) return refuse(result.reason, explain(key, result));
    ctx.log('info', 'oauth-verified', { who: state.address, channel: provider });
    return outcome(ctx, state.mode, provider, null, clear);
  }

  return {
    name: provider,
    enabled: (cfg) => hasEnv(cfg, spec.id, spec.secret),
    register(router: Router, ctx: Ctx): void {
      router.route('GET', `/oauth/${provider}/start`, (req) => start(ctx, req));
      router.route('GET', `/oauth/${provider}/callback`, (req) => callback(ctx, req));
    },
  };
}

/** The three OAuth channels, `x`, `discord` and `github`, each enabled by its own client id and secret. */
export function oauthChannels(options: OAuthOptions = {}): Channel[] {
  return (['x', 'discord', 'github'] as const).map((p) => oauthChannel(p, options));
}
