// @vitest-environment happy-dom
import { type ComponentType, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyPage } from "../src/ui/lazy-page.tsx";

let root: HTMLElement | undefined;
async function show(vnode: preact.VNode): Promise<HTMLElement> {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(vnode, root!));
  return root;
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";

afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

const Loaded: ComponentType<{ who?: string }> = ({ who = "world" }) => <p class="loaded">hello {who}</p>;
const Waiting = () => <p class="waiting">waiting</p>;

describe("lazyPage", () => {
  it("stands in with its fallback while the code downloads, then shows the page with its props", async () => {
    let arrive: () => void = () => undefined;
    const Page = lazyPage<{ who?: string }>(() => new Promise((resolve) => (arrive = () => resolve(Loaded))), Waiting);
    const el = await show(<Page who="Ada" />);
    expect(text(el.querySelector(".waiting"))).toBe("waiting");
    expect(el.querySelector(".loaded")).toBeNull();

    arrive();
    await settle();
    expect(text(el.querySelector(".loaded"))).toBe("hello Ada");
    expect(el.querySelector(".waiting")).toBeNull();
  });

  it("downloads the code once, however many times the page is shown", async () => {
    const load = vi.fn(async () => Loaded);
    const Page = lazyPage<{ who?: string }>(load, Waiting);
    await show(<Page />);
    await settle();
    render(null, root!);
    await act(() => render(<Page />, root!));
    // already there: no fallback, not even for a frame
    expect(root!.querySelector(".waiting")).toBeNull();
    expect(root!.querySelector(".loaded")).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows a card with a Reload button when the code cannot be downloaded, never an empty page", async () => {
    const Page = lazyPage<{ who?: string }>(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")), Waiting);
    const el = await show(<Page />);
    await settle();
    expect(el.querySelector(".waiting")).toBeNull();
    const card = el.querySelector(".card")!;
    expect(card.getAttribute("aria-label")).toBe("Not available");
    expect(text(card.querySelector(".note"))).toBe("This page could not be loaded. The site may have been updated.");
    const button = card.querySelector("button")!;
    expect(text(button)).toBe("Reload");

    const reload = vi.fn();
    vi.stubGlobal("location", { ...location, reload });
    await act(() => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("tries again on the next visit after a failed download", async () => {
    const load = vi.fn<() => Promise<ComponentType<{ who?: string }>>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Loaded);
    const Page = lazyPage<{ who?: string }>(load, Waiting);
    const el = await show(<Page />);
    await settle();
    expect(el.querySelector(".card")?.getAttribute("aria-label")).toBe("Not available");

    render(null, el);
    await act(() => render(<Page />, el));
    await settle();
    expect(el.querySelector(".loaded")).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not leave an unhandled rejection behind", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const Page = lazyPage<{ who?: string }>(() => Promise.reject(new Error("gone")), Waiting);
    await show(<Page />);
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
