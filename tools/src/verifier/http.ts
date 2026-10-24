// A small JSON HTTP server on node:http, behind nginx: exact-path routes, JSON bodies up to 16 KB (a
// route may allow more, for a pasted PGP key), CORS for the site's origin only, errors as
// `{ "error": "<one English sentence>" }`. The client's IP comes from X-Forwarded-For only when the
// connection is from nginx on 127.0.0.1.

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from './log.ts';

export const MAX_BODY = 16 * 1024;
export const SITE_ORIGIN = 'https://identit.ee';

/** A refusal a handler throws: its status and the sentence the front shows. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The client's IP (X-Forwarded-For when from 127.0.0.1). */
  ip: string;
  /** The parsed JSON body, `undefined` if there is none or it is not JSON. */
  body: unknown;
  /** The body as received (HMAC of a webhook). */
  rawBody: Buffer;
}

/** A plain value is sent as JSON with status 200. */
export type Reply =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; redirect: string; headers?: Record<string, string> }
  | { status?: number; html: string; headers?: Record<string, string> };

const isReply = (value: unknown): value is Reply =>
  typeof value === 'object' && value !== null && ('json' in value || 'redirect' in value || 'html' in value) && Object.keys(value).every((k) => ['status', 'json', 'redirect', 'html', 'headers'].includes(k));

export type Handler = (req: Request) => unknown | Reply | Promise<unknown>;

/** What a channel registers its endpoints on. */
export interface Router {
  route(method: 'GET' | 'POST', path: string, handler: Handler, options?: RouteOptions): void;
}

export interface RouteOptions {
  /** The largest body this route reads, in bytes (default `MAX_BODY`). */
  maxBody?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The client's IP: the last X-Forwarded-For entry (the one nginx added) when the connection is from
 * the loopback, the connection's address otherwise. */
export function clientIp(remote: string | undefined, forwarded: string | string[] | undefined): string {
  const peer = remote ?? '';
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (LOOPBACK.has(peer) && header) {
    const last = header.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return peer.startsWith('::ffff:') ? peer.slice(7) : peer;
}

/** Whether a browser on `origin` may call the API. */
export function allowedOrigin(origin: string, dev: boolean): boolean {
  if (origin === SITE_ORIGIN) return true;
  return dev && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(origin);
}

/** The request's cookies by name (the first of a repeated name wins); values are not decoded. */
export function cookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== '' && !out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) {
      reject(new TooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new TooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class HttpServer implements Router {
  private readonly routes = new Map<string, Map<string, Handler>>();
  private readonly limits = new Map<string, number>();
  private server: Server | undefined;

  constructor(private readonly options: { dev: boolean; log: Logger }) {}

  route(method: 'GET' | 'POST', path: string, handler: Handler, options: RouteOptions = {}): void {
    const byMethod = this.routes.get(path) ?? new Map<string, Handler>();
    if (byMethod.has(method)) throw new Error(`route ${method} ${path} registered twice`);
    byMethod.set(method, handler);
    if (options.maxBody !== undefined) this.limits.set(`${method} ${path}`, options.maxBody);
    this.routes.set(path, byMethod);
  }

  /** Listen on `host:port` (0: any free port); the port. */
  listen(port: number, host: string): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return Promise.resolve();
    this.server = undefined;
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const send = (status: number, body: string, type: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { ...headers, 'content-type': type, ...extra });
      res.end(body);
    };
    const json = (status: number, value: unknown, extra?: Record<string, string>): void => send(status, JSON.stringify(value), 'application/json; charset=utf-8', extra);
    const fail = (status: number, sentence: string): void => json(status, { error: sentence });
    try {
      const url = new URL(req.url ?? '/', 'http://verifier');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        // A browser on another site: refused outright, so that no side effect happens either.
        if (!allowedOrigin(origin, this.options.dev)) return fail(403, 'This origin is not allowed.');
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      const byMethod = this.routes.get(url.pathname);
      if (req.method === 'OPTIONS') {
        if (origin === undefined || byMethod === undefined) return fail(byMethod === undefined ? 404 : 400, 'There is nothing here.');
        res.writeHead(204, {
          ...headers,
          'access-control-allow-methods': [...byMethod.keys()].join(', '),
          'access-control-allow-headers': 'Content-Type',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
      if (byMethod === undefined) return fail(404, 'There is nothing here.');
      const handler = byMethod.get(req.method ?? '');
      if (handler === undefined) return fail(405, 'This method is not allowed here.');
      let rawBody: Buffer;
      try {
        rawBody = await readBody(req, this.limits.get(`${req.method} ${url.pathname}`) ?? MAX_BODY);
      } catch (e) {
        if (e instanceof TooLarge) return fail(413, 'The request is too large.');
        throw e;
      }
      let body: unknown;
      if (rawBody.length > 0 && /\bjson\b/i.test(req.headers['content-type'] ?? '')) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return fail(400, 'The request is not valid JSON.'); // the parser's message would quote the body
        }
      }
      const request: Request = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        ip: clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']),
        body,
        rawBody,
      };
      const out = await handler(request);
      if (!isReply(out)) return json(200, out);
      const status = out.status ?? ('redirect' in out ? 302 : 200);
      if ('redirect' in out) {
        res.writeHead(status, { ...headers, ...out.headers, location: out.redirect });
        res.end();
      } else if ('html' in out) {
        send(status, out.html, 'text/html; charset=utf-8', out.headers);
      } else {
        json(status, out.json, out.headers);
      }
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      // Only the error's class: its message could quote input (a code, a private value).
      this.options.log('error', 'request-failed', { path: (req.url ?? '').split('?')[0], error: e instanceof Error ? e.name : typeof e });
      if (!res.headersSent) fail(500, 'Something went wrong. Try again in a moment.');
      else res.end();
    }
  }
}
