import { describe, expect, it } from "vitest";
import { shorten } from "../src/chain/short.ts";

const ADDRESS = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";

describe("shorten", () => {
  it("keeps eight characters on each side of an address", () => {
    expect(shorten(ADDRESS)).toBe("idrfveZj…s9YX3ogk");
    expect(shorten(ADDRESS, 4)).toBe("idrf…3ogk");
  });

  it("leaves a text that is not longer than its two edges and the ellipsis", () => {
    expect(shorten("idrf…3ogk", 4)).toBe("idrf…3ogk");
    expect(shorten("short")).toBe("short");
    expect(shorten("x".repeat(17))).toBe("x".repeat(17));
    expect(shorten("x".repeat(18))).toBe(`${"x".repeat(8)}…${"x".repeat(8)}`);
  });
});
