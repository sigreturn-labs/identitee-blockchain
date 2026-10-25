// A fake API for the page tests: answers by path, and records what the page asked.
import { vi } from "vitest";

export const waitFor = <T,>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 2_000, interval: 10 });

export type Answer = unknown | { status: number; body: unknown };
/** An answer that never comes. */
export const PENDING = Symbol("pending");
export const failing = (status: number, error: string) => ({ status, body: { error } });

/** Answers the API by path: `/api/blocks?limit=10` first, then `/api/blocks`. Anything else is a
 * 404, and PENDING never answers. Returns the requested paths. */
export function serve(routes: Record<string, Answer>): string[] {
  const asked: string[] = [];
  globalThis.fetch = vi.fn((input: string) => {
    const url = new URL(input);
    const path = `${url.pathname}${url.search}`;
    asked.push(path);
    const found = path in routes ? routes[path] : routes[url.pathname];
    if (found === PENDING) return new Promise<Response>(() => {});
    const { status, body } =
      found === undefined
        ? failing(404, "not_found")
        : typeof found === "object" && found !== null && "status" in found && "body" in found
          ? (found as { status: number; body: unknown })
          : { status: 200, body: found };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return asked;
}
