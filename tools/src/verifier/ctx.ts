// What every channel works with.

import type { Chain } from './chain.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import type { PacketMemory } from './packet.ts';
import type { Store } from './store.ts';

export interface Ctx {
  cfg: Config;
  log: Logger;
  chain: Chain;
  /** Challenges and rate limits, in SQLite. Never a private value. */
  store: Store;
  /** Checked private-field packets, in memory only (`resolvePrivate`). */
  packets: PacketMemory;
  /** Milliseconds since the epoch. */
  now(): number;
}
