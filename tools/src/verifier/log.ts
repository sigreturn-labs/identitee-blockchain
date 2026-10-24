// The verifier's log: the migrator's logger (one JSON object per line, secrets removed) with
// every secret of the configuration. Never pass a private value, a packet, a code or a token as a
// field: the redaction only knows the configuration's secrets.

import { makeLogger, type Logger } from '../migrator.ts';
import type { Config } from './config.ts';

export { makeLogger, type Logger };

export const verifierLogger = (cfg: Config, write?: (line: string) => void): Logger => makeLogger(cfg.secrets, write);
