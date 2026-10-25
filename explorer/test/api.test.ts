import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, get, live } from "../src/api.ts";
import { FakeEventSource } from "./support/no-network.ts";

const reply = (status: number, body: unknown) =>
  vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(body), { status })));

afterEach(() => vi.useRealTimers());

describe("get", () => {
  it("reads JSON from the API", async () => {
    const fetch = reply(200, { best: 3, finalized: 1 });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    expect(await get<{ best: number }>("/api/status")).toEqual({ best: 3, finalized: 1 });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://explorer-api.identit.ee/api/status");
  });

  it("throws the error code of the API", async () => {
    globalThis.fetch = reply(503, { error: "node_down" }) as unknown as typeof fetch;
    const error = await get("/api/network").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "node_down" });
  });
});

describe("live", () => {
  it("passes each head on and reconnects after a failure", () => {
    vi.useFakeTimers();
    const heads: unknown[] = [];
    const stop = live((head) => heads.push(head));
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe("https://explorer-api.identit.ee/api/live");
    first.emit("head", '{"best":5,"finalized":3,"indexed":5}');
    expect(heads).toEqual([{ best: 5, finalized: 3, indexed: 5 }]);

    first.fail();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    stop();
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    FakeEventSource.instances[1]!.fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("ignores a head it cannot read", () => {
    const heads: unknown[] = [];
    const stop = live((head) => heads.push(head));
    FakeEventSource.instances[0]!.emit("head", "not json");
    expect(heads).toEqual([]);
    stop();
  });
});
