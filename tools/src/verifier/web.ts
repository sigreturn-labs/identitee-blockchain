// Website channel (methods `WebFile` and `Dns`): the person shows they control the site their
// identity names, with a file or a DNS record that holds their address.
//
//   POST /api/web/check {address}   -> { verified: true, method: 'WebFile' | 'Dns' }
//
// The host is the one of the Web URL on chain (lowercase, punycode; `https://` when the value has no
// scheme). The service first reads `https://<host>/.well-known/identitee.txt`: it attests `WebFile` when
// one of the file's whitespace-separated words is the account's address, in any SS58 prefix. Otherwise it
// reads the TXT records of `_identitee.<host>`, then of `<host>`: a record `identitee=<address>` (any prefix)
// attests `Dns`. Neither: one sentence, nothing written. A private Web field is not verified automatically:
// fetching a site only the person knows would tell its owner who looks.
//
// The service runs next to the node's RPC on 127.0.0.1, so the fetch is hardened against reaching inside
// (`fetchPublic`): the host is resolved by the service itself and refused when ANY of its addresses is
// loopback, private, link-local, CGNAT, unspecified, multicast or reserved (IPv4-mapped forms included);
// the connection then goes to the very address that was checked, with the host's name for SNI and the
// certificate, so a DNS answer that changes between the check and the connection cannot reach an internal
// address. HTTPS on port 443 only, 5 s for everything, 4 KB read at most, at most 3 redirects and only to
// https on the same host (checked again at each hop), no cookies, `User-Agent: identitee-verifier`.
//
// The value on chain must be written plainly (`[https://]<host>[:443][/path]`, see `websiteHost`): a URL
// that a parser and a reader would see differently is refused.
//
// Limits: proof starts per IP (bucket `start`, shared with the other channels), and 10 checks per hour
// for an account from one IP.

import { promises as dns } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { domainToASCII } from 'node:url';

import { isHex, u8aEq } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';

import { canonicalAddress, explain, type FieldKey } from './chain.ts';
import { objectOf as object, startAllowed, type Channel } from './channels.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Request, type Router } from './http.ts';

const KEY: FieldKey = { Typed: 'Web' };
const HOUR = 60 * 60_000;
const CHECKS_PER_IP_ADDRESS_HOUR = 10;
export const WELL_KNOWN = '/.well-known/identitee.txt';
export const USER_AGENT = 'identitee-verifier';
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 4 * 1024;
const MAX_REDIRECTS = 3;
const DNS_TIMEOUT_MS = 3_000;

// --- Addresses that must never be reached -------------------------------------------------------------

/** The 4 bytes of a dotted IPv4 address, null otherwise. */
function v4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

