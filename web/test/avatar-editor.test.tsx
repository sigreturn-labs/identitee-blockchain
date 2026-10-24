// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarEditor } from "../src/ui/avatar-editor.tsx";
import { AvatarError, type Crop, type Encoded, type Picture } from "../src/media/webp.ts";

const LOSSY = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures", "avatar-64-lossy.webp")));
const LOSSLESS = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures", "avatar-64-lossless.webp")));
const PNG = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures", "avatar-64.png")));
const picture = { width: 400, height: 300 } as Picture;

let root: HTMLElement | undefined;
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => text(b));
const press = async (label: string) => {
  const button = [...root!.querySelectorAll("button")].find((b) => text(b) === label)!;
  await act(() => button.click());
  await settle();
};

async function show(props: Partial<Parameters<typeof AvatarEditor>[0]> = {}) {
  const open = vi.fn(async () => picture);
  const encode = vi.fn(async (_p: Picture, _c: Crop): Promise<Encoded> => ({ bytes: LOSSY, quality: 0.92 }));
  const onSave = vi.fn(async (_: Uint8Array) => true);
  const onCancel = vi.fn();
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<AvatarEditor pending={false} onSave={onSave} onCancel={onCancel} open={open} encode={encode} {...props} />, root!));
  return { open, encode, onSave, onCancel };
}

/** Pick a file the way the browser does: set the input's files and fire change. */
async function pick(blob: Blob) {
  const input = root!.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [blob], configurable: true });
  await act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
  // the picture, then the crop window, then the encoded result after its short delay
  await vi.waitFor(() => expect(root!.querySelector(".crop, .problem")).not.toBeNull(), { timeout: 2000 });
  await settle(250);
}

