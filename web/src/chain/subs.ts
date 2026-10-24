// The sub-account form, checked before anything is signed. Pure; the limits are those of the
// runtime (`LIMITS`, compared with limits.rs by a test), counted in UTF-8 bytes.

import { isAddress, publicKeyHex } from "./address.ts";
import { byteLength, LIMITS } from "./edit.ts";

/** What is wrong with a label, or `null`. An empty label is allowed: the profile then shows the address. */
export function subLabelProblem(label: string): string | null {
  const used = byteLength(label.trim());
  return used > LIMITS.subLabel ? `A label has at most ${LIMITS.subLabel} bytes, this one has ${used}.` : null;
}

/**
 * What is wrong with the address typed to propose, or `null` (also for nothing typed yet). `self`
 * is the proposing account and `listed` the accounts it already proposed or accepted, in any
 * address format: accounts are compared by key.
 */
export function subAddressProblem(text: string, self: string, listed: readonly string[]): string | null {
  const typed = text.trim();
  if (typed === "") return null;
  if (!isAddress(typed)) return "That is not a valid account address.";
  const key = publicKeyHex(typed);
  if (key === publicKeyHex(self)) return "An account cannot be its own sub-account.";
  if (listed.some((address) => publicKeyHex(address) === key)) {
    return "That account is already your sub-account, or has a proposal from you.";
  }
  return null;
}
