import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidName, NAME_MAX, NAME_MIN } from "../src/chain/name.ts";

describe("isValidName, the runtime's validate_name", () => {
  it("has the runtime's bounds", () => {
    const limits = readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "src", "limits.rs"), "utf8");
    expect(limits).toContain(`pub const NAME_MIN: u32 = ${NAME_MIN};`);
    expect(limits).toContain(`pub const NAME_MAX: u32 = ${NAME_MAX};`);
  });

  it.each(["abc", "dave", "a-b_c", "user_01", "x".repeat(32), "000"])("accepts %j", (name) => {
    expect(isValidName(name)).toBe(true);
  });

  it.each([
    "",
    "ab",
    "x".repeat(33),
    "robots.txt",
    "favicon.ico",
    "Dave",
    "a b c",
    "a/b/c",
    "..",
    "café",
    "日本語",
    "😀😀😀",
    "é".repeat(17), // 17 characters, 34 bytes
    "%2e%2e",
  ])("refuses %j", (name) => {
    expect(isValidName(name)).toBe(false);
  });
});
