// Turning a picked image into the avatar the chain accepts: a square crop, 64 by 64 pixels, as a
// WebP of at most 8 192 bytes (pallets/identitee/src/limits.rs and validate.rs).
//
// `checkAvatar` is the browser's copy of the runtime's `validate_avatar`: whatever it lets through,
// the chain accepts, so a wrong image is refused here, with a sentence, instead of by a failed
// transaction. Nothing is trusted from the browser's encoder: a browser that cannot encode WebP
// returns a PNG from `toBlob` without a word, and only the RIFF signature tells the two apart.

import { Refusal } from "../chain/refusal.ts";

/** The only size the chain accepts, in pixels. */
export const AVATAR_SIZE = 64;
/** The largest avatar the chain accepts, in bytes. */
export const AVATAR_MAX_BYTES = 8192;

export type AvatarProblem = "too-large" | "not-webp" | "unsupported" | "truncated" | "bad-size" | "cannot-encode" | "cannot-read";

const MESSAGES: Record<AvatarProblem, string> = {
  "too-large": "This image is too detailed to fit in 8 KB. Try a simpler picture.",
  "not-webp": "This browser could not make a WebP image.",
  unsupported: "This is not a WebP image the network accepts.",
  truncated: "The image is incomplete.",
  "bad-size": "The avatar must be 64 by 64 pixels.",
  "cannot-encode": "This browser could not make a WebP image.",
  "cannot-read": "This file cannot be opened as an image. Choose a PNG, JPEG or WebP.",
};

/** A sentence for the person, so a page that builds the call shows it as it is. */
export class AvatarError extends Refusal {
  constructor(readonly reason: AvatarProblem) {
    super(MESSAGES[reason]);
    this.name = "AvatarError";
  }
}

// --- Checking a WebP, as the runtime does -----------------------------------------------------

const RIFF_HEADER_LEN = 12;
const CHUNK_HEADER_LEN = 8;
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function magic(bytes: Uint8Array, offset: number, expected: string): void {
  for (const [i, byte] of ascii(expected).entries()) {
    const found = bytes[offset + i];
    // a byte that is there and wrong wins over a byte that is missing, as in the runtime
    if (found === undefined) throw new AvatarError("truncated");
    if (found !== byte) throw new AvatarError("not-webp");
  }
}

const u32 = (bytes: Uint8Array, offset: number): number => {
  if (offset + 4 > bytes.length) throw new AvatarError("truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
};

function head(payload: Uint8Array, length: number): Uint8Array {
  if (payload.length < length) throw new AvatarError("truncated");
  return payload;
}

/** `VP8 `: a 3-byte frame tag, the start code 9d 01 2a, then 14-bit width and height. */
function vp8(payload: Uint8Array): [number, number] {
  head(payload, 10);
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) throw new AvatarError("not-webp");
  return [(payload[6]! | (payload[7]! << 8)) & 0x3fff, (payload[8]! | (payload[9]! << 8)) & 0x3fff];
}

/** `VP8L`: the signature 0x2f, then 14 bits of width - 1 and 14 bits of height - 1. */
function vp8l(payload: Uint8Array): [number, number] {
  head(payload, 5);
  if (payload[0] !== 0x2f) throw new AvatarError("not-webp");
  const bits = u32(payload, 1);
  return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
}

/** `VP8X`: flags and 3 reserved bytes, then the canvas width - 1 and height - 1 on 24 bits. */
function vp8x(payload: Uint8Array): [number, number] {
  head(payload, 10);
  return [(payload[4]! | (payload[5]! << 8) | (payload[6]! << 16)) + 1, (payload[7]! | (payload[8]! << 8) | (payload[9]! << 16)) + 1];
}

/**
 * Check that `bytes` is a 64 by 64 WebP of at most 8 192 bytes, from its headers alone, in the
 * same order and with the same verdicts as the runtime's `validate_avatar`. Returns the size;
 * throws an `AvatarError` otherwise.
 */
export function checkAvatar(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > AVATAR_MAX_BYTES) throw new AvatarError("too-large");
  magic(bytes, 0, "RIFF");
  magic(bytes, 8, "WEBP");
  // the announced size is never trusted beyond the buffer
  const end = u32(bytes, 4) + 8;
  if (end > bytes.length) throw new AvatarError("truncated");
  const riff = bytes.subarray(0, end);
  if (riff.length < RIFF_HEADER_LEN + 4) throw new AvatarError("truncated");
  const code = String.fromCharCode(...riff.subarray(RIFF_HEADER_LEN, RIFF_HEADER_LEN + 4));
  const size = u32(riff, RIFF_HEADER_LEN + 4);
  const read = code === "VP8 " ? vp8 : code === "VP8L" ? vp8l : code === "VP8X" ? vp8x : null;
  if (read === null) throw new AvatarError("unsupported");
  const start = RIFF_HEADER_LEN + CHUNK_HEADER_LEN;
  if (start + size > riff.length) throw new AvatarError("truncated");
  const [width, height] = read(riff.subarray(start, start + size));
  if (width !== AVATAR_SIZE || height !== AVATAR_SIZE) throw new AvatarError("bad-size");
  return { width, height };
}

