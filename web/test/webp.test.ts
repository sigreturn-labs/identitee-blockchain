import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AVATAR_MAX_BYTES,
  AVATAR_SIZE,
  AvatarError,
  type Crop,
  checkAvatar,
  fitQuality,
  initialCrop,
  looksLikeWebp,
  moveCrop,
  zoomCrop,
} from "../src/media/webp.ts";

// The same files the runtime tests its own avatar validator with (pallets/identitee/tests/fixtures).
const fixtures = join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures");
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, name)));
const LOSSY = file("avatar-64-lossy.webp");
const LOSSLESS = file("avatar-64-lossless.webp");
const ALPHA = file("avatar-64-alpha.webp");
const WIDE = file("avatar-65x64.webp");
const PNG = file("avatar-64.png");

const reasonOf = (bytes: Uint8Array): string | undefined => {
  try {
    checkAvatar(bytes);
  } catch (e) {
    return e instanceof AvatarError ? e.reason : `other: ${String(e)}`;
  }
  return undefined;
};

describe("the limits are those of the runtime", () => {
  it("is 64 by 64 and at most 8 192 bytes", () => {
    expect(AVATAR_SIZE).toBe(64);
    expect(AVATAR_MAX_BYTES).toBe(8192);
    const limits = readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "src", "limits.rs"), "utf8");
    expect(limits).toContain("pub const MAX_AVATAR_LEN: u32 = 8192;");
    expect(limits).toContain("pub const AVATAR_SIZES: [(u32, u32); 1] = [(64, 64)];");
  });
});

describe("checkAvatar, the browser's copy of the runtime's validate_avatar", () => {
  it.each([
    ["lossy (VP8)", LOSSY],
    ["lossless (VP8L)", LOSSLESS],
    ["with alpha (VP8X)", ALPHA],
  ])("accepts a 64 by 64 WebP, %s", (_, bytes) => {
    expect(checkAvatar(bytes)).toEqual({ width: 64, height: 64 });
  });

  it("rejects 65 by 64", () => {
    expect(reasonOf(WIDE)).toBe("bad-size");
  });

  it("rejects a PNG, which is what a browser returns when it cannot make a WebP", () => {
    expect(reasonOf(PNG)).toBe("not-webp");
  });

  it("rejects RIFF that is not WebP", () => {
    const wave = LOSSY.slice();
    wave.set(new TextEncoder().encode("WAVE"), 8);
    expect(reasonOf(wave)).toBe("not-webp");
  });

  it("rejects a wrong bitstream signature in the first chunk", () => {
    const vp8 = LOSSY.slice();
    vp8[23] = 0; // the start code 9d 01 2a begins 3 bytes into the payload (20 + 3)
    expect(reasonOf(vp8)).toBe("not-webp");
    const vp8l = LOSSLESS.slice();
    vp8l[20] = 0; // the signature 0x2f is the first payload byte
    expect(reasonOf(vp8l)).toBe("not-webp");
  });

  it("rejects a first chunk that is none of VP8, VP8L and VP8X", () => {
    const other = LOSSY.slice();
    other.set(new TextEncoder().encode("ALPH"), 12);
    expect(reasonOf(other)).toBe("unsupported");
  });

  it("rejects wrong dimensions in every container", () => {
    const vp8 = LOSSY.slice();
    vp8[26] = 65; // width 65 (low byte at 20 + 6)
    expect(reasonOf(vp8)).toBe("bad-size");
    const vp8l = LOSSLESS.slice();
    vp8l[21] = 0x3f - 1; // width - 1 in the low 14 bits: 62
    expect(reasonOf(vp8l)).toBe("bad-size");
    const vp8x = ALPHA.slice();
    vp8x[24] = 0x40; // canvas width - 1 = 64: a width of 65
    expect(reasonOf(vp8x)).toBe("bad-size");
  });

  it("ignores the two scaling bits of a VP8 size", () => {
    const scaled = LOSSY.slice();
    scaled[27]! |= 0xc0;
    expect(checkAvatar(scaled)).toEqual({ width: 64, height: 64 });
  });

  it("rejects more than 8 192 bytes, exactly as the runtime does", () => {
    const padded = (bytes: Uint8Array, length: number): Uint8Array => {
      const out = new Uint8Array(length);
      out.set(bytes);
      return out;
    };
    expect(checkAvatar(padded(LOSSY, 8192))).toEqual({ width: 64, height: 64 });
    expect(reasonOf(padded(LOSSY, 8193))).toBe("too-large");
    expect(reasonOf(padded(PNG, 8193))).toBe("too-large");
  });

  it("rejects a truncated file, and one announcing more than it holds", () => {
    expect(reasonOf(LOSSY.subarray(0, 20))).toBe("truncated");
    expect(reasonOf(LOSSY.subarray(0, LOSSY.length - 1))).toBe("truncated");
    expect(reasonOf(new Uint8Array())).toBe("truncated");
    const hostile = LOSSY.slice();
    new DataView(hostile.buffer).setUint32(4, 0xffffffff, true);
    expect(reasonOf(hostile)).toBe("truncated");
  });
});

