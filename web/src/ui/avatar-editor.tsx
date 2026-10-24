// Picking an image and turning it into the avatar: choose a file, move and zoom the square that
// will be kept, see the 64 by 64 WebP that will be stored (decoded from the very bytes that would
// be sent, with their size), save. The pixels are cropped and encoded here, in the browser: the
// picture never goes anywhere but, as those few bytes, to the chain.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  AVATAR_MAX_BYTES,
  AVATAR_SIZE,
  AvatarError,
  type Crop,
  type Encoded,
  type Picture,
  checkAvatar,
  encodeAvatar,
  initialCrop,
  moveCrop,
  openPicture,
  zoomCrop,
} from "../media/webp.ts";

/** The side of the crop window, in CSS pixels. */
const VIEW = 232;
/** The most a picture is magnified, and the most a file may weigh before it is not even opened. */
const MAX_ZOOM = 8;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export interface AvatarEditorProps {
  /** Something else is being saved: nothing can be sent now. */
  pending: boolean;
  /** Send the checked WebP; resolves `true` when it is saved. */
  onSave(webp: Uint8Array): Promise<boolean>;
  onCancel(): void;
  /** Open a picked file as a picture (replaceable for tests). */
  open?: (file: Blob) => Promise<Picture>;
  /** Make the avatar for a crop (replaceable for tests). */
  encode?: (picture: Picture, crop: Crop) => Promise<Encoded>;
}

/** An encoded avatar, with the picture and the crop it was made from. */
interface Preview extends Encoded {
  url: string;
  picture: Picture;
  crop: Crop;
}

const sentence = (error: unknown): string =>
  error instanceof AvatarError ? error.message : "This image could not be used.";

