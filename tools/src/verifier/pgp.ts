// PGP channel (method `PgpSignature`): the person signs a challenge with the key whose
// fingerprint their identity holds.
//
//   POST /api/pgp/challenge {address, packet?}                  -> { challenge, session }
//   POST /api/pgp/verify    {address, session, signed, key?, packet?} -> { verified: true }
//
// The challenge is one ASCII line that says what the signer agrees to:
// `identitee verification: link this key to identity <address> on chain <first 10 hex of the genesis> nonce <32 hex>`.
// It is kept 15 minutes under a random `session` only the page that asked holds (the row's id is an HMAC of
// the address and the session under `<STATE_DIRECTORY>/pgp.key`), with the field's commitment at that time,
// and taken once. `signed` is a clearsigned message (`gpg --clearsign`) or an armored detached signature; the
// text a clearsigned message shows must be the challenge once line endings and trailing white space are
// normalized, and the signature is then checked over the stored challenge itself (with or without its final
// line ending), never over the pasted text. The key comes from keys.openpgp.org by fingerprint (through the
// hardened fetch of web.ts), merged with the armored public key the person may paste (so a revocation the
// keyserver knows is kept); its primary fingerprint must be the one on chain (20 bytes v4, 32 bytes v6), and
// the signature may come from it or from one of its signing subkeys. An expired or revoked key, or a
// signature made while the key was not valid, is refused. Pasted texts are 64 KB at most and never logged.
//
// A private fingerprint is read from the packet of the challenge (or of the verify request), kept in memory
// only (`PacketMemory`), never in SQLite. It is never sent to keys.openpgp.org (the keyserver would learn
// it): verifying a private one requires the pasted key, whose own expiry and revocations are checked.

import { randomBytes } from 'node:crypto';

import * as openpgp from 'openpgp';

import { canonicalAddress, explain, FIELD_LABELS, type FieldKey } from './chain.ts';
import { objectOf as object, startAllowed, type Channel } from './channels.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Request, type Router } from './http.ts';
import { loadKey, mac } from './keyed.ts';
import { resolvePrivate } from './packet.ts';
import { fetchPublic, type NetOptions } from './web.ts';

const KEY: FieldKey = { Typed: 'Pgp' };
const KIND = 'pgp-challenge';
const KEY_FILE = 'pgp.key';
const HOUR = 60 * 60_000;
export const CHALLENGE_TTL_MS = 15 * 60_000;
/** Signatures tried per challenge. */
export const MAX_TRIES = 5;
const VERIFIES_PER_IP_HOUR = 60;
/** The largest pasted signature or key. */
export const MAX_PASTE = 64 * 1024;
const KEYSERVER = 'https://keys.openpgp.org';
const KEYSERVER_TIMEOUT_MS = 5_000;
const SESSION = /^[A-Za-z0-9_-]{22}$/;
const FINGERPRINT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE_BLOCK = /-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/;

const LABEL = FIELD_LABELS.Pgp;
const STALE = explain(KEY, { ok: false, reason: 'stale' });
const GONE = explain(KEY, { ok: false, reason: 'gone' });
const PASTE_PRIVATE = `Paste your public key to verify a private ${LABEL}.`;
const TOO_MANY = 'Too many attempts. Try again later.';
const PASTE_WHOLE = 'Paste the whole output of the sign command, from the first -----BEGIN PGP line to the last -----END PGP line.';
const INVALID = `The ${LABEL} fingerprint on your identity is not a valid fingerprint.`;
const NOT_SIGNED_BY_KEY = 'This signature is not from your key, or not of this challenge.';

export interface PgpOptions {
  /** How keys.openpgp.org is reached (tests: a local server). */
  net?: NetOptions;
  /** The keyserver's base URL (https). */
  keyserver?: string;
}

/** What a challenge keeps: the text, the commitment of the field at that time, the packet id of a private one. */
interface Pending {
  challenge: string;
  commitment: string;
  packet?: string;
  /** Milliseconds since the epoch, to put the row back with its remaining time. */
  expires: number;
}

const expired = (): HttpError => new HttpError(400, 'This challenge has expired. Ask for a new one.');


/** A text as it was signed in a clearsigned message: LF line endings, no trailing white space on a line or at the end. */
export const signedText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

function addressOf(body: Record<string, unknown>): string {
  const given = body.address;
  const address = typeof given === 'string' ? canonicalAddress(given) : null;
  if (address === null) throw new HttpError(400, 'This is not a valid account address.');
  return address;
}

/** A pasted text: absent, or a string of 64 KB at most. */
function pasted(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, PASTE_WHOLE);
  if (Buffer.byteLength(value, 'utf8') > MAX_PASTE) throw new HttpError(400, 'What you pasted is too long.');
  return value;
}

