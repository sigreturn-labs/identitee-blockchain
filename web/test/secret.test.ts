import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { TypeRegistry } from "@polkadot/types";
import { stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import { privateCommitment } from "../src/chain/formulas.ts";
import { FIELD_LABELS, type FieldRef } from "../src/chain/identity.ts";
import {
  ARGON2,
  BLOB_LENGTH,
  encodeFieldKey,
  fieldSalt,
  newSecret,
  openSecret,
  passphraseProblem,
  sealSecret,
  SecretError,
} from "../src/crypto/secret.ts";

// The identity secret: 32 random bytes, stored on chain encrypted by a passphrase as
//   0x01 ‖ argon2 salt (16) ‖ nonce (24) ‖ XChaCha20-Poly1305 of the secret (32 + 16) = 89 bytes,
// the key being Argon2id(passphrase, salt, m = 64 MiB, t = 3, p = 1). Each private field has its
// own salt, blake2_256("identitee:salt:v1" ‖ secret ‖ SCALE(FieldKey)).

const PASS = "correct horse battery staple";
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
/** A fixed "random" source, so the layout can be checked byte by byte. */
const counter = (start: number) => (n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

describe("the encrypted secret", () => {
  it("is 89 bytes: version 1, the Argon2 salt, the nonce, then the ciphertext and its tag", async () => {
    const blob = await sealSecret(SECRET, PASS, counter(1));
    expect(blob.length).toBe(BLOB_LENGTH);
    expect(BLOB_LENGTH).toBe(89);
    expect(blob[0]).toBe(1);
    expect(blob.subarray(1, 17)).toEqual(counter(1)(16));
    expect(blob.subarray(17, 41)).toEqual(counter(1)(24)); // each call to the source starts again here
    // nothing of the secret shows in clear
    expect(u8aToHex(blob)).not.toContain(u8aToHex(SECRET).slice(2, 18));
  }, 30_000);

  it("uses Argon2id with m = 64 MiB, t = 3, p = 1", () => {
    expect(ARGON2).toEqual({ memoryKiB: 65536, iterations: 3, parallelism: 1 });
  });

  it("opens with an independent Argon2id and XChaCha20-Poly1305", async () => {
    const blob = await sealSecret(SECRET, PASS);
    const key = await argon2idAsync(stringToU8a(PASS), blob.subarray(1, 17), { m: 65536, t: 3, p: 1, dkLen: 32 });
    expect(xchacha20poly1305(key, blob.subarray(17, 41)).decrypt(blob.subarray(41))).toEqual(SECRET);
  }, 120_000);

  it("goes there and back with the right passphrase", async () => {
    const secret = newSecret();
    expect(secret.length).toBe(32);
    expect(await openSecret(await sealSecret(secret, PASS), PASS)).toEqual(secret);
  }, 30_000);

  it("refuses a wrong passphrase, cleanly", async () => {
    const blob = await sealSecret(SECRET, PASS);
    const wrong = await openSecret(blob, "correct horse battery stapler").catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(SecretError);
    expect((wrong as SecretError).reason).toBe("wrong-passphrase");
    expect((wrong as SecretError).message).toBe("Wrong passphrase.");
  }, 30_000);

  it("refuses a blob changed by one bit as it refuses a wrong passphrase", async () => {
    const blob = await sealSecret(SECRET, PASS);
    for (const at of [5, 30, 60, 88]) {
      const changed = blob.slice();
      changed[at]! ^= 1;
      await expect(openSecret(changed, PASS)).rejects.toMatchObject({ reason: "wrong-passphrase" });
    }
  }, 60_000);

  it("refuses a blob of another version or size without asking Argon2", async () => {
    const blob = await sealSecret(SECRET, PASS);
    const other = blob.slice();
    other[0] = 2;
    const start = Date.now();
    await expect(openSecret(other, PASS)).rejects.toMatchObject({ reason: "unknown-format" });
    await expect(openSecret(blob.subarray(0, 88), PASS)).rejects.toMatchObject({ reason: "unknown-format" });
    await expect(openSecret(new Uint8Array(), PASS)).rejects.toMatchObject({ reason: "unknown-format" });
    expect(Date.now() - start).toBeLessThan(200);
  }, 30_000);

  it("takes the passphrase in Unicode NFC, so the same words typed on another device open it", async () => {
    const composed = "Zoë café naïve 2026";
    const blob = await sealSecret(SECRET, composed);
    expect(await openSecret(blob, composed.normalize("NFD"))).toEqual(SECRET);
  }, 30_000);

  it("never gives the same blob twice for the same secret and passphrase", async () => {
    const [a, b] = await Promise.all([sealSecret(SECRET, PASS), sealSecret(SECRET, PASS)]);
    expect(u8aToHex(a)).not.toBe(u8aToHex(b));
  }, 30_000);

  it("refuses a secret that is not 32 bytes", async () => {
    await expect(sealSecret(new Uint8Array(31), PASS)).rejects.toThrow();
  });
});

describe("passphraseProblem", () => {
  it("asks for 12 characters at least, and the same twice", () => {
    expect(passphraseProblem("", "")).toBe("Choose a passphrase.");
    expect(passphraseProblem("short one", "short one")).toBe("Use at least 12 characters.");
    expect(passphraseProblem(PASS, `${PASS} `)).toBe("The two passphrases differ.");
    expect(passphraseProblem(PASS, PASS)).toBeNull();
    // counted in characters, not bytes: twelve accented letters are enough
    expect(passphraseProblem("éééééééééééé", "éééééééééééé")).toBeNull();
  });
});

// --- Field salts --------------------------------------------------------------------------------

/** The runtime's FieldKey, described for polkadot.js's own SCALE encoder. */
const registry = new TypeRegistry();
const FieldKind = { _enum: Object.keys(FIELD_LABELS) };
registry.register({ FieldKind, FieldKey: { _enum: { Typed: "FieldKind", Custom: "Bytes", Link: "u32" } } });
const scale = (ref: FieldRef) =>
  registry.createType("FieldKey", "typed" in ref ? { Typed: ref.typed } : { Custom: u8aToHex(stringToU8a(ref.custom)) }).toU8a();

describe("field salts", () => {
  const refs: FieldRef[] = [
    ...(Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]).map((typed) => ({ typed })),
    { custom: "mastodon" },
    { custom: "fuseau horaire é" },
    { custom: "x".repeat(32) },
  ];

  it("encode the field key as SCALE, like the runtime", () => {
    for (const ref of refs) expect(u8aToHex(encodeFieldKey(ref))).toBe(u8aToHex(scale(ref)));
    expect(u8aToHex(encodeFieldKey({ typed: "Email" }))).toBe("0x0003");
    expect(u8aToHex(encodeFieldKey({ custom: "ab" }))).toBe("0x01086162");
  });

  it("are blake2_256(\"identitee:salt:v1\" ‖ secret ‖ SCALE(FieldKey))", () => {
    for (const ref of refs) {
      const expected = blake2b(u8aConcat(stringToU8a("identitee:salt:v1"), SECRET, scale(ref)), { dkLen: 32 });
      expect(fieldSalt(SECRET, ref)).toEqual(expected);
    }
  });

  it("are stable: the same secret and field give the same salt, on any device", () => {
    expect(u8aToHex(fieldSalt(SECRET, { typed: "Email" }))).toBe(u8aToHex(fieldSalt(SECRET.slice(), { typed: "Email" })));
    // frozen: a change of formula would break every private field already on chain
    expect(u8aToHex(fieldSalt(new Uint8Array(32).fill(0x11), { typed: "Email" }))).toBe(FROZEN_EMAIL_SALT);
    expect(u8aToHex(fieldSalt(new Uint8Array(32).fill(0x11), { custom: "mastodon" }))).toBe(FROZEN_CUSTOM_SALT);
  });

  it("differ from one field to another and from one secret to another", () => {
    const salts = refs.map((ref) => u8aToHex(fieldSalt(SECRET, ref)));
    expect(new Set(salts).size).toBe(refs.length);
    expect(u8aToHex(fieldSalt(newSecret(), { typed: "Email" }))).not.toBe(salts[3]);
  });

  it("give the private commitment of the runtime's formula", () => {
    // the runtime's frozen vector (salt of 32 0x11, "@alice") through the same function the
    // editor uses with a derived salt
    expect(privateCommitment(new Uint8Array(32).fill(0x11), "@alice")).toBe(
      "0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0",
    );
    const salt = fieldSalt(SECRET, { typed: "Telegram" });
    expect(privateCommitment(salt, "@alice")).toBe(
      u8aToHex(blake2b(u8aConcat(stringToU8a("identitee:field:private:v1"), salt, stringToU8a("@alice")), { dkLen: 32 })),
    );
  });

  it("refuse a secret that is not 32 bytes", () => {
    expect(() => fieldSalt(new Uint8Array(16), { typed: "Email" })).toThrow();
  });
});

const FROZEN_EMAIL_SALT = "0xf96dc44a2d70813f6c0e2f65c30dfd8caba152b95922293eb774b0629d8617cb";
const FROZEN_CUSTOM_SALT = "0x2dafd57046163a9f653cd443cbd27425c1726aa8181ec9946b5e12baa562fbe7";
