import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type PublicKey, paintPixels } from "./pixels.ts";

const MAX_PIXEL_RATIO = 2;

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The generated avatar of a public key, `size` CSS pixels wide.
 *
 * It repaints when the key's CONTENT or the size changes, not when a new array holding the same
 * key is passed. The key must be valid (32 bytes): callers decode an address first, and show a
 * "not found" page for one that does not decode. A bad key still never throws here: the canvas
 * stays blank.
 */
export function Avatar({ publicKey, size, label = "Avatar generated from the address" }: { publicKey: PublicKey; size: number; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(publicKey);
  latest.current = publicKey;
  const content = typeof publicKey === "string" ? publicKey : hexOf(publicKey);
  useEffect(() => {
    const el = canvas.current!;
    el.width = el.height = Math.round(size * Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO));
    try {
      paintPixels(el, latest.current);
    } catch {
      // not a key: leave the canvas blank
    }
  }, [content, size]);
  return <canvas ref={canvas} class="avatar" style={{ width: `${size}px`, height: `${size}px` }} role="img" aria-label={label} />;
}

function dataUrl(webp: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < webp.length; i += 0x2000) binary += String.fromCharCode(...webp.subarray(i, i + 0x2000));
  return `data:image/webp;base64,${btoa(binary)}`;
}

/** The avatar stored on chain (a 64 by 64 WebP), `size` CSS pixels wide. If the browser cannot
 * show it, the generated avatar of the same account takes its place. */
export function ChainAvatar({ webp, publicKey, size, label = "Avatar" }: { webp: Uint8Array; publicKey: PublicKey; size: number; label?: string }) {
  const src = useMemo(() => dataUrl(webp), [webp]);
  // the image that failed, not a flag: a new image gets its own chance
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return <Avatar publicKey={publicKey} size={size} />;
  return <img class="avatar" src={src} width={size} height={size} alt={label} onError={() => setFailed(src)} />;
}
