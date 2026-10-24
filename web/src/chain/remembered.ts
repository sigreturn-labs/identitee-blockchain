// The account the visitor chose, remembered in localStorage (an address, nothing secret).
//
// Kept apart from wallet.ts on purpose: this file imports nothing, so the header and the home page
// can ask "was an account remembered?" at start-up without loading the wallet libraries, which are
// most of the weight of the app. wallet.ts adds the validation of what is stored.

/** The localStorage key. */
export const STORAGE_KEY = "identitee.account";

/** What is stored, as it is; `null` when nothing is, or when localStorage is missing or blocked. */
export function rememberedRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Store `address`, or forget the choice with `null`. A blocked or full localStorage means the
 * account is simply not remembered. */
export function writeRemembered(address: string | null): void {
  try {
    if (address === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, address);
  } catch {
    // not remembered
  }
}
