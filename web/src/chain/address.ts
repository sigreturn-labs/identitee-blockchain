// Account addresses. Input may be an SS58 address of any prefix, a 0x public key, or raw bytes;
// everything the front shows is encoded with the identitee prefix (2426).

import { hexToU8a, isHex, u8aEq, u8aToHex } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";

/** SS58 prefix of the identitee chain. */
export const SS58_PREFIX = 2426;

/** Thrown for anything that is not a 32-byte account. */
export class AddressError extends Error {
  constructor(input: unknown) {
    super(`Not a valid account address: ${typeof input === "string" ? input : "bytes"}`);
    this.name = "AddressError";
  }
}

/** The 32-byte public key of an address (any SS58 prefix), a hex key, or bytes. */
export function publicKeyOf(input: string | Uint8Array): Uint8Array {
  let key: Uint8Array;
  try {
    if (typeof input === "string") {
      const text = input.trim();
      // decodeAddress returns a hex input unchecked, whatever its length
      key = isHex(text) ? hexToU8a(text) : decodeAddress(text);
    } else {
      key = input;
    }
  } catch {
    throw new AddressError(input);
  }
  if (key.length !== 32) throw new AddressError(input);
  return Uint8Array.from(key);
}

/** Whether `input` is an account address `publicKeyOf` accepts. */
export function isAddress(input: string | Uint8Array): boolean {
  try {
    publicKeyOf(input);
    return true;
  } catch {
    return false;
  }
}

/** The address with the identitee prefix (2426), from any accepted input. */
export function toIdentitee(input: string | Uint8Array): string {
  return encodeAddress(publicKeyOf(input), SS58_PREFIX);
}

/** The public key as 0x-prefixed lowercase hex. */
export function publicKeyHex(input: string | Uint8Array): `0x${string}` {
  return u8aToHex(publicKeyOf(input));
}

/** Whether two inputs are the same account, whatever their prefix. */
export function sameAccount(a: string | Uint8Array, b: string | Uint8Array): boolean {
  return u8aEq(publicKeyOf(a), publicKeyOf(b));
}
