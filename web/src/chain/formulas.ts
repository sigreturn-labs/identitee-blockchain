// Field commitments, exactly as the runtime computes them (pallets/identitee/src/types.rs):
//
//   public   blake2_256("identitee:field:public:v1"  ‖ value)
//   private  blake2_256("identitee:field:private:v1" ‖ salt(32) ‖ value)
//   link     blake2_256("identitee:field:link:v1"    ‖ SCALE(title, url))
//
// Pure and synchronous. test/formulas.test.ts checks them against vectors printed by the Rust
// side (pallets/identitee/src/tests/vectors.rs). A private value and its salt never leave this
// module's callers: nothing here stores, logs or sends them.

import { blake2b } from "@noble/hashes/blake2.js";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";

export type Hex = `0x${string}`;

/** Text is hashed as its UTF-8 bytes; bytes (a PGP fingerprint) as they are. */
export type FieldBytes = string | Uint8Array;

export const PUBLIC_TAG = stringToU8a("identitee:field:public:v1");
export const PRIVATE_TAG = stringToU8a("identitee:field:private:v1");
export const LINK_TAG = stringToU8a("identitee:field:link:v1");

/** Length of the salt of a private field. */
export const SALT_LENGTH = 32;

const bytesOf = (value: FieldBytes): Uint8Array => (typeof value === "string" ? stringToU8a(value) : value);

const blake2_256 = (data: Uint8Array): Hex => u8aToHex(blake2b(data, { dkLen: 32 }));

/** The commitment of a public value. */
export function publicCommitment(value: FieldBytes): Hex {
  return blake2_256(u8aConcat(PUBLIC_TAG, bytesOf(value)));
}

/** The commitment of a private value under a 32-byte salt: the only thing the chain stores. */
export function privateCommitment(salt: Uint8Array, value: FieldBytes): Hex {
  if (salt.length !== SALT_LENGTH) throw new Error(`The salt must be ${SALT_LENGTH} bytes, got ${salt.length}.`);
  return blake2_256(u8aConcat(PRIVATE_TAG, salt, bytesOf(value)));
}

/** SCALE encoding of the pair `(title, url)`: each a compact length followed by its bytes. */
export function encodeLink(title: string, url: string): Uint8Array {
  return u8aConcat(compactAddLength(stringToU8a(title)), compactAddLength(stringToU8a(url)));
}

/** The commitment of a link: changing its title or its url changes it. */
export function linkCommitment(title: string, url: string): Hex {
  return blake2_256(u8aConcat(LINK_TAG, encodeLink(title, url)));
}