/** The field as it is now: the fingerprint (lowercase hex) and its commitment, or the sentence that says why not. */
async function current(ctx: Ctx, address: string, packet: unknown, fromStart: boolean): Promise<{ fingerprint: string; commitment: string; private: boolean } | string> {
  const field = await ctx.chain.field(address, KEY);
  if (field === null) return fromStart ? `Add your ${LABEL} to your identity first.` : GONE;
  let fingerprint: string;
  if (field.private) {
    if (packet === undefined || packet === null) return fromStart ? `Unlock your identity to verify a private ${LABEL}.` : STALE;
    const resolved = await resolvePrivate(ctx, address, KEY, packet);
    if ('error' in resolved) return resolved.error;
    fingerprint = resolved.value;
  } else {
    fingerprint = field.value ?? '';
  }
  fingerprint = fingerprint.trim().toLowerCase().replace(/^0x/, '');
  if (!FINGERPRINT.test(fingerprint)) return INVALID;
  return { fingerprint, commitment: field.commitment, private: field.private };
}

export function pgpChannel(options: PgpOptions = {}): Channel {
  const keyserver = (options.keyserver ?? KEYSERVER).replace(/\/+$/, '');
  let root: Buffer | undefined;
  const keyOf = (ctx: Ctx): Buffer => (root ??= loadKey(ctx.cfg.stateDir, KEY_FILE));

  /** The key keys.openpgp.org has for `fingerprint`, null when it has none or cannot be reached. */
  async function fromKeyserver(fingerprint: string): Promise<openpgp.PublicKey | null> {
    const got = await fetchPublic(`${keyserver}/vks/v1/by-fingerprint/${fingerprint.toUpperCase()}`, {
      ...options.net,
      timeoutMs: KEYSERVER_TIMEOUT_MS,
      maxBytes: MAX_PASTE,
    });
    if (!got.ok || got.status !== 200 || got.truncated) return null;
    try {
      const key = await openpgp.readKey({ armoredKey: got.body.toString('utf8') });
      return !key.isPrivate() && key.getFingerprint() === fingerprint ? key : null;
    } catch {
      return null;
    }
  }

  async function challenge(ctx: Ctx, req: Request): Promise<unknown> {
    const key = keyOf(ctx);
    const body = object(req.body);
    const address = addressOf(body);
    if (!startAllowed(ctx, req.ip)) throw new HttpError(429, TOO_MANY);
    const packet = body.packet ?? body.packetId;
    const seen = await current(ctx, address, packet, true);
    if (typeof seen === 'string') throw new HttpError(400, seen);
    const text = `identitee verification: link this key to identity ${address} on chain ${ctx.chain.genesis.replace(/^0x/, '').slice(0, 10).toLowerCase()} nonce ${randomBytes(16).toString('hex')}`;
    const session = randomBytes(16).toString('base64url');
    const pending: Pending = { challenge: text, commitment: seen.commitment, expires: ctx.now() + CHALLENGE_TTL_MS };
    // The fingerprint of a private field stays in memory, under a packet of its own.
    if (seen.private) pending.packet = ctx.packets.put({ address, key: KEY, value: seen.fingerprint, commitment: seen.commitment });
    ctx.store.put(KIND, mac(key, 'row', address, session).toString('base64url'), pending, CHALLENGE_TTL_MS);
    ctx.log('info', 'pgp-challenge', { who: address });
    return { challenge: text, session };
  }

  /**
   * The key to check the signature with: the keyserver's, merged with the pasted one. For a private
   * fingerprint the keyserver is never asked (it would learn the value): the pasted key alone.
   */
  async function keyFor(ctx: Ctx, fingerprint: string, armored: string | undefined, date: Date, secret: boolean): Promise<openpgp.PublicKey> {
    if (secret && armored === undefined) throw new HttpError(400, PASTE_PRIVATE);
    let mine: openpgp.PublicKey | null = null;
    if (armored !== undefined) {
      let read: openpgp.Key;
      try {
        read = await openpgp.readKey({ armoredKey: armored });
      } catch {
        throw new HttpError(400, 'This is not a PGP public key.');
      }
      if (read.isPrivate()) throw new HttpError(400, 'Paste your public key, never your private key.');
      if (read.getFingerprint() !== fingerprint) throw new HttpError(400, 'This key is not the one on your identity.');
      mine = read as openpgp.PublicKey;
    }
    const published = secret ? null : await fromKeyserver(fingerprint);
    ctx.log('info', 'pgp-key', { keyserver: published !== null, pasted: mine !== null });
    if (published !== null && mine !== null) {
      try {
        return await published.update(mine, date);
      } catch {
        return published;
      }
    }
    const key = published ?? mine;
    if (key === null) throw new HttpError(400, 'Your key is not on keys.openpgp.org. Paste your public key.');
    return key;
  }

  /** Whether `signature` is a valid signature by `key` of `text`, with or without its final line ending. */
  async function signs(key: openpgp.PublicKey, signature: openpgp.Signature, text: string, date: Date): Promise<boolean> {
    for (const candidate of [text, `${text}\n`, `${text}\r\n`]) {
      try {
        const message = await openpgp.createMessage({ binary: new TextEncoder().encode(candidate) });
        const result = await openpgp.verify({ message, signature, verificationKeys: key, date, expectSigned: true, format: 'binary' });
        await Promise.any(result.signatures.map((s) => s.verified));
        return true;
      } catch {
        // not this one
      }
    }
    return false;
  }

  async function verify(ctx: Ctx, req: Request): Promise<unknown> {
    const key = keyOf(ctx);
    const body = object(req.body);
    const address = addressOf(body);
    const signed = pasted(body.signed);
    const armoredKey = pasted(body.key);
    if (signed === undefined) throw new HttpError(400, 'Paste the signed challenge.');
    if (typeof body.session !== 'string' || !SESSION.test(body.session)) throw expired();
    if (!ctx.store.hit('pgp-verify', req.ip, VERIFIES_PER_IP_HOUR, HOUR)) throw new HttpError(429, TOO_MANY);
    const id = mac(key, 'row', address, body.session).toString('base64url');
    const pending = ctx.store.get<Pending>(KIND, id);
    if (pending === null) throw expired();
    const tries = ctx.store.bump(KIND, id);
    if (tries === null) throw expired();
    if (tries > MAX_TRIES) {
      ctx.store.drop(KIND, id);
      throw new HttpError(429, 'Too many tries. Ask for a new challenge.');
    }

    // The field is still the one of the challenge.
    const seen = await current(ctx, address, body.packet ?? body.packetId ?? pending.packet, false);
    // A field changed or gone since the challenge is a conflict; anything else (a packet expired or wrong) is the request's.
    if (typeof seen === 'string') throw new HttpError(seen === STALE || seen === GONE ? 409 : 400, seen);
    if (seen.commitment.toLowerCase() !== pending.commitment.toLowerCase()) throw new HttpError(409, STALE);
    if (seen.private && armoredKey === undefined) throw new HttpError(400, PASTE_PRIVATE);

    const date = new Date(ctx.now());
    const block = SIGNATURE_BLOCK.exec(signed)?.[0];
    if (block === undefined) throw new HttpError(400, PASTE_WHOLE);
    if (signed.includes('-----BEGIN PGP SIGNED MESSAGE-----')) {
      let shown: string;
      try {
        shown = (await openpgp.readCleartextMessage({ cleartextMessage: signed.trim() })).getText();
      } catch {
        throw new HttpError(400, PASTE_WHOLE);
      }
      if (signedText(shown) !== pending.challenge) throw new HttpError(400, 'The signed text is not the challenge. Sign the exact challenge shown.');
    }
    let signature: openpgp.Signature;
    try {
      signature = await openpgp.readSignature({ armoredSignature: block });
    } catch {
      throw new HttpError(400, PASTE_WHOLE);
    }

    const publicKey = await keyFor(ctx, seen.fingerprint, armoredKey, date, seen.private);
    if (await publicKey.isRevoked(undefined, undefined, date).catch(() => true)) throw new HttpError(400, 'This key is revoked.');
    try {
      await publicKey.verifyPrimaryKey(date);
    } catch {
      throw new HttpError(400, 'This key has expired or is not valid.');
    }
    if (!(await signs(publicKey, signature, pending.challenge, date))) {
      ctx.log('info', 'pgp-refused', { who: address });
      throw new HttpError(400, NOT_SIGNED_BY_KEY);
    }

    // Taken in one statement: two good signatures never both attest.
    const taken = ctx.store.take<Pending>(KIND, id);
    if (taken === null) throw expired();
    const result = await ctx.chain.attest(address, KEY, taken.commitment, 'PgpSignature');
    if (!result.ok) {
      // The signature was good: if only the chain failed, the challenge stays for the time it had left.
      if (result.reason === 'failed' && ctx.store.get(KIND, id) === null) ctx.store.put(KIND, id, taken, Math.max(taken.expires - ctx.now(), 1));
      throw new HttpError(result.reason === 'failed' ? 502 : 409, explain(KEY, result));
    }
    ctx.log('info', 'pgp-verified', { who: address });
    return { verified: true };
  }

  return {
    name: 'pgp',
    enabled: () => true,
    register(router: Router, ctx: Ctx): void {
      router.route('POST', '/api/pgp/challenge', (req) => challenge(ctx, req));
      // A signature and a key of 64 KB each, JSON-escaped.
      router.route('POST', '/api/pgp/verify', (req) => verify(ctx, req), { maxBody: 3 * MAX_PASTE });
    },
    /** Make the key at startup (an unwritable state directory stops the service, not the first request). */
    async start(ctx: Ctx): Promise<void> {
      keyOf(ctx);
    },
  };
}
