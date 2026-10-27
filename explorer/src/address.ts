// SS58 addresses without @polkadot: enough to recognise an identitee address in decoded arguments
// and to read its public key for the avatar. The API has already checked every address it serves.

export const SS58_PREFIX = 2426;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(text: string): Uint8Array | null {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const hex = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The public key (0x + 64 hex) of an SS58 2426 address, or null for anything else. The checksum
 * is not verified. */
export function publicKeyOf(address: string): string | null {
  if (address.length < 47 || address.length > 50) return null;
  const bytes = base58(address);
  // two prefix bytes, the 32-byte key, two checksum bytes
  if (bytes === null || bytes.length !== 36) return null;
  const [b0 = 0, b1 = 0] = bytes;
  if ((b0 & 0xc0) !== 0x40) return null;
  const prefix = ((b0 & 0x3f) << 2) | (b1 >> 6) | ((b1 & 0x3f) << 8);
  return prefix === SS58_PREFIX ? hex(bytes.subarray(2, 34)) : null;
}

export const isAddress = (value: string): boolean => publicKeyOf(value) !== null;

/** `idrfve…YX3ogk`: the edges of an address, the full one belongs in a `title`. */
export const shortAddress = (address: string, edge = 6): string =>
  address.length <= 2 * edge + 4 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
