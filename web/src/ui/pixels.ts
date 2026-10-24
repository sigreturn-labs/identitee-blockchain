// Pixels: the default avatar. A 9 by 9 grid, mirrored left to right, light cells on a black disc,
// computed from the public key only, so it never changes with the level or the profile.
//
// The key is read as one number. Each cell of the left half and the middle column (45 cells) takes
// the next bit, lowest first, and the right half mirrors the left. Two keys get the same avatar
// only if those 45 bits are equal: 2^45 pictures, so a double becomes likely past ~7 million
// accounts.

export type PublicKey = Uint8Array | string;

export const GRID = 9;
const HALF = Math.ceil(GRID / 2);
// the grid stays inside the disc's inscribed square, with a little air
const MARGIN = 0.17;
const GROUND = "#121212";
const CELL = "#ececea";
const EDGE = "rgba(255,255,255,0.22)";

/** Reads a 32-byte public key from bytes or from hex (with or without 0x). */
export function keyBytes(key: PublicKey): Uint8Array {
  if (typeof key !== "string") {
    if (key.length !== 32) throw new Error("The avatar needs a 32-byte public key");
    return key;
  }
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("The avatar needs a 32-byte public key");
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

/** The grid of a public key, row by row: `true` for a light cell. */
export function pixelCells(key: PublicKey): boolean[][] {
  const bytes = keyBytes(key);
  // the key as a big-endian number: its lowest bits are in the last bytes
  let bit = 0;
  const next = () => {
    const on = ((bytes[31 - (bit >> 3)]! >> (bit & 7)) & 1) === 1;
    bit++;
    return on;
  };
  const rows: boolean[][] = [];
  for (let r = 0; r < GRID; r++) {
    const row = new Array<boolean>(GRID).fill(false);
    for (let c = 0; c < HALF; c++) row[c] = row[GRID - 1 - c] = next();
    rows.push(row);
  }
  return rows;
}

/** Draws the avatar on a square canvas, at its pixel size, with whole-pixel cells. */
export function paintPixels(canvas: HTMLCanvasElement, key: PublicKey): void {
  const cells = pixelCells(key);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const s = canvas.width;
  const cell = Math.floor((s * (1 - 2 * MARGIN)) / GRID);
  const start = Math.round((s - cell * GRID) / 2);
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = CELL;
  cells.forEach((row, r) => row.forEach((on, c) => on && ctx.fillRect(start + c * cell, start + r * cell, cell, cell)));
  // a thin edge so the black disc still reads on the dark background
  const line = Math.max(1, Math.round(s / 56));
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - line / 2, 0, 2 * Math.PI);
  ctx.stroke();
}
