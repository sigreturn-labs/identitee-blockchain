// Everything the requests page shows, read in one go: the identity, the requests pending, the
// authority they go to, the sub-accounts in both directions, the migration, and the numbers the
// username form needs. All at one block hash, so the page never shows half of one moment and half
// of another.

import { type Member, type Profile, parentOf, pendingSubsOf, proposalsTo, readProfile, subsOf } from "./identity.ts";
import { type Migration, readMigration } from "./migration.ts";
import { type NamingTimes, readNamingTimes } from "./naming.ts";
import { snapshot } from "./reader.ts";
import { type AuthorityInfo, type PendingRequest, pendingRequestsOf, readAuthority, REQUEST_AUTHORITY } from "./requests.ts";

export interface Overview {
  /** `null` for an account with no identity. */
  profile: Profile | null;
  /** The authority requests go to, `null` if there is none. */
  authority: AuthorityInfo | null;
  pending: PendingRequest[];
  /** The account this one is a sub-account of. An account needs no identity for that. */
  parent: Member | null;
  /** The sub-accounts that accepted. */
  subs: Member[];
  /** The proposals this account made that nobody accepted yet. */
  proposed: Member[];
  /** The proposals made to this account. */
  received: Member[];
  migration: Migration;
  times: NamingTimes;
}

export async function readOverview(address: string): Promise<Overview> {
  const at = await snapshot();
  const [profile, authority, pending, parent, subs, proposed, received, migration, times] = await Promise.all([
    readProfile(address, at),
    readAuthority(REQUEST_AUTHORITY, at),
    pendingRequestsOf(address, at),
    parentOf(address, at),
    subsOf(address, at),
    pendingSubsOf(address, at),
    proposalsTo(address, at),
    readMigration(address, undefined, at),
    readNamingTimes(address, at),
  ]);
  return { profile, authority, pending, parent, subs, proposed, received, migration, times };
}