export function AvatarEditor({ pending, onSave, onCancel, open = openPicture, encode = encodeAvatar }: AvatarEditorProps) {
  const file = useRef<HTMLInputElement>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const width = picture?.width ?? 0;
  const height = picture?.height ?? 0;
  const base = Math.min(width, height);

  async function choose(blob: Blob | undefined) {
    if (!blob) return;
    setProblem(null);
    if (blob.size > MAX_FILE_BYTES) return setProblem("That file is too large. Choose an image under 30 MB.");
    if (blob.type === "image/svg+xml" || (blob instanceof File && /\.svg$/i.test(blob.name))) {
      return setProblem("SVG images cannot be used. Choose a PNG, JPEG or WebP.");
    }
    try {
      const next = await open(blob);
      setPicture(next);
      setCrop(initialCrop(next.width, next.height));
    } catch (error) {
      setProblem(sentence(error));
    }
  }

  // the window: the crop, with the part that the round avatar will cut off dimmed
  useEffect(() => {
    const canvas = view.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !picture || !crop) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(VIEW * ratio);
    const side = canvas.width;
    context.clearRect(0, 0, side, side);
    context.imageSmoothingQuality = "high";
    context.drawImage(picture, crop.x, crop.y, crop.size, crop.size, 0, 0, side, side);
    context.fillStyle = "rgba(7, 7, 7, 0.66)";
    context.beginPath();
    context.rect(0, 0, side, side);
    context.arc(side / 2, side / 2, side / 2 - ratio, 0, Math.PI * 2, true);
    context.fill("evenodd");
    context.strokeStyle = "rgba(255, 255, 255, 0.4)";
    context.lineWidth = ratio;
    context.beginPath();
    context.arc(side / 2, side / 2, side / 2 - ratio, 0, Math.PI * 2);
    context.stroke();
  }, [picture, crop]);

  // the result: what would be stored, shown from its own bytes
  useEffect(() => {
    if (!picture || !crop) return;
    let current = true;
    const timer = setTimeout(() => {
      encode(picture, crop).then(
        (made) => {
          if (!current) return;
          const url = URL.createObjectURL(new Blob([made.bytes as BlobPart], { type: "image/webp" }));
          setPreview((old) => {
            if (old) URL.revokeObjectURL(old.url);
            return { ...made, url, picture, crop };
          });
          setProblem(null);
        },
        (error: unknown) => {
          if (!current) return;
          setPreview((old) => {
            if (old) URL.revokeObjectURL(old.url);
            return null;
          });
          setProblem(sentence(error));
        },
      );
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [picture, crop]);

  // The preview belongs to the crop it was made for: between a move or a zoom and the new encoding
  // it is stale, and what is saved must be what is on screen.
  const fresh = preview !== null && preview.picture === picture && preview.crop === crop;

  // A replaced picture is released, and so is the last one when the editor goes away (an
  // ImageBitmap holds decoded pixels until it is closed).
  useEffect(
    () => () => {
      (picture as { close?: () => void } | null)?.close?.();
    },
    [picture],
  );

  const latest = useRef<Preview | null>(null);
  latest.current = preview;
  useEffect(
    () => () => {
      if (latest.current) URL.revokeObjectURL(latest.current.url);
    },
    [],
  );

  function zoomTo(zoom: number) {
    if (crop) setCrop(zoomCrop(crop, crop.size / (base / zoom), width, height));
  }

  function press(event: KeyboardEvent) {
    if (!crop) return;
    const step = crop.size * 0.05;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) setCrop(moveCrop(crop, move[0], move[1], width, height));
    else if (event.key === "+" || event.key === "=") setCrop(zoomCrop(crop, 1.1, width, height));
    else if (event.key === "-") setCrop(zoomCrop(crop, 1 / 1.1, width, height));
    else return;
    event.preventDefault();
  }

  const zoom = crop && base > 0 ? base / crop.size : 1;
  const maxZoom = base > 0 ? Math.max(1, Math.min(MAX_ZOOM, base / 16)) : MAX_ZOOM;

  async function save() {
    if (!preview || !fresh) return;
    try {
      checkAvatar(preview.bytes);
    } catch (error) {
      return setProblem(sentence(error));
    }
    if (await onSave(preview.bytes)) onCancel();
  }

  return (
    <div
      class="avatar-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void choose(e.currentTarget.files?.[0])} />
      {picture && crop && (
        <div class="crop">
          <div class="crop-view">
            <canvas
              ref={view}
              class="crop-canvas"
              style={{ width: `${VIEW}px`, height: `${VIEW}px` }}
              tabIndex={0}
              role="img"
              aria-label="Crop of the avatar. Drag to move, arrow keys to move, plus and minus to zoom."
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerMove={(e) => {
                const from = drag.current;
                if (!from) return;
                const scale = crop.size / VIEW;
                setCrop((now) => (now ? moveCrop(now, -(e.clientX - from.x) * scale, -(e.clientY - from.y) * scale, width, height) : now));
                drag.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={press}
              onWheel={(e) => {
                e.preventDefault();
                setCrop((now) => (now ? zoomCrop(now, e.deltaY < 0 ? 1.08 : 1 / 1.08, width, height) : now));
              }}
            />
            <label class="zoom">
              <span>Zoom</span>
              <input
                type="range"
                min="1"
                max={String(maxZoom)}
                step="0.01"
                value={String(zoom)}
                disabled={maxZoom <= 1}
                onInput={(e) => zoomTo(Number(e.currentTarget.value))}
              />
            </label>
          </div>
          <div class="crop-result">
            {preview ? (
              <>
                <img class={fresh ? "avatar" : "avatar stale"} src={preview.url} width={AVATAR_SIZE} height={AVATAR_SIZE} alt="The avatar as it will be saved" />
                <span class="addr">{(preview.bytes.length / 1024).toFixed(1)} KB of {AVATAR_MAX_BYTES / 1024} KB</span>
              </>
            ) : (
              <span class="bone avatar" style={{ width: `${AVATAR_SIZE}px`, height: `${AVATAR_SIZE}px` }} aria-hidden="true" />
            )}
          </div>
        </div>
      )}
      {problem && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="actions">
        <button class={picture ? "button" : "button primary"} type="button" disabled={pending} onClick={() => file.current?.click()}>
          {picture ? "Choose another image" : "Choose an image"}
        </button>
        {picture && (
          <button class="button primary" type="button" disabled={pending || !fresh} onClick={() => void save()}>
            Use this image
          </button>
        )}
        <button class="button" type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
