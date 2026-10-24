import { describe, expect, it } from "vitest";
import { pixelCells } from "../src/ui/pixels.ts";

const KEY_A = "fafe6ff6945e27f3c39fe8bf5a90cb0fa61b3c27c9faa3ba3741362643ee303f";
const KEY_B = "8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const draw = (key: string | Uint8Array) => pixelCells(key).map((row) => row.map((on) => (on ? "#" : ".")).join(""));
const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe("pixels", () => {
  // the reference grid was computed with the avatar options page's code (the key as one BigInt, bit by bit)
  it("draws the reference grid for the reference key", () => {
    expect(draw(KEY_A)).toEqual(["#########", "#.......#", "..##.##..", "..#####..", ".#######.", "#.......#", "#..###..#", "..#...#..", ".##.#.##."]);
  });

  it("reads the same key as hex (with or without 0x) or as bytes", () => {
    expect(draw(`0x${KEY_A}`)).toEqual(draw(KEY_A));
    expect(draw(bytesOf(KEY_A))).toEqual(draw(KEY_A));
  });

  it("is mirrored left to right", () => {
    for (const row of pixelCells(KEY_B)) expect(row).toEqual([...row].reverse());
  });

  it("differs for two keys", () => {
    expect(draw(KEY_B)).not.toEqual(draw(KEY_A));
  });

  it("uses each of the 45 lowest bits, each for one cell and its mirror", () => {
    const zero = new Uint8Array(32);
    for (let bit = 0; bit < 45; bit++) {
      const key = new Uint8Array(32);
      key[31 - (bit >> 3)] = 1 << (bit & 7);
      const lit = pixelCells(key).flat().filter(Boolean).length;
      expect(lit).toBe(bit % 5 === 4 ? 1 : 2);
    }
    expect(pixelCells(zero).flat().some(Boolean)).toBe(false);
  });

  it("rejects anything that is not a 32-byte public key", () => {
    expect(() => pixelCells("abcd")).toThrow(/32-byte/);
    expect(() => pixelCells("zz".repeat(32))).toThrow(/32-byte/);
    expect(() => pixelCells(new Uint8Array(31))).toThrow(/32-byte/);
  });
});
