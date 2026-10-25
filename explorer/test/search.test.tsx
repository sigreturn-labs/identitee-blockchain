// @vitest-environment happy-dom
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../src/api.ts";
import { Search } from "../src/ui/search.tsx";

const ALICE = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const waitFor = <T,>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 2_000, interval: 10 });

let root: HTMLElement;
beforeEach(() => {
  history.replaceState(null, "", "/");
  root = document.createElement("div");
  document.body.append(root);
  render(
    <LocationProvider>
      <Search />
    </LocationProvider>,
    root,
  );
});
afterEach(() => {
  render(null, root);
  root.remove();
});

function answer(status: number, body: unknown) {
  const fetch = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(body), { status })));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

function submit(text: string) {
  const input = root.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("Search", () => {
  it("goes to the block that matches", async () => {
    const fetch = answer(200, { kind: "block", target: "12", alternatives: [] } satisfies SearchResult);
    submit(" 12 ");
    await waitFor(() => expect(location.pathname).toBe("/block/12"));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://explorer-api.identit.ee/api/search?q=12");
  });

  it("goes to the owner of a username", async () => {
    answer(200, { kind: "username", target: ALICE, name: "alice", alternatives: [] } satisfies SearchResult);
    submit("@alice");
    await waitFor(() => expect(location.pathname).toBe(`/account/${ALICE}`));
  });

  it("says when nothing matches", async () => {
    answer(200, { kind: "none", target: "", alternatives: [] } satisfies SearchResult);
    submit("zzz");
    await waitFor(() => expect(root.textContent).toContain('Nothing found for "zzz".'));
    expect(location.pathname).toBe("/");
  });

  it("offers the other matches", async () => {
    answer(200, {
      kind: "block",
      target: "123",
      alternatives: [{ kind: "username", target: ALICE, name: "123" }],
    } satisfies SearchResult);
    submit("123");
    await waitFor(() => expect(location.pathname).toBe("/block/123"));
    const link = await waitFor(() => {
      const found = [...root.querySelectorAll("a")].find((a) => a.textContent === "123");
      expect(found).toBeDefined();
      return found!;
    });
    expect(link.closest("p")!.textContent).toBe("Did you mean the username 123?");
    expect(link.getAttribute("href")).toBe(`/account/${ALICE}`);
  });

  it("explains a term the API refuses, and a search that cannot be made", async () => {
    answer(400, { error: "bad_query" });
    submit("x".repeat(200));
    await waitFor(() => expect(root.textContent).toContain("Type a block number, hash, extrinsic id, address or username."));

    globalThis.fetch = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
    submit("12");
    await waitFor(() => expect(root.textContent).toContain("Search is unavailable. Try again."));
  });

  it("does not ask the API about an empty term", async () => {
    const fetch = answer(200, {});
    submit("   ");
    await waitFor(() => expect(root.textContent).toContain("Type a block"));
    expect(fetch).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Type a block number, hash, extrinsic id, address or username.");
  });
});
