import { describe, expect, it } from "vitest";
import {
  AddressError,
  isAddress,
  publicKeyHex,
  publicKeyOf,
  sameAccount,
  toIdentitee,
} from "../src/chain/address.ts";

// Alice's dev key in the encodings the front meets (prefix 2426 is the chain's own).
const KEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const KUSAMA = "HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F";
const IDENTITEE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";

describe("toIdentitee", () => {
  it.each([
    ["a generic address", GENERIC],
    ["a Polkadot address", POLKADOT],
    ["a Kusama address", KUSAMA],
    ["an identitee address", IDENTITEE],
    ["a hex key", KEY],
    ["a hex key in capitals", `0x${KEY.slice(2).toUpperCase()}`],
    ["a padded address", `  ${GENERIC}\n`],
  ])("re-encodes %s with prefix 2426", (_, input) => {
    expect(toIdentitee(input)).toBe(IDENTITEE);
  });

  it("accepts raw bytes", () => {
    expect(toIdentitee(publicKeyOf(KEY))).toBe(IDENTITEE);
  });
});

describe("publicKeyOf", () => {
  it("gives the same 32 bytes for every encoding", () => {
    for (const input of [GENERIC, POLKADOT, KUSAMA, IDENTITEE, KEY]) expect(publicKeyHex(input)).toBe(KEY);
  });

  it("returns a copy: changing it does not change the input bytes", () => {
    const bytes = publicKeyOf(KEY);
    publicKeyOf(bytes)[0] = 0;
    expect(bytes[0]).toBe(0xd4);
  });

  it.each([
    ["an empty string", ""],
    ["text", "alice"],
    ["a broken checksum", `${GENERIC.slice(0, -1)}A`],
    ["a hex key that is too short", "0xd43593c715"],
    ["a hex key that is too long", `${KEY}00`],
  ])("refuses %s", (_, input) => {
    expect(() => publicKeyOf(input)).toThrow(AddressError);
    expect(isAddress(input)).toBe(false);
  });

  it("refuses bytes that are not 32 long", () => {
    expect(() => publicKeyOf(new Uint8Array(20))).toThrow(AddressError);
  });
});

describe("sameAccount", () => {
  it("compares keys, not text", () => {
    expect(sameAccount(GENERIC, IDENTITEE)).toBe(true);
    expect(sameAccount(KEY, KUSAMA)).toBe(true);
    expect(sameAccount(GENERIC, "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty")).toBe(false);
  });
});
