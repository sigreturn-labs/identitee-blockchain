// The channels (email, OAuth, Telegram, Matrix, web/PGP, KYC) plug in here. Each one registers its
// routes whatever its configuration; a disabled channel's routes answer 503 with one sentence. Only
// enabled channels start (bots) and appear in `GET /api/channels`.

import type { Config } from './config.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Handler, type Router } from './http.ts';
import { messageOf } from '../migrator.ts';

export interface Channel {
  /** As the front names it: `email`, `x`, `discord`, `github`, `matrix`, `telegram`, `web`, `pgp`, `kyc`. */
  name: string;
  /** Whether its variables are all set. */
  enabled(cfg: Config): boolean;
  /** Register its routes; for a disabled channel they answer 503 without being called. */
  register(router: Router, ctx: Ctx): void;
  /** Start what runs in the background (a bot), for an enabled channel. */
  start?(ctx: Ctx): Promise<void>;
  stop?(): Promise<void>;
  /** What the front needs to know besides the name, merged into `GET /api/channels` (`matrixBot`). */
  publicInfo?(cfg: Config): Record<string, unknown>;
}

export const NOT_AVAILABLE = 'This verification is not available yet.';

/** Proof starts allowed per IP and hour, all channels together (bucket `start`). */
export const STARTS_PER_IP_HOUR = 30;
const HOUR = 60 * 60_000;

/** Count a proof start from `ip` in the shared `start` bucket: false when the IP is over the limit (nothing counted). */
export const startAllowed = (ctx: Ctx, ip: string): boolean => ctx.store.hit('start', ip, STARTS_PER_IP_HOUR, HOUR);

/** A JSON body as an object, `{}` when it is not one. */
export const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const unavailable: Handler = () => {
  throw new HttpError(503, NOT_AVAILABLE);
};

export interface Registry {
  /** The enabled channels' names. */
  enabled: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Register `channels` and the service's own routes (`/api/health`, `/api/channels`) on `router`. */
export function channelRegistry(channels: Channel[], ctx: Ctx, router: Router): Registry {
  const on = channels.filter((c) => c.enabled(ctx.cfg));
  const enabled = on.map((c) => c.name);
  for (const channel of channels) {
    const live = on.includes(channel);
    channel.register(live ? router : { route: (method, path, _handler, options) => router.route(method, path, unavailable, options) }, ctx);
  }
  router.route('GET', '/api/health', () => ({ ok: true, genesis: ctx.chain.genesis, channels: enabled }));
  router.route('GET', '/api/channels', () => Object.assign({ channels: enabled }, ...on.map((c) => c.publicInfo?.(ctx.cfg) ?? {})));
  const started: Channel[] = [];
  return {
    enabled,
    async start() {
      for (const channel of on) {
        await channel.start?.(ctx);
        started.push(channel);
      }
    },
    async stop() {
      for (const channel of started.reverse()) {
        await channel.stop?.().catch((e: unknown) => ctx.log('warn', 'channel-stop-failed', { channel: channel.name, error: messageOf(e) }));
      }
    },
  };
}
