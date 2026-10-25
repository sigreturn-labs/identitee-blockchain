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

  it("refuses a 200 that is not JSON", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 }))) as unknown as typeof fetch;
    const error = await get("/api/status").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200, code: "bad_response" });
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

  it("shares one stream between listeners, and closes it with the last one", () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = live((head) => a.push(head));
    FakeEventSource.instances[0]!.emit("head", '{"best":5,"finalized":3,"indexed":5}');
    const stopB = live((head) => b.push(head));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(b).toEqual([{ best: 5, finalized: 3, indexed: 5 }]);
    FakeEventSource.instances[0]!.emit("head", '{"best":6,"finalized":4,"indexed":6}');
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    stopA();
    stopA();
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    stopB();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    const stopC = live(() => {});
    expect(FakeEventSource.instances).toHaveLength(2);
    stopC();
  });

  it("jitters the reconnection delay", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const stop = live(() => {});
    FakeEventSource.instances[0]!.fail();
    vi.advanceTimersByTime(499);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
    vi.restoreAllMocks();
  });

  it("passes a head to every listener even when one throws", () => {
    const heads: unknown[] = [];
    const stopA = live(() => {
      throw new Error("broken listener");
    });
    const stopB = live((head) => heads.push(head));
    FakeEventSource.instances[0]!.emit("head", '{"best":5,"finalized":3,"indexed":5}');
    expect(heads).toEqual([{ best: 5, finalized: 3, indexed: 5 }]);
    stopA();
    stopB();
  });
});
