// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "../src/ui/avatar.tsx";
import { paintPixels } from "../src/ui/pixels.ts";

vi.mock("../src/ui/pixels.ts", () => ({ paintPixels: vi.fn() }));

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

let root: HTMLElement | undefined;
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.mocked(paintPixels).mockReset();
});

async function mount(vnode: preact.VNode): Promise<HTMLElement> {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(vnode, root!));
  return root;
}

describe("Avatar", () => {
  it("paints once, and not again for a new array holding the same key", async () => {
    const el = await mount(<Avatar publicKey={key(1)} size={56} />);
    expect(paintPixels).toHaveBeenCalledTimes(1);
    await act(() => render(<Avatar publicKey={key(1)} size={56} />, el));
    await act(() => render(<Avatar publicKey={Uint8Array.from(key(1))} size={56} label="Avatar of someone" />, el));
    expect(paintPixels).toHaveBeenCalledTimes(1);
  });

  it("paints again for another key or another size", async () => {
    const el = await mount(<Avatar publicKey={key(1)} size={56} />);
    await act(() => render(<Avatar publicKey={key(2)} size={56} />, el));
    expect(paintPixels).toHaveBeenCalledTimes(2);
    await act(() => render(<Avatar publicKey={key(2)} size={72} />, el));
    expect(paintPixels).toHaveBeenCalledTimes(3);
    expect(el.querySelector("canvas")!.style.width).toBe("72px");
  });

  it("paints the key it was given, whichever render drew it", async () => {
    await mount(<Avatar publicKey={key(7)} size={56} />);
    expect(vi.mocked(paintPixels).mock.calls[0]![1]).toEqual(key(7));
  });

  it("does not throw on a key that cannot be painted: the canvas stays blank", async () => {
    vi.mocked(paintPixels).mockImplementation(() => {
      throw new Error("The avatar needs a 32-byte public key");
    });
    const el = await mount(<Avatar publicKey={new Uint8Array(5)} size={56} />);
    expect(el.querySelector("canvas")).not.toBeNull();
  });
});