describe("looksLikeWebp", () => {
  it("tells a WebP from the PNG a browser falls back to", () => {
    expect(looksLikeWebp(LOSSY)).toBe(true);
    expect(looksLikeWebp(WIDE)).toBe(true);
    expect(looksLikeWebp(PNG)).toBe(false);
    expect(looksLikeWebp(new Uint8Array(4))).toBe(false);
  });
});

describe("fitQuality", () => {
  /** An encoder whose output grows with the quality: `size(q)` bytes, valid WebP header. */
  const encoder = (size: (quality: number) => number) =>
    vi.fn(async (quality: number) => {
      const bytes = new Uint8Array(size(quality));
      bytes.set(LOSSY.subarray(0, Math.min(LOSSY.length, bytes.length)));
      return bytes;
    });

  it("takes the first try when it already fits", async () => {
    const encode = encoder(() => 3000);
    const fit = await fitQuality(encode);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(fit.bytes.length).toBe(3000);
    expect(fit.quality).toBeGreaterThanOrEqual(0.9);
  });

  it("lowers the quality until the image is at most 8 192 bytes, and keeps the best that fits", async () => {
    const encode = encoder((q) => Math.round(q * 20000));
    const fit = await fitQuality(encode);
    expect(fit.bytes.length).toBeLessThanOrEqual(8192);
    // the best quality that fits is about 0.41: the search ends within a few percent of it
    expect(fit.quality).toBeGreaterThan(0.38);
    expect(fit.quality).toBeLessThanOrEqual(8192 / 20000);
    expect(encode.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("gives up with a clear error when even the lowest quality is too large", async () => {
    const encode = encoder(() => 9000);
    await expect(fitQuality(encode)).rejects.toMatchObject({ name: "AvatarError", reason: "too-large" });
  });

  it("does not hand back an image the runtime would refuse", async () => {
    const png = vi.fn(async () => PNG);
    await expect(fitQuality(png)).rejects.toMatchObject({ reason: "not-webp" });
  });

  it("stops at once on something that is not a WebP, however big, instead of searching on", async () => {
    const big = new Uint8Array(9000);
    big.set(PNG);
    const png = vi.fn(async () => big);
    await expect(fitQuality(png)).rejects.toMatchObject({ reason: "not-webp" });
    expect(png).toHaveBeenCalledTimes(1);
  });
});

describe("cropping", () => {
  it("starts with the largest centred square", () => {
    expect(initialCrop(400, 300)).toEqual({ x: 50, y: 0, size: 300 });
    expect(initialCrop(300, 400)).toEqual({ x: 0, y: 50, size: 300 });
    expect(initialCrop(64, 64)).toEqual({ x: 0, y: 0, size: 64 });
  });

  it("moves, and never leaves the image", () => {
    const crop: Crop = { x: 50, y: 0, size: 300 };
    expect(moveCrop(crop, -20, 0, 400, 300)).toEqual({ x: 30, y: 0, size: 300 });
    expect(moveCrop(crop, -500, 40, 400, 300)).toEqual({ x: 0, y: 0, size: 300 });
    expect(moveCrop(crop, 500, 0, 400, 300)).toEqual({ x: 100, y: 0, size: 300 });
  });

  it("zooms about its centre, between the whole short side and 16 pixels", () => {
    const crop = initialCrop(400, 300);
    const closer = zoomCrop(crop, 2, 400, 300);
    expect(closer.size).toBe(150);
    expect(closer.x + closer.size / 2).toBe(crop.x + crop.size / 2);
    expect(closer.y + closer.size / 2).toBe(crop.y + crop.size / 2);
    expect(zoomCrop(crop, 0.5, 400, 300)).toEqual(crop);
    expect(zoomCrop(crop, 1000, 400, 300).size).toBe(16);
    const edge = zoomCrop({ x: 100, y: 0, size: 300 }, 4, 400, 300);
    expect(edge.x).toBeGreaterThanOrEqual(0);
    expect(edge.x + edge.size).toBeLessThanOrEqual(400);
  });
});
