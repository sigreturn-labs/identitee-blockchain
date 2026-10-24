// Identity secrets unlocked during this visit, in memory only: a reload, or closing the tab, forgets
// them, and nothing here touches storage. Each is kept with the encrypted blob it came from, and is
// only given back while the chain still holds that blob (another device may have replaced it).

import { publicKeyHex } from "../chain/address.ts";

const unlocked = new Map<string, { blob: string; secret: Uint8Array }>();

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function keepSecret(address: string, blob: Uint8Array, secret: Uint8Array): void {
  forgetSecret(address);
  unlocked.set(publicKeyHex(address), { blob: hexOf(blob), secret: secret.slice() });
}

/** The secret unlocked for `address` from `blob`, or `null`. */
export function unlockedSecret(address: string, blob: Uint8Array): Uint8Array | null {
  const kept = unlocked.get(publicKeyHex(address));
  return kept && kept.blob === hexOf(blob) ? kept.secret : null;
}

/** Forget the secret of `address`. (Its bytes are not overwritten: a save in flight may still hold
 * them, and zeros would give it wrong salts without a word.) */
export function forgetSecret(address: string): void {
  unlocked.delete(publicKeyHex(address));
}

/** Forget every unlocked secret: on Disconnect and when another account is chosen. */
export function forgetAll(): void {
  unlocked.clear();
}
