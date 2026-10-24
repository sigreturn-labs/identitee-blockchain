// Claiming a username: what can stop an account, and how long a wait is, said in words.
//
// The chain reports the block numbers; time comes from the block time the runtime declares (Aura's
// slot duration), so nothing here assumes six seconds. The decisions are pure and tested; only
// `readNamingTimes` reads the chain.

import { publicKeyHex } from "./address.ts";
import type { Profile } from "./identity.ts";
import { type Reader, reader } from "./reader.ts";

export interface Clock {
  /** The best block now. */
  block: number;
  blockSeconds: number;
}

export interface NamingTimes {
  clock: Clock;
  /** After releasing a name, blocks during which the account cannot claim one (the quota window). */
  cooldownBlocks: number;
  /** After a name leaves its owner, blocks during which nobody can claim it. */
  quarantineBlocks: number;
  /** The block at which the account last released a name of its own accord, if it did. */
  lastRelease: number | null;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (count: number, name: string): string => `${count} ${name}${count === 1 ? "" : "s"}`;

/** "about 3 hours": the largest unit that fits, rounded, never zero. */
export function describeWait(blocks: number, blockSeconds: number): string {
  const seconds = blocks * blockSeconds;
  if (seconds < MINUTE / 2) return "less than a minute";
  if (seconds < HOUR) return `about ${unit(Math.max(1, Math.round(seconds / MINUTE)), "minute")}`;
  if (seconds < DAY) return `about ${unit(Math.max(1, Math.round(seconds / HOUR)), "hour")}`;
  return `about ${unit(Math.max(1, Math.round(seconds / DAY)), "day")}`;
}

/** A length of time the runtime fixed: exact when it is a whole number of days or hours ("30
 * days"), else as `describeWait`. */
export function describeSpan(blocks: number, blockSeconds: number): string {
  const seconds = blocks * blockSeconds;
  if (seconds >= DAY && seconds % DAY === 0) return unit(seconds / DAY, "day");
  if (seconds >= HOUR && seconds % HOUR === 0) return unit(seconds / HOUR, "hour");
  return describeWait(blocks, blockSeconds);
}

/** What the page says about a name that was released recently, claimable again from block `until`. */
export function quarantineMessage(until: number, clock: Clock): string {
  return `That name was released recently. It can be claimed again in ${describeWait(until - clock.block, clock.blockSeconds)}.`;
}

export interface Blocker {
  kind: "identity" | "verification" | "fraud" | "cooldown";
  message: string;
}

/**
 * Why this account cannot claim a name now, whatever name it chooses, or `null`. It mirrors the
 * checks of `claim_username` that do not depend on the name, in the order the chain makes them
 * (the chain stays the judge: anything missed here comes back as its own sentence).
 */
export function claimBlocker(profile: Profile | null, times: NamingTimes): Blocker | null {
  if (profile === null) return { kind: "identity", message: "Create your identity first." };
  const { clock, cooldownBlocks, lastRelease } = times;
  if (lastRelease !== null && clock.block < lastRelease + cooldownBlocks) {
    const wait = describeWait(lastRelease + cooldownBlocks - clock.block, clock.blockSeconds);
    return { kind: "cooldown", message: `You released a name recently. You can claim one again in ${wait}.` };
  }
  if (profile.trust === "Fraudulent") {
    return { kind: "fraud", message: "A fraud finding blocks this account from claiming a name." };
  }
  const verified = profile.fields.some((f) => f.verified) || profile.links.some((l) => l.verified);
  if (!verified) {
    return { kind: "verification", message: "Get one field verified first. You can ask for a verification above." };
  }
  return null;
}

/** The block, the block time, the quota window and quarantine, and the account's last release. */
export async function readNamingTimes(address: string | Uint8Array, at?: Reader): Promise<NamingTimes> {
  const api = await reader(at);
  const identitee = api.consts.identitee as unknown as Record<string, { toNumber(): number }>;
  const slot = (api.consts as unknown as { aura?: { slotDuration?: { toNumber(): number } } }).aura?.slotDuration;
  const query = api.query as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<{ toJSON(): unknown }>>>;
  const [number, released] = await Promise.all([query.system!.number!(), query.identitee!.lastRelease!(publicKeyHex(address))]);
  return {
    clock: { block: number.toJSON() as number, blockSeconds: slot ? slot.toNumber() / 1000 : 6 },
    cooldownBlocks: identitee.quotaWindow!.toNumber(),
    quarantineBlocks: identitee.nameQuarantine!.toNumber(),
    lastRelease: released.toJSON() as number | null,
  };
}

/** The best block now: a wait counted from the block the page was read at grows stale while the
 * page stays open. */
export async function readBlock(): Promise<number> {
  const api = await reader();
  const query = api.query as unknown as { system: { number(): Promise<{ toJSON(): unknown }> } };
  return (await query.system.number()).toJSON() as number;
}
