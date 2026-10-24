import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A WsProvider and an ApiPromise that only record what is asked of them.
const mocks = vi.hoisted(() => ({
  providers: [] as { url: string; handlers: Record<string, () => void>; disconnect: ReturnType<typeof vi.fn> }[],
  create: vi.fn(),
}));

vi.mock("@polkadot/api", () => ({
  WsProvider: class {
    // `handlers[event]()` fires every listener still subscribed to `event`
    handlers: Record<string, () => void> = {};
    listeners: Record<string, Set<() => void>> = {};
    disconnect = vi.fn(async () => undefined);
    constructor(public url: string) {
      mocks.providers.push(this);
    }
    on(event: string, handler: () => void) {
      const set = (this.listeners[event] ??= new Set());
      set.add(handler);
      this.handlers[event] = () => [...set].forEach((h) => h());
      return () => void set.delete(handler);
    }
  },
  ApiPromise: { create: mocks.create },
}));

import { registry } from "./support/registry.ts";
import { connect, disconnect, linkState, onLinkState } from "../src/chain/api.ts";

const fakeApi = (specName = "identitee") => ({
  runtimeVersion: { specName: { toString: () => specName } },
  call: { identiteeApi: {} },
  registry,
  disconnect: vi.fn(async () => undefined),
});

beforeEach(() => {
  mocks.providers.length = 0;
  mocks.create.mockReset();
});

afterEach(async () => {
  await disconnect();
  vi.useRealTimers();
});

describe("connect", () => {
  it("opens one connection and shares it, with or without naming the endpoint", async () => {
    const api = fakeApi();
    mocks.create.mockResolvedValue(api);
    const first = await connect("ws://127.0.0.1:9944");
    expect(await connect("ws://127.0.0.1:9944")).toBe(first);
    expect(await connect()).toBe(first);
    expect(mocks.providers).toHaveLength(1);
    expect(mocks.providers[0]!.url).toBe("ws://127.0.0.1:9944");
  });

  it("follows the provider: connecting, connected, disconnected, connected again", async () => {
    mocks.create.mockResolvedValue(fakeApi());
    const seen: string[] = [];
    const stop = onLinkState((s) => seen.push(s));
    const pending = connect("ws://a");
    expect(linkState()).toBe("connecting");
    await pending;
    const { handlers } = mocks.providers[0]!;
    handlers.connected!();
    handlers.disconnected!();
    handlers.connected!();
    stop();
    expect(seen).toEqual(["connecting", "connected", "disconnected", "connected"]);
  });

  it("closes the old connection when another endpoint is asked for", async () => {
    const old = fakeApi();
    mocks.create.mockResolvedValueOnce(old).mockResolvedValueOnce(fakeApi());
    await connect("ws://a");
    await connect("ws://b");
    expect(mocks.providers.map((p) => p.url)).toEqual(["ws://a", "ws://b"]);
    expect(mocks.providers[0]!.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(old.disconnect).toHaveBeenCalled());
    expect(mocks.providers[1]!.disconnect).not.toHaveBeenCalled();
  });

  it("forgets a failed first connection and tries again on the next call", async () => {
    mocks.create.mockRejectedValueOnce(new Error("refused")).mockResolvedValueOnce(fakeApi());
    await expect(connect("ws://a")).rejects.toThrow("refused");
    expect(linkState()).toBe("disconnected");
    expect(mocks.providers[0]!.disconnect).toHaveBeenCalled();
    await expect(connect("ws://a")).resolves.toBeTruthy();
    expect(mocks.providers).toHaveLength(2);
  });

  it("gives up after 20 seconds and stops the provider's retries", async () => {
    vi.useFakeTimers();
    mocks.create.mockReturnValue(new Promise(() => undefined));
    const pending = connect("ws://a");
    const outcome = expect(pending).rejects.toThrow("Cannot reach the identit.ee network.");
    await vi.advanceTimersByTimeAsync(20_001);
    await outcome;
    expect(mocks.providers[0]!.disconnect).toHaveBeenCalled();
  });

  it("gives up on a first connection after 3 failed attempts, without waiting for the timeout", async () => {
    mocks.create.mockReturnValue(new Promise(() => undefined));
    const pending = connect("ws://a");
    let settled = false;
    pending.catch(() => undefined).finally(() => (settled = true));
    const { handlers } = mocks.providers[0]!;
    handlers.disconnected!();
    handlers.disconnected!();
    await Promise.resolve();
    expect(settled).toBe(false);
    handlers.disconnected!();
    await expect(pending).rejects.toThrow("Cannot reach the identit.ee network.");
    expect(mocks.providers[0]!.disconnect).toHaveBeenCalled();
  });

  it("refuses a node of another chain and closes it", async () => {
    const api = fakeApi("polkadot");
    mocks.create.mockResolvedValue(api);
    await expect(connect("ws://a")).rejects.toThrow(/not an identitee node/);
    expect(api.disconnect).toHaveBeenCalled();
    expect(linkState()).toBe("disconnected");
  });
});
