import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The text colours must stay readable on the card, which is frosted glass over the animated
// background. The ground behind the text moves, so each ink gets a contrast budget against two
// reference grounds: a typical one (the darker folds most of the card sits on) and the brightest
// one (the lightest fold showing through the glass). The quietest ink must meet WCAG AA (4.5:1) on
// the typical ground and stay above 3:1 on the brightest.

const css = readFileSync(join(import.meta.dirname, "../src/ui/tokens.css"), "utf8");
const token = (name: string): string => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!;

const channel = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (fg: string, bg: string): number => {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const TYPICAL_GROUND = "#1e1e1e";
const BRIGHTEST_GROUND = "#3f3f3f";

describe("text colours on the card", () => {
  it("keeps the quietest text (ink-3: labels, addresses of links) at 4.5:1 on the typical card ground", () => {
    expect(contrast(token("ink-3"), TYPICAL_GROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps ink-3 at 3:1 where the smoke behind the glass is at its brightest", () => {
    expect(contrast(token("ink-3"), BRIGHTEST_GROUND)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the two stronger inks well above, and in order", () => {
    expect(contrast(token("ink"), TYPICAL_GROUND)).toBeGreaterThanOrEqual(12);
    expect(contrast(token("ink-2"), TYPICAL_GROUND)).toBeGreaterThanOrEqual(6);
    expect(luminance(token("ink"))).toBeGreaterThan(luminance(token("ink-2")));
    expect(luminance(token("ink-2"))).toBeGreaterThan(luminance(token("ink-3")));
  });
});
