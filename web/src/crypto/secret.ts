// The identity secret: 32 random bytes from which the salt of every private field is derived. It
// is stored on chain (`set_identity_secret`) encrypted by a passphrase the person chooses, so any
// device with the account and the passphrase finds the same salts again:
//
//   blob  = 0x01 ‖ argon2 salt (16) ‖ nonce (24) ‖ XChaCha20-Poly1305(key, nonce, secret) (32 + 16)
//   key   = Argon2id(NFC(passphrase) as UTF-8, argon2 salt, m = 64 MiB, t = 3, p = 1), 32 bytes
//   salt of a field = blake2_256("identitee:salt:v1" ‖ secret ‖ SCALE(FieldKey))
//
// No associated data: a changed salt or nonce changes the key or the stream and the tag fails.
// The secret, the passphrase, the key and the salts never leave this module's callers: nothing
// here stores, logs or sends them. The passphrase is used once and dropped; the key is zeroed
// after use.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { compactAddLength, stringToU8a, u8aConcat } from "@polkadot/util";
import { FIELD_LABELS, type FieldKind, type FieldRef } from "../chain/identity.ts";
import type { Argon2Cost } from "./argon2.ts";

export const SECRET_LENGTH = 32;
export const BLOB_VERSION = 1;
const ARGON_SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
export const BLOB_LENGTH = 1 + ARGON_SALT_LENGTH + NONCE_LENGTH + SECRET_LENGTH + TAG_LENGTH;

export const ARGON2: Argon2Cost = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

export const SALT_TAG = stringToU8a("identitee:salt:v1");

/** The shortest passphrase accepted, in characters. */
export const MIN_PASSPHRASE = 12;

export class SecretError extends Error {
  readonly reason: "wrong-passphrase" | "unknown-format";
  constructor(reason: "wrong-passphrase" | "unknown-format", message: string) {
    super(message);
    this.name = "SecretError";
    this.reason = reason;
  }
}

export type Random = (length: number) => Uint8Array;

const random: Random = (length) => crypto.getRandomValues(new Uint8Array(length));

/** A new identity secret. */
export function newSecret(): Uint8Array {
  return random(SECRET_LENGTH);
}

/** What is wrong with a new passphrase and its repetition, in a sentence, or `null`. */
export function passphraseProblem(passphrase: string, repeat: string): string | null {
  if (passphrase === "") return "Choose a passphrase.";
  if ([...passphrase.normalize("NFC")].length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (passphrase.normalize("NFC") !== repeat.normalize("NFC")) return "The two passphrases differ.";
  return null;
}

async function keyOf(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const { argon2Key } = await import("./argon2.ts");
  const password = stringToU8a(passphrase.normalize("NFC"));
  try {
    return await argon2Key(password, salt, ARGON2);
  } finally {
    password.fill(0);
  }
}

/** Encrypt `secret` with `passphrase`: the 89 bytes to store on chain. */
export async function sealSecret(secret: Uint8Array, passphrase: string, source: Random = random): Promise<Uint8Array> {
  if (secret.length !== SECRET_LENGTH) throw new Error(`The secret must be ${SECRET_LENGTH} bytes.`);
  const salt = source(ARGON_SALT_LENGTH);
  const nonce = source(NONCE_LENGTH);
  const key = await keyOf(passphrase, salt);
  try {
    return u8aConcat(Uint8Array.of(BLOB_VERSION), salt, nonce, xchacha20poly1305(key, nonce).encrypt(secret));
  } finally {
    key.fill(0);
  }
}

/** The secret inside `blob`. A wrong passphrase (or a blob changed in any way) throws a
 * `SecretError` "wrong-passphrase"; a blob this app cannot read, "unknown-format". */
export async function openSecret(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
  if (blob.length !== BLOB_LENGTH || blob[0] !== BLOB_VERSION) {
    throw new SecretError("unknown-format", "This identity secret was made by another version of identit.ee.");
  }
  const salt = blob.subarray(1, 1 + ARGON_SALT_LENGTH);
  const nonce = blob.subarray(1 + ARGON_SALT_LENGTH, 1 + ARGON_SALT_LENGTH + NONCE_LENGTH);
  const sealed = blob.subarray(1 + ARGON_SALT_LENGTH + NONCE_LENGTH);
  const key = await keyOf(passphrase, salt);
  try {
    return xchacha20poly1305(key, nonce).decrypt(sealed);
  } catch {
    throw new SecretError("wrong-passphrase", "Wrong passphrase.");
  } finally {
    key.fill(0);
  }
}

const KIND_INDEX = Object.keys(FIELD_LABELS) as FieldKind[];

/** SCALE of the runtime's `FieldKey` for a typed or custom field: `Typed(kind)` is `0x00` and the
 * kind's index, `Custom(key)` is `0x01` and the key's UTF-8 bytes with their compact length. */
export function encodeFieldKey(ref: FieldRef): Uint8Array {
  if ("typed" in ref) {
    const index = KIND_INDEX.indexOf(ref.typed);
    if (index < 0) throw new Error(`Unknown field ${ref.typed}.`);
    return Uint8Array.of(0, index);
  }
  return u8aConcat(Uint8Array.of(1), compactAddLength(stringToU8a(ref.custom)));
}

/** The 32-byte salt of a private field. */
export function fieldSalt(secret: Uint8Array, ref: FieldRef): Uint8Array {
  if (secret.length !== SECRET_LENGTH) throw new Error(`The secret must be ${SECRET_LENGTH} bytes.`);
  return blake2b(u8aConcat(SALT_TAG, secret, encodeFieldKey(ref)), { dkLen: 32 });
}