/** Whether `bytes` starts like a WebP file (RIFF, then WEBP), whatever its size or content. */
export function looksLikeWebp(bytes: Uint8Array): boolean {
  return bytes.length >= RIFF_HEADER_LEN && ascii("RIFF").every((b, i) => bytes[i] === b) && ascii("WEBP").every((b, i) => bytes[8 + i] === b);
}

// --- Fitting the size -------------------------------------------------------------------------

export interface Encoded {
  bytes: Uint8Array;
  /** 0 to 1, as `canvas.toBlob` takes it. */
  quality: number;
}

const FIRST_QUALITY = 0.92;
const LOWEST_QUALITY = 0.05;
const SEARCH_STEPS = 7;

/**
 * Encode at the first quality that is good enough; when the result is over 8 192 bytes, search the
 * qualities below it (the size grows with the quality) for the best one that fits. A result that
 * is not a valid avatar is an error, never something to send.
 */
export async function fitQuality(encode: (quality: number) => Promise<Uint8Array>): Promise<Encoded> {
  const attempt = async (quality: number): Promise<Encoded | null> => {
    const bytes = await encode(quality);
    if (!looksLikeWebp(bytes)) throw new AvatarError("not-webp");
    return bytes.length <= AVATAR_MAX_BYTES ? { bytes, quality } : null;
  };
  const first = await attempt(FIRST_QUALITY);
  let best = first;
  if (best === null) {
    let low = LOWEST_QUALITY;
    let high = FIRST_QUALITY;
    best = await attempt(low);
    if (best === null) throw new AvatarError("too-large");
    for (let step = 0; step < SEARCH_STEPS; step++) {
      const middle = (low + high) / 2;
      const found = await attempt(middle);
      if (found === null) high = middle;
      else {
        best = found;
        low = middle;
      }
    }
  }
  checkAvatar(best.bytes);
  return best;
}

// --- The square crop --------------------------------------------------------------------------

/** A square of the source image, in its pixels. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

const MIN_CROP = 16;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** The largest square, centred. */
export function initialCrop(width: number, height: number): Crop {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/** Move the square by `dx`, `dy` source pixels; it stays inside the image. */
export function moveCrop(crop: Crop, dx: number, dy: number, width: number, height: number): Crop {
  return { ...crop, x: clamp(crop.x + dx, 0, width - crop.size), y: clamp(crop.y + dy, 0, height - crop.size) };
}

/** Make the square `factor` times closer (above 1) or further (below 1), about its centre. It
 * never exceeds the short side of the image nor goes under 16 pixels. */
export function zoomCrop(crop: Crop, factor: number, width: number, height: number): Crop {
  const size = clamp(crop.size / factor, Math.min(MIN_CROP, Math.min(width, height)), Math.min(width, height));
  const cx = crop.x + crop.size / 2;
  const cy = crop.y + crop.size / 2;
  return { x: clamp(cx - size / 2, 0, width - size), y: clamp(cy - size / 2, 0, height - size), size };
}

// --- Drawing and encoding in the browser ------------------------------------------------------

/** What `drawImage` takes and that knows its size. */
export type Picture = (ImageBitmap | HTMLImageElement | HTMLCanvasElement) & { width: number; height: number };

const canvasOf = (size: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
};

/**
 * Draw `crop` of `picture` into a canvas of `size` pixels. A big image is halved step by step
 * (one `drawImage` from 4000 pixels to 64 skips most of the source and aliases).
 */
export function renderSquare(picture: Picture, crop: Crop, size: number = AVATAR_SIZE): HTMLCanvasElement {
  let source: CanvasImageSource = picture;
  let { x, y, size: side } = crop;
  while (side / 2 >= size) {
    const half = Math.round(side / 2);
    const step = canvasOf(half);
    const context = step.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, x, y, side, side, 0, 0, half, half);
    source = step;
    x = 0;
    y = 0;
    side = half;
  }
  const canvas = canvasOf(size);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, x, y, side, side, 0, 0, size, size);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));

/** The canvas as WebP bytes with the browser's own encoder, `null` when it makes something else. */
async function nativeWebp(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  const blob = await toBlob(canvas, quality);
  if (blob === null) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return looksLikeWebp(bytes) ? bytes : null;
}

let nativeWorks: boolean | undefined;

/** The canvas as WebP bytes: by the browser when it can, else by a WebP encoder loaded only now
 * (Safari answers `toBlob("image/webp")` with a PNG). */
export async function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  if (nativeWorks !== false) {
    const bytes = await nativeWebp(canvas, quality);
    nativeWorks = bytes !== null;
    if (bytes !== null) return bytes;
  }
  try {
    const { default: encode } = await import("@jsquash/webp/encode.js");
    const image = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    return new Uint8Array(await encode(image, { quality: Math.round(quality * 100) }));
  } catch {
    throw new AvatarError("cannot-encode");
  }
}

/** The avatar for `crop` of `picture`: 64 by 64, WebP, at most 8 192 bytes, checked. */
export async function encodeAvatar(picture: Picture, crop: Crop): Promise<Encoded> {
  const canvas = renderSquare(picture, crop);
  return fitQuality((quality) => canvasToWebp(canvas, quality));
}

/** A picked file as a picture the canvas can draw (rotated as its EXIF says). */
export async function openPicture(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new AvatarError("cannot-read");
  }
}
