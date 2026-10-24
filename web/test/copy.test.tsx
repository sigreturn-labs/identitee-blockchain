// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "../src/ui/copy.tsx";

let root: HTMLElement | undefined;
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(writeText: (text: string) => Promise<void>): Promise<HTMLElement> {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<CopyButton text="5Grw" what="address" />, root!));
  return root;
}
const button = () => root!.querySelector("button")!;
const icon = () => button().querySelector("svg")?.getAttribute("data-icon");
const status = () => root!.querySelector('[role="status"]')!.textContent;
const press = () =>
  act(async () => {
    button().click();
    await Promise.resolve();
    await Promise.resolve();
  });

describe("CopyButton", () => {
  it("is an icon, named by its aria-label and its title, with no word in it", async () => {
    await mount(vi.fn(async () => undefined));
    expect(button().getAttribute("type")).toBe("button");
    expect(button().getAttribute("aria-label")).toBe("Copy address");
    expect(button().getAttribute("title")).toBe("Copy address");
    expect(button().textContent).toBe("");
    expect(icon()).toBe("copy");
    expect(button().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(status()).toBe("");
  });

  it("turns into a check once copied, says Copied, and comes back to the copy icon", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    await mount(writeText);
    await press();
    expect(writeText).toHaveBeenCalledWith("5Grw");
    expect(icon()).toBe("check");
    expect(status()).toBe("Copied");
    // the name stays the action's, not its outcome: the status says the outcome
    expect(button().getAttribute("aria-label")).toBe("Copy address");
    await act(() => void vi.advanceTimersByTime(1700));
    expect(icon()).toBe("copy");
    expect(status()).toBe("");
  });

  it("says Copy failed, and shows no check, when the browser refuses", async () => {
    await mount(vi.fn(async () => Promise.reject(new Error("denied"))));
    await press();
    expect(icon()).toBe("x");
    expect(status()).toBe("Copy failed");
  });
});
