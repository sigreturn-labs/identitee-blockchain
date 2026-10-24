// Whether an account is an authority agent, and what it may do. The chain's `agents` table gives
// the authority an account serves and its capability bits (pallets/identitee/src/types.rs,
// `Capabilities`: 1 attest fields, 2 person facts, 4 manage names, 8 migrate). An agent acts only
// while its authority is active (`ensure_agent` in authorities.rs).
//
// The authority page is for the first three: an agent that only migrates (the migration service)
// has nothing to do there, so it does not count here. The page shows an action only when the
// capability allows it; the chain stays the judge of every call.

import { publicKeyHex } from "./address.ts";
import { type Reader, reader } from "./reader.ts";
import { type AuthorityInfo, decodeAuthority } from "./requests.ts";

/** Capability bits, as the runtime numbers them. */
export const CAPABILITY = { attest: 1, facts: 2, names: 4, migrate: 8 } as const;

export interface Agent {
  authority: AuthorityInfo;
  /** Attest fields: verify, reject field requests, revoke a verification. */
  attest: boolean;
  /** Person facts: identity document, fraud, and fact requests. */
  facts: boolean;
  /** Manage names: reserve, give and take away usernames. */
  names: boolean;
}

type Json = any;

/** A row of `agents`, `[authority, capabilities]`, or `null`. */
export function decodeAgentRow(raw: Json): { authority: number; caps: number } | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length !== 2 || !Number.isSafeInteger(raw[0]) || !Number.isSafeInteger(raw[1])) {
    throw new Error("Unexpected answer from the chain: agent.");
  }
  return { authority: raw[0], caps: raw[1] };
}

/** The agent an account is for the authority page: its authority active, and at least one of the
 * capabilities the page uses. Otherwise `null`. */
export function agentFrom(row: { authority: number; caps: number } | null, authority: AuthorityInfo | null): Agent | null {
  if (row === null || authority === null || !authority.active || authority.id !== row.authority) return null;
  const has = (bit: number) => (row.caps & bit) !== 0;
  const agent = { authority, attest: has(CAPABILITY.attest), facts: has(CAPABILITY.facts), names: has(CAPABILITY.names) };
  return agent.attest || agent.facts || agent.names ? agent : null;
}

/** What `address` may do on the authority page, `null` if nothing. */
export async function readAgent(address: string, at?: Reader): Promise<Agent | null> {
  const api = await reader(at);
  const query = (api.query as Json).identitee;
  const row = decodeAgentRow((await query.agents(publicKeyHex(address))).toJSON());
  if (row === null) return null;
  return agentFrom(row, decodeAuthority(row.authority, (await query.authorities(row.authority)).toJSON()));
}
