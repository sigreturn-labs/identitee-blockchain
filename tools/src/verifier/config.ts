// Configuration of the verifier, from the environment only (for example a systemd
// EnvironmentFile). Required: IDENTITEE_VERIFIER_SURI. A channel whose variables are missing is disabled,
// it does not stop the service. Every secret value lands in `secrets`, which the logger removes
// from every line.

/** The channel variables the service reads; an empty value counts as missing. */
export const CHANNEL_ENV = [
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'RESEND_API_KEY',
  'MATRIX_HOMESERVER',
  'MATRIX_USER',
  'MATRIX_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'DIDIT_API_KEY',
  'DIDIT_WORKFLOW_ID',
  'DIDIT_WEBHOOK_SECRET',
] as const;

export type ChannelEnvName = (typeof CHANNEL_ENV)[number];

/** The channel variables that are secrets: never printed. */
export const SECRET_ENV: readonly ChannelEnvName[] = [
  'X_CLIENT_SECRET',
  'DISCORD_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'RESEND_API_KEY',
  'MATRIX_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'DIDIT_API_KEY',
  'DIDIT_WEBHOOK_SECRET',
];

export interface Config {
  /** identitee node RPC endpoint. */
  ws: string;
  /** Secret URI of the verifier agent. */
  suri: string;
  /** Port of the HTTP server, on 127.0.0.1. */
  port: number;
  /** Directory of the SQLite file `verifier.db`. */
  stateDir: string;
  /** VERIFIER_DEV=1: local origins allowed by CORS, a default state directory. */
  dev: boolean;
  /** The channel variables that are set. */
  env: Readonly<Partial<Record<ChannelEnvName, string>>>;
  /** Every secret value, for the logger. */
  secrets: string[];
  /** The site's origin: OAuth popups post to it only, redirects go back to it. */
  frontOrigin: string;
  /** The service's public base URL, for the OAuth `redirect_uri`, without a trailing slash. */
  publicUrl: string;
}

export const DEFAULT_FRONT_ORIGIN = 'https://identit.ee';
export const DEFAULT_PUBLIC_URL = 'https://verify.identit.ee';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const HTTPS = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

export const USAGE = `usage: IDENTITEE_VERIFIER_SURI='<secret uri>' STATE_DIRECTORY=<dir> npx tsx src/verifier/main.ts

  IDENTITEE_VERIFIER_SURI  secret URI of the verifier agent (required)
  IDENTITEE_WS             identitee node RPC endpoint (default ws://127.0.0.1:9944)
  VERIFIER_PORT            HTTP port on 127.0.0.1 (default 8787)
  STATE_DIRECTORY          directory of verifier.db (required, set by systemd's StateDirectory=;
                           ./.verifier-state when VERIFIER_DEV=1)
  VERIFIER_DEV             1: allow http://localhost:* and http://127.0.0.1:* origins
  VERIFIER_FRONT_ORIGIN    the site's origin for OAuth returns (default https://identit.ee;
                           http://localhost:* or http://127.0.0.1:* only when VERIFIER_DEV=1)
  VERIFIER_PUBLIC_URL      this service's public base URL (default https://verify.identit.ee)
  ${CHANNEL_ENV.join(', ')}
                           channel settings; a channel whose variables are missing is disabled`;

/** Whether every one of `names` is set: a channel's `enabled`. */
export const hasEnv = (cfg: Config, ...names: ChannelEnvName[]): boolean => names.every((n) => cfg.env[n] !== undefined);

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const suri = env.IDENTITEE_VERIFIER_SURI;
  if (!suri) throw new Error(`IDENTITEE_VERIFIER_SURI is not set\n${USAGE}`);
  const dev = env.VERIFIER_DEV === '1';
  const stateDir = env.STATE_DIRECTORY || (dev ? './.verifier-state' : '');
  if (!stateDir) throw new Error(`STATE_DIRECTORY is not set\n${USAGE}`);
  const portText = env.VERIFIER_PORT || '8787';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port > 65535) throw new Error(`VERIFIER_PORT is not a port: ${portText}`);
  const channelEnv: Partial<Record<ChannelEnvName, string>> = {};
  for (const name of CHANNEL_ENV) {
    const value = env[name];
    if (value) channelEnv[name] = value;
  }
  const frontOrigin = env.VERIFIER_FRONT_ORIGIN || DEFAULT_FRONT_ORIGIN;
  if (!(HTTPS.test(frontOrigin) || (dev && LOCAL.test(frontOrigin)))) throw new Error(`VERIFIER_FRONT_ORIGIN is not an allowed origin: ${frontOrigin}`);
  const publicUrl = (env.VERIFIER_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '');
  if (!(HTTPS.test(publicUrl) || (dev && LOCAL.test(publicUrl)))) throw new Error(`VERIFIER_PUBLIC_URL is not an https origin: ${publicUrl}`);
  const secrets = [suri, ...SECRET_ENV.map((n) => channelEnv[n]).filter((v): v is string => v !== undefined)];
  return { ws: env.IDENTITEE_WS || 'ws://127.0.0.1:9944', suri, port, stateDir, dev, env: Object.freeze(channelEnv), secrets, frontOrigin, publicUrl };
}
