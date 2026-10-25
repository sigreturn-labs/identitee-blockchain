import { describe, expect, it } from "vitest";
import { ago, formatIdt, shortHash } from "../src/format.ts";

describe("formatIdt", () => {
  it("formats planck amounts with twelve decimals", () => {
    expect(formatIdt("0")).toBe("0 IDT");
    expect(formatIdt("1")).toBe("0.000000000001 IDT");
    expect(formatIdt("1000000000000")).toBe("1 IDT");
    expect(formatIdt("1500000000000")).toBe("1.5 IDT");
    expect(formatIdt("1234567000000000000")).toBe("1,234,567 IDT");
    expect(formatIdt("123456789012345678901234567890")).toBe("123,456,789,012,345,678.90123456789 IDT");
  });

  it("leaves a value that is not a planck amount as it is", () => {
    expect(formatIdt("")).toBe("");
    expect(formatIdt("12.5")).toBe("12.5");
    expect(formatIdt("-3")).toBe("-3");
  });
});

describe("ago", () => {
  const now = 1_800_000_000_000;
  it("says how long ago, in the largest whole unit", () => {
    expect(ago(now, now)).toBe("just now");
    expect(ago(now - 999, now)).toBe("just now");
    expect(ago(now - 6_000, now)).toBe("6 s ago");
    expect(ago(now - 59_999, now)).toBe("59 s ago");
    expect(ago(now - 60_000, now)).toBe("1 min ago");
    expect(ago(now - 3_600_000 * 5, now)).toBe("5 h ago");
    expect(ago(now - 86_400_000 * 3, now)).toBe("3 d ago");
  });

  it("does not show a time in the future when the clocks disagree", () => {
    expect(ago(now + 4_000, now)).toBe("just now");
  });
});

describe("shortHash", () => {
  it("keeps the edges of a hash", () => {
    const hash = `0x${"ab".repeat(16)}${"cd".repeat(16)}`;
    expect(shortHash(hash)).toBe("0xababab…cdcdcd");
    expect(shortHash("0x1234")).toBe("0x1234");
  });
});