beforeEach(() => {
  let n = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${++n}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe("AvatarEditor", () => {
  it("starts with a way to choose an image and nothing else to do but cancel", async () => {
    const { onCancel } = await show();
    expect(buttons(root!)).toEqual(["Choose an image", "Cancel"]);
    expect(root!.querySelector("input[type=file]")?.getAttribute("accept")).toBe("image/*");
    expect(root!.querySelector(".crop")).toBeNull();
    await press("Cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the crop and the avatar that would be saved, with its size, once an image is chosen", async () => {
    const { open, encode } = await show();
    await pick(new File([new Uint8Array(10)], "me.png", { type: "image/png" }));
    expect(open).toHaveBeenCalledTimes(1);
    // the largest centred square of a 400 by 300 picture
    expect(encode).toHaveBeenLastCalledWith(picture, { x: 50, y: 0, size: 300 });
    const result = root!.querySelector<HTMLImageElement>(".crop-result img")!;
    expect(result.getAttribute("src")).toMatch(/^blob:preview-/);
    expect(result.getAttribute("width")).toBe("64");
    expect(text(root!.querySelector(".crop-result .addr"))).toBe(`${(LOSSY.length / 1024).toFixed(1)} KB of 8 KB`);
    expect(buttons(root!)).toEqual(["Choose another image", "Use this image", "Cancel"]);
  });

  it("saves the bytes that were shown, then closes", async () => {
    const { onSave, onCancel } = await show();
    await pick(new File([new Uint8Array(10)], "me.png"));
    await press("Use this image");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toBe(LOSSY);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not save a stale preview: Save waits for the new encoding after a zoom, and sends what is shown", async () => {
    const first = LOSSY;
    const second = LOSSLESS;
    const encode = vi.fn(async (_p: Picture, _c: Crop): Promise<Encoded> => ({ bytes: encode.mock.calls.length === 1 ? first : second, quality: 0.9 }));
    const { onSave } = await show({ encode });
    await pick(new File([new Uint8Array(10)], "me.png"));
    const save = () => [...root!.querySelectorAll("button")].find((b) => text(b) === "Use this image")!;
    expect(save().disabled).toBe(false);
    expect(root!.querySelector(".crop-result img")!.classList.contains("stale")).toBe(false);

    const slider = root!.querySelector<HTMLInputElement>("input[type=range]")!;
    slider.value = "2";
    await act(() => void slider.dispatchEvent(new Event("input", { bubbles: true })));
    // the crop moved, the new encoding is not there yet: the old image is shown dimmed and cannot be saved
    expect(save().disabled).toBe(true);
    expect(root!.querySelector(".crop-result img")!.classList.contains("stale")).toBe(true);
    await act(() => save().click());
    expect(onSave).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(save().disabled).toBe(false), { timeout: 2000 });
    expect(root!.querySelector(".crop-result img")!.classList.contains("stale")).toBe(false);
    await press("Use this image");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toBe(second);
  });

  it("releases a picture when it is replaced, and the last one when the editor goes away", async () => {
    const closed: string[] = [];
    let n = 0;
    const open = vi.fn(async () => {
      const id = `picture ${++n}`;
      return { width: 400, height: 300, close: () => closed.push(id) } as unknown as Picture;
    });
    await show({ open });
    await pick(new File([new Uint8Array(10)], "one.png"));
    expect(closed).toEqual([]);
    await pick(new File([new Uint8Array(10)], "two.png"));
    expect(closed).toEqual(["picture 1"]);
    await act(() => render(null, root!));
    expect(closed).toEqual(["picture 1", "picture 2"]);
  });

  it("stays open when the save fails, so the person can try again", async () => {
    const { onCancel } = await show({ onSave: vi.fn(async () => false) });
    await pick(new File([new Uint8Array(10)], "me.png"));
    await press("Use this image");
    expect(onCancel).not.toHaveBeenCalled();
    expect(root!.querySelector(".crop")).not.toBeNull();
  });

  it("re-encodes when the zoom changes, on a smaller square about the same centre", async () => {
    const { encode } = await show();
    await pick(new File([new Uint8Array(10)], "me.png"));
    const slider = root!.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(slider.value).toBe("1");
    slider.value = "2";
    await act(() => void slider.dispatchEvent(new Event("input", { bubbles: true })));
    await settle(200);
    expect(encode).toHaveBeenLastCalledWith(picture, { x: 125, y: 75, size: 150 });
  });

  it("moves the crop with the arrow keys, and not out of the picture", async () => {
    const { encode } = await show();
    await pick(new File([new Uint8Array(10)], "me.png"));
    const canvas = root!.querySelector(".crop-canvas")!;
    for (let i = 0; i < 40; i++) await act(() => void canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await settle(200);
    expect(encode).toHaveBeenLastCalledWith(picture, { x: 100, y: 0, size: 300 });
  });

  it("says so, and offers no save, when the image cannot be made into an avatar", async () => {
    await show({ encode: vi.fn(async () => Promise.reject(new AvatarError("too-large"))) });
    await pick(new File([new Uint8Array(10)], "me.png"));
    expect(text(root!.querySelector(".problem"))).toBe("This image is too detailed to fit in 8 KB. Try a simpler picture.");
    const save = [...root!.querySelectorAll("button")].find((b) => text(b) === "Use this image")!;
    expect(save.disabled).toBe(true);
  });

  it("says so when the file is not an image the browser can open", async () => {
    const { encode } = await show({ open: vi.fn(async () => Promise.reject(new AvatarError("cannot-read"))) });
    await pick(new File([new Uint8Array(10)], "notes.txt"));
    expect(text(root!.querySelector(".problem"))).toBe("This file cannot be opened as an image. Choose a PNG, JPEG or WebP.");
    expect(encode).not.toHaveBeenCalled();
    expect(buttons(root!)).toEqual(["Choose an image", "Cancel"]);
  });

  it("does not even open a file over 30 MB", async () => {
    const { open } = await show();
    const huge = new File([new Uint8Array(1)], "huge.png");
    Object.defineProperty(huge, "size", { value: 31 * 1024 * 1024 });
    await pick(huge);
    expect(open).not.toHaveBeenCalled();
    expect(text(root!.querySelector(".problem"))).toBe("That file is too large. Choose an image under 30 MB.");
  });

  it("refuses an SVG image before opening it, by its type or by its name", async () => {
    const { open } = await show();
    await pick(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    expect(open).not.toHaveBeenCalled();
    expect(text(root!.querySelector(".problem"))).toBe("SVG images cannot be used. Choose a PNG, JPEG or WebP.");
    await pick(new File(["<svg/>"], "LOGO.SVG"));
    expect(open).not.toHaveBeenCalled();
  });

  it("is cancelled with Escape, but not while a save is in flight", async () => {
    const { onCancel } = await show();
    const editor = root!.querySelector(".avatar-editor")!;
    await act(() => void editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
    render(null, root!);
    root!.remove();
    const busy = await show({ pending: true });
    await act(() => void root!.querySelector(".avatar-editor")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(busy.onCancel).not.toHaveBeenCalled();
  });

  it("zooms in with the wheel on the crop", async () => {
    const { encode } = await show();
    await pick(new File([new Uint8Array(10)], "me.png"));
    expect(encode).toHaveBeenLastCalledWith(picture, { x: 50, y: 0, size: 300 });
    const canvas = root!.querySelector(".crop-canvas")!;
    await act(() => void canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })));
    await settle(200);
    const crop = encode.mock.calls.at(-1)![1];
    expect(crop.size).toBeLessThan(300);
  });

  it("refuses to send what the chain would refuse, whatever the encoder returned", async () => {
    // a browser that cannot make WebP and hands back a PNG: the editor already catches it in encodeAvatar,
    // and the last check before sending catches anything that got through
    const { onSave } = await show({ encode: vi.fn(async () => ({ bytes: PNG, quality: 0.9 })) });
    await pick(new File([new Uint8Array(10)], "me.png"));
    await press("Use this image");
    expect(onSave).not.toHaveBeenCalled();
    expect(text(root!.querySelector(".problem"))).toBe("This browser could not make a WebP image.");
  });

  it("cannot be used while another save is in flight", async () => {
    await show({ pending: true });
    expect([...root!.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("keeps clear of the house rules: no fee, no forbidden marks", async () => {
    await show();
    await pick(new File([new Uint8Array(10)], "me.png"));
    expect(root!.textContent).not.toMatch(/[·—]|\bfees?\b|\bIDT\b/);
  });
});
