// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ROUTE_PATHS } from "../src/app.tsx";
import { SECTIONS } from "../src/ui/layout.tsx";
import { FakeEventSource } from "./support/no-network.ts";

const waitFor = <T,>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 2_000, interval: 10 });

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

/** Answers /api/status with `body`, and anything else with a 404. */
function status(body: unknown) {
  globalThis.fetch = ((url: string) =>
    Promise.resolve(url.endsWith("/api/status") ? new Response(JSON.stringify(body)) : new Response('{"error":"not_found"}', { status: 404 }))) as typeof fetch;
}

function open(path: string) {
  history.replaceState(null, "", path);
  render(<App />, root);
}

describe("Layout", () => {
  it("shows the mark, the network, the sections and the footer", async () => {
    open("/blocks");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Blocks"));
    expect(root.querySelector(".mark")?.textContent).toBe("identit.eeExplorer");
    expect(root.querySelector(".mark")?.getAttribute("aria-label")).toBe("identit.ee Explorer");
    expect(root.querySelector(".x-net")?.textContent).toBe("Testnet");
    expect([...root.querySelectorAll(".x-nav a")].map((a) => a.textContent)).toEqual(SECTIONS.map(([label]) => label));
    expect(root.querySelector('.x-nav a[aria-current="page"]')?.textContent).toBe("Blocks");
    expect([...root.querySelectorAll(".x-foot a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://identit.ee",
      "https://github.com/sigreturn-labs/identitee-blockchain",
    ]);
    expect(root.textContent).not.toMatch(/[·—]/);
  });

  it("follows the finalized height on the live stream", async () => {
    status({ best: 1236, finalized: 1234, indexed: 1236, node: "up", specVersion: 1, genesis: null });
    open("/");
    const link = await waitFor(() => {
      const a = root.querySelector<HTMLAnchorElement>(".x-height a");
      expect(a?.textContent).toBe("1,234");
      return a!;
    });
    expect(link.getAttribute("href")).toBe("/block/1234");
    FakeEventSource.instances[0]!.emit("head", '{"best":1240,"finalized":1237,"indexed":1240}');
    await waitFor(() => expect(root.querySelector(".x-height a")?.textContent).toBe("1,237"));
  });

  it("shows no height while the node is down or nothing is finalized", async () => {
    status({ best: 0, finalized: 0, indexed: 12, node: "down", specVersion: 1, genesis: null });
    open("/");
    await waitFor(() => expect(root.querySelector("h1")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".x-height a")).toBeNull();
    FakeEventSource.instances[0]!.emit("head", '{"best":0,"finalized":0,"indexed":12}');
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".x-height a")).toBeNull();
    FakeEventSource.instances[0]!.emit("head", '{"best":14,"finalized":13,"indexed":14}');
    await waitFor(() => expect(root.querySelector(".x-height a")?.textContent).toBe("13"));
  });

  it("shows no height while the API is away", async () => {
    open("/");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Overview"));
    expect(root.querySelector(".x-height")?.textContent).toBe("");
  });

  it("registers every page, with its id", async () => {
    expect(ROUTE_PATHS).toEqual([
      "/", "/blocks", "/block/:id", "/extrinsics", "/extrinsic/:id", "/events", "/account/:address", "/authorities",
      "/authority/:id", "/attestations", "/migrations", "/usernames", "/runtime", "/network", "/search",
    ]);
    open("/block/12");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Block 12"));
    expect(root.querySelector('.x-nav a[aria-current="page"]')?.textContent).toBe("Blocks");
    render(null, root);
    open("/authority/3");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Authority 3"));
    expect(root.querySelector('.x-nav a[aria-current="page"]')?.textContent).toBe("Authorities");
  });

  it("searches the term of a /search link", async () => {
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify(url.includes("/api/search") ? { kind: "extrinsic", target: "12-1", alternatives: [] } : { error: "node_down" }), {
          status: url.includes("/api/search") ? 200 : 503,
        }),
      ),
    ) as unknown as typeof fetch;
    open("/search?q=12-1");
    await waitFor(() => expect(location.pathname).toBe("/extrinsic/12-1"));
  });
});