/** The 16 bytes of an IPv6 address (an embedded dotted IPv4 tail included), null otherwise. */
function v6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.split('%')[0]!.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const v4 = v4Bytes(tail[1]!);
    if (v4 === null) return null;
    text = `${text.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/** Whether `bytes` starts with the first `bits` bits of `prefix`. */
function within(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if ((bytes[byte]! & mask) !== (prefix[byte]! & mask)) return false;
  }
  return true;
}

const V4_BLOCKED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // this network, unspecified
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (cloud metadata)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
];

const V6_BLOCKED: Array<[number[], number]> = [
  [Array<number>(16).fill(0), 96], // unspecified, loopback, IPv4-compatible
  [[0xfc, ...Array<number>(15).fill(0)], 7], // unique local
  [[0xfe, 0x80, ...Array<number>(14).fill(0)], 10], // link-local
  [[0xfe, 0xc0, ...Array<number>(14).fill(0)], 10], // site-local (deprecated)
  [[0xff, ...Array<number>(15).fill(0)], 8], // multicast
  [[0x01, 0x00, ...Array<number>(14).fill(0)], 64], // discard
  [[0x20, 0x01, 0x0d, 0xb8, ...Array<number>(12).fill(0)], 32], // documentation
  [[0, 0x64, 0xff, 0x9b, 0, 0x01, ...Array<number>(10).fill(0)], 48], // local-use NAT64 (where the IPv4 sits depends on the operator)
];

/** IPv6 forms that carry an IPv4 address, judged by it: prefix, length, and the byte where the IPv4 starts. */
const V6_EMBEDS_V4: Array<[number[], number, number]> = [
  [[...Array<number>(10).fill(0), 0xff, 0xff, 0, 0, 0, 0], 96, 12], // IPv4-mapped ::ffff:0:0/96
  [[...Array<number>(8).fill(0), 0xff, 0xff, 0, 0, 0, 0, 0, 0], 96, 12], // SIIT ::ffff:0:0:0/96
  [[0, 0x64, 0xff, 0x9b, ...Array<number>(12).fill(0)], 96, 12], // NAT64 64:ff9b::/96
  [[0x20, 0x02, ...Array<number>(14).fill(0)], 16, 2], // 6to4 2002::/16
];

/** Whether the service must not connect to `ip`: anything that is not a public unicast address (or not an address). */
export function blockedAddress(ip: string): boolean {
  const v4 = v4Bytes(ip);
  if (v4 !== null) return V4_BLOCKED.some(([prefix, bits]) => within(v4, prefix, bits));
  const v6 = v6Bytes(ip);
  if (v6 === null) return true;
  for (const [prefix, bits, at] of V6_EMBEDS_V4) if (within(v6, prefix, bits)) return blockedAddress(v6.slice(at, at + 4).join('.'));
  return V6_BLOCKED.some(([prefix, bits]) => within(v6, prefix, bits));
}

// --- The host of a Web field --------------------------------------------------------------------------

/**
 * The host of the website on chain, lowercase and punycode, without a trailing dot; `ip` when it is an IP
 * address; null when the value is not written in plain form. Plain means `[https://]<host>[:443][/path]`:
 * no other scheme, no user or password, no `@`, `\` or `%` around the host, no other port, no query or
 * fragment, and the host as written must be the host the URL parser finds. Anything else could make the
 * service verify one host while a person reading the field sees another (`https://victim.example@evil.example`).
 */
export function websiteHost(value: string): string | 'ip' | null {
  const raw = value.trim();
  if (raw === '' || /[\s\\?#]/.test(raw)) return null;
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname.startsWith('[') || isIP(url.hostname) !== 0) return 'ip';
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '') return null;
  const rest = text.slice(text.indexOf('://') + 3);
  const authority = rest.split('/', 1)[0]!;
  if (/[@%]/.test(authority)) return null;
  const written = authority.replace(/:443$/, '').toLowerCase();
  if (written === '' || written.includes(':') || domainToASCII(written) !== url.hostname) return null;
  const host = url.hostname.replace(/\.$/, '');
  if (!host.includes('.') || host.length > 253) return null;
  return host;
}

// --- A fetch that cannot reach inside -----------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Every address of a host name (the system's `getaddrinfo`, as `dns.lookup(host, {all: true})`). */
export type Lookup = (host: string) => Promise<ResolvedAddress[]>;

export interface NetOptions {
  lookup?: Lookup;
  /** Tests only: where a checked address is dialled (by default the address itself, port 443). */
  dial?: (address: ResolvedAddress) => { host: string; port: number };
  /** Tests only: the certificate authority to trust instead of the system's. */
  ca?: string | Buffer;
}

export interface FetchLimits {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export type Fetched =
  | { ok: true; status: number; body: Buffer; truncated: boolean }
  | { ok: false; reason: 'url' | 'blocked' | 'redirect' | 'timeout' | 'network' };

const systemLookup: Lookup = async (host) => dns.lookup(host, { all: true, verbatim: true });

class Refused extends Error {
  constructor(readonly reason: Exclude<Fetched, { ok: true }>['reason']) {
    super(reason);
  }
}

/** The answer of one GET to `url` on the checked `target`: its status, its Location, at most `maxBytes` of its body. */
function getOnce(url: URL, target: ResolvedAddress, net: NetOptions, maxBytes: number, signal: AbortSignal): Promise<{ status: number; location?: string; body: Buffer; truncated: boolean }> {
  const dialled = net.dial?.(target) ?? { host: target.address, port: 443 };
  const family = isIP(dialled.host);
  // The connection goes to the address that was checked, whatever the name resolves to now.
  const lookup: LookupFunction = (_host, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, all: ResolvedAddress[]) => void)(null, [{ address: dialled.host, family }]);
    else callback(null, dialled.host, family);
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: url.hostname,
        servername: url.hostname,
        port: dialled.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.hostname, 'user-agent': USER_AGENT, accept: 'text/plain, */*' },
        lookup,
        agent: false,
        ca: net.ca,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        if (status !== 200) {
          res.destroy();
          resolve({ status, location, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (truncated: boolean): void => {
          if (done) return;
          done = true;
          resolve({ status, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size > maxBytes) {
            finish(true);
            res.destroy();
          }
        });
        res.on('end', () => finish(false));
        res.on('error', (e) => (done ? undefined : reject(e)));
        res.on('close', () => (done ? undefined : reject(new Error('closed'))));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET `url` (https, port 443) on the public Internet only: refused before connecting when the host is an
 * IP address or any of its addresses is not public, and connected to the address that was checked.
 * Redirects are followed on the same host over https only, each hop checked again.
 */
export async function fetchPublic(url: string, options: NetOptions & FetchLimits = {}): Promise<Fetched> {
  const lookup = options.lookup ?? systemLookup;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Refused('timeout')), { once: true }));
  aborted.catch(() => undefined);
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { ok: false, reason: 'url' };
    }
    const host = current.hostname;
    const good = (u: URL): boolean => u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && u.hostname === host;
    if (!good(current) || host.startsWith('[') || isIP(host) !== 0) return { ok: false, reason: 'url' };
    for (let hop = 0; ; hop++) {
      let addresses: ResolvedAddress[];
      try {
        addresses = await Promise.race([lookup(host), aborted]);
      } catch (e) {
        if (e instanceof Refused) throw e;
        return { ok: false, reason: 'network' };
      }
      if (addresses.length === 0 || addresses.some((a) => blockedAddress(a.address))) return { ok: false, reason: 'blocked' };
      const answer = await Promise.race([getOnce(current, addresses[0]!, options, maxBytes, controller.signal), aborted]);
      if (REDIRECTS.has(answer.status) && answer.location !== undefined) {
        if (hop >= maxRedirects) return { ok: false, reason: 'redirect' };
        let next: URL;
        try {
          next = new URL(answer.location, current);
        } catch {
          return { ok: false, reason: 'redirect' };
        }
        if (!good(next)) return { ok: false, reason: 'redirect' };
        current = next;
        continue;
      }
      return { ok: true, status: answer.status, body: answer.body, truncated: answer.truncated };
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// --- Matching the address -----------------------------------------------------------------------------

/** Whether `word` is an SS58 address (any prefix; not hex) of the account whose public key is `key`. */
export function isAddressOf(word: string, key: Uint8Array): boolean {
  if (word === '' || isHex(word) || word.length > 64) return false;
  try {
    return u8aEq(decodeAddress(word), key);
  } catch {
    return false;
  }
}

/** Whether one of the whitespace-separated words of `text` is the account's address. */
export const textHolds = (text: string, key: Uint8Array): boolean => text.trim().split(/\s+/).some((word) => isAddressOf(word, key));

export type TxtResolver = (name: string) => Promise<string[][]>;

function systemTxt(): TxtResolver {
  const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  return (name) => resolver.resolveTxt(name);
}

// --- The channel ----------------------------------------------------------------------------------------

export interface WebOptions {
  net?: NetOptions;
  resolveTxt?: TxtResolver;
  /** For the file, everything included (5 s). */
  timeoutMs?: number;
}

export function webChannel(options: WebOptions = {}): Channel {
  const net = options.net ?? {};
  const resolveTxt = options.resolveTxt ?? systemTxt();

  async function viaFile(host: string, key: Uint8Array): Promise<boolean | string> {
    const got = await fetchPublic(`https://${host}${WELL_KNOWN}`, { ...net, timeoutMs: options.timeoutMs ?? TIMEOUT_MS, maxBytes: MAX_BYTES });
    if (!got.ok) return got.reason;
    if (got.status !== 200) return 'status';
    return textHolds(got.body.toString('utf8'), key) || 'mismatch';
  }

  async function viaDns(host: string, key: Uint8Array): Promise<boolean> {
    for (const name of [`_identitee.${host}`, host]) {
      let records: string[][];
      try {
        records = await resolveTxt(name);
      } catch {
        continue; // no such name or no TXT: the next one
      }
      for (const chunks of records) {
        const found = /^identitee=(\S+)$/i.exec(chunks.join('').trim());
        if (found !== null && isAddressOf(found[1]!, key)) return true;
      }
    }
    return false;
  }

  async function check(ctx: Ctx, req: Request): Promise<unknown> {
    const given = object(req.body).address;
    const address = typeof given === 'string' ? canonicalAddress(given) : null;
    if (address === null) throw new HttpError(400, 'This is not a valid account address.');
    if (!startAllowed(ctx, req.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    // Keyed on the IP too: someone else's checks cannot lock the owner out.
    if (!ctx.store.hit('web-check', `${req.ip} ${address}`, CHECKS_PER_IP_ADDRESS_HOUR, HOUR)) throw new HttpError(429, 'Too many checks for this website. Try again in an hour.');
    const field = await ctx.chain.field(address, KEY);
    if (field === null) throw new HttpError(400, 'Add your Website to your identity first.');
    if (field.private) throw new HttpError(400, 'Make your website public to verify it.');
    const host = websiteHost(field.value ?? '');
    if (host === 'ip') throw new HttpError(400, 'Use a domain name for your website, not an IP address.');
    if (host === null) throw new HttpError(400, 'Write your website as a plain address, like example.com.');
    const key = ctx.chain.decodeAddress(address);

    const file = await viaFile(host, key);
    const method = file === true ? 'WebFile' : (await viaDns(host, key)) ? 'Dns' : null;
    if (method === null) {
      ctx.log('info', 'web-not-found', { who: address, file });
      throw new HttpError(400, 'Neither the file nor the DNS record was found.');
    }
    const result = await ctx.chain.attest(address, KEY, field.commitment, method);
    if (!result.ok) throw new HttpError(result.reason === 'failed' ? 502 : 409, explain(KEY, result));
    ctx.log('info', 'web-verified', { who: address, method });
    return { verified: true, method };
  }

  return {
    name: 'web',
    enabled: () => true,
    register(router: Router, ctx: Ctx): void {
      router.route('POST', '/api/web/check', (req) => check(ctx, req));
    },
  };
}
