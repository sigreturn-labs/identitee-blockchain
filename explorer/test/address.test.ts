import { describe, expect, it } from "vitest";
import { isAddress, publicKeyOf, shortAddress } from "../src/address.ts";

const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const ALICE_KEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
// the same key under the generic prefix 42 (one prefix byte)
const ALICE_GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Alice's key under a two-byte `prefix`, checksum zeroed (publicKeyOf does not read it). */
function withPrefix(prefix: number): string {
  const bytes = [((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6), ...ALICE_KEY.slice(2).match(/../g)!.map((h) => parseInt(h, 16)), 0, 0];
  let n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

describe("publicKeyOf", () => {
  it("reads the key of an identitee address", () => {
    expect(publicKeyOf(ALICE)).toBe(ALICE_KEY);
    expect(isAddress(ALICE)).toBe(true);
  });

  it("refuses another prefix", () => {
    expect(publicKeyOf(withPrefix(2426))).toBe(ALICE_KEY);
    expect(publicKeyOf(withPrefix(2427))).toBeNull();
    expect(publicKeyOf(withPrefix(1000))).toBeNull();
    expect(publicKeyOf(ALICE_GENERIC)).toBeNull();
  });

  it("refuses a wrong length", () => {
    expect(publicKeyOf(ALICE.slice(0, -1))).toBeNull();
    expect(publicKeyOf(`${ALICE}1`)).toBeNull();
    expect(publicKeyOf(ALICE.slice(0, 20))).toBeNull();
  });

  it("refuses a character outside base58", () => {
    for (const c of ["0", "O", "I", "l", "-"]) expect(publicKeyOf(`${ALICE.slice(0, 10)}${c}${ALICE.slice(11)}`)).toBeNull();
  });

  it("refuses plain words and hex", () => {
    expect(isAddress("bob")).toBe(false);
    expect(isAddress(ALICE_KEY)).toBe(false);
  });
});

describe("shortAddress", () => {
  it("keeps the edges", () => {
    expect(shortAddress(ALICE)).toBe("idrfve…YX3ogk");
  });
});
