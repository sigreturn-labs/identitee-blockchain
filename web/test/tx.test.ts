import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AGENT_CALLS, describeRejection, ERROR_MESSAGES, send } from "../src/chain/tx.ts";

const SIGNER = { address: "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk", signer: {} as never };

describe("ERROR_MESSAGES", () => {
  it("has a sentence for every error of the pallet", () => {
    const source = readFileSync(new URL("../../pallets/identitee/src/lib.rs", import.meta.url), "utf8");
    const body = source.split("pub enum Error<T> {")[1]!.split("\n\t}\n")[0]!;
    const names = [...body.matchAll(/^\t\t([A-Z][A-Za-z0-9]*),?\s*$/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((n) => !(n in ERROR_MESSAGES))).toEqual([]);
    expect(Object.keys(ERROR_MESSAGES).filter((n) => !names.includes(n))).toEqual([]);
  });

  it("keeps the house style: English sentences, no fees, no forbidden punctuation", () => {
    for (const [name, message] of Object.entries(ERROR_MESSAGES)) {
      expect(message, name).toMatch(/^[A-Z].*\.$/);
      expect(message, name).not.toMatch(/[·—]/);
      expect(message, name).not.toMatch(/\bfees?\b/i);
      expect(message.length, name).toBeLessThan(110);
    }
  });
});

describe("AGENT_CALLS", () => {
  // The calls the quota never counts are the ones only an authority agent (or Root) can make:
  // the `=> false` arm of `Call::counts_against_quota`. A call added there and missing from the
  // front would turn its "Payment" rejection into the daily limit message.
  const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  it("is the list of calls the runtime does not count against the quota", () => {
    const source = readFileSync(new URL("../../pallets/identitee/src/quota.rs", import.meta.url), "utf8");
    const arms = source.split("pub fn counts_against_quota")[1]!.split("=> true,");
    expect(arms.length).toBe(2);
    const names = (text: string): string[] => [...text.matchAll(/Call::([a-z][a-z0-9_]*) \{ \.\. \}/g)].map((m) => camel(m[1]!));
    const counted = names(arms[0]!);
    const free = names(arms[1]!.split("Call::__Ignore")[0]!);
    expect(counted.length).toBeGreaterThan(20);
    expect(free.length).toBeGreaterThan(10);
    expect([...AGENT_CALLS].sort()).toEqual([...free].sort());
    expect(counted.filter((name) => AGENT_CALLS.has(name))).toEqual([]);
  });
});

describe("describeRejection", () => {
  const identitee = { method: { section: "identitee", method: "setBio" } };
  // as captured from a dev node: a zero-balance account out of quota gets Payment
  const payment = Object.assign(new Error("1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low"), {
    code: 1010,
    data: "Inability to pay some fees (e.g. account balance too low)",
  });

  it("turns a Payment rejection of an identity call into the daily limit", () => {
    expect(describeRejection(payment, identitee)).toEqual({
      name: "DailyLimit",
      message: "Daily limit reached. Try again tomorrow.",
    });
  });

  it("does the same when only the text carries the code", () => {
    expect(describeRejection(new Error("1010: Invalid Transaction: Inability to pay some fees"), identitee).name).toBe("DailyLimit");
  });

  it("does not promise tomorrow for an authority call", () => {
    const grant = { method: { section: "identitee", method: "grantFact" } };
    expect(describeRejection(payment, grant)).toEqual({
      name: "NotAllowed",
      message: "This account is not allowed to make this call.",
    });
  });

  it("does not call the limit for a call outside the pallet", () => {
    const other = { method: { section: "balances", method: "transferKeepAlive" } };
    expect(describeRejection(payment, other).name).toBe("CannotPay");
  });

  it("explains a stale nonce, a duplicate and a lost connection", () => {
    const stale = Object.assign(new Error("1010: Invalid Transaction: Transaction is outdated"), { code: 1010, data: "Transaction is outdated" });
    expect(describeRejection(stale, identitee).name).toBe("Outdated");
    const twin = Object.assign(new Error("1013: Transaction Already Imported"), { code: 1013 });
    expect(describeRejection(twin, identitee).name).toBe("Duplicate");
    expect(describeRejection(new Error("WebSocket is not connected"), identitee).name).toBe("Offline");
  });

  it("reads a refusal in the wallet as a cancellation", () => {
    for (const text of ["Cancelled", "Rejected by user", "User rejected the request"]) {
      expect(describeRejection(new Error(text), identitee)).toEqual({ name: "Cancelled", message: "Signing was cancelled." });
    }
  });

  it("gives a generic sentence for an error nobody planned for, and keeps its first line as the name", () => {
    const generic = "The transaction could not be sent.";
    expect(describeRejection(new Error("1010: Invalid Transaction: Custom error: 7\nstack"), identitee)).toEqual({
      name: "1010: Invalid Transaction: Custom error: 7",
      message: generic,
    });
    expect(describeRejection("Unable to retrieve keypair 'x'", identitee).message).toBe(generic);
    expect(describeRejection({}, identitee)).toEqual({ name: "Rejected", message: generic });
    expect(describeRejection(new Error("x".repeat(500)), identitee).name).toHaveLength(120);
  });
});

type Callback = (result: unknown) => void;

/** A stand-in for a SubmittableExtrinsic that plays `script` through the status callback. */
function fakeCall(script: (cb: Callback) => void, section = "identitee") {
  const unsub = vi.fn();
  const registry = {
    findMetaError: ({ error }: { error: string }) => ({ section: "identitee", name: error }),
  };
  const call = {
    method: { section, method: "setBio" },
    registry,
    signAndSend: vi.fn((..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as Callback;
      queueMicrotask(() => script(cb));
      return Promise.resolve(unsub);
    }),
  };
  return { call: call as never, unsub, raw: call };
}

const event = (section: string, method: string, data: unknown = []) => ({
  event: { section, method, data: { toJSON: () => data } },
});
const inBlock = (events: unknown[], dispatchError?: unknown) => ({
  isError: false,
  status: { isInBlock: true, asInBlock: { toHex: () => "0xabc" } },
  events,
  dispatchError,
});
const moduleError = (error: string) => ({ isModule: true, asModule: { error }, toString: () => error });

describe("send", () => {
  it("resolves ok with the events once the transaction is in a block", async () => {
    const { call, unsub, raw } = fakeCall((cb) => {
      cb({ isError: false, status: { isInBlock: false }, events: [] });
      cb(inBlock([event("identitee", "BioSet", { who: "x" }), event("system", "ExtrinsicSuccess")]));
    });
    const result = await send(call, SIGNER);
    expect(result).toEqual({
      ok: true,
      blockHash: "0xabc",
      events: [
        { section: "identitee", method: "BioSet", data: { who: "x" } },
        { section: "system", method: "ExtrinsicSuccess", data: [] },
      ],
    });
    expect(unsub).toHaveBeenCalled();
    expect(raw.signAndSend.mock.calls[0]![0]).toBe(SIGNER.address);
    expect(raw.signAndSend.mock.calls[0]![1]).toEqual({ signer: SIGNER.signer });
  });

  it("passes an explicit nonce on, to a wallet account and to a keyring pair alike", async () => {
    const a = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicSuccess")])));
    await send(a.call, SIGNER, { nonce: 7 });
    expect(a.raw.signAndSend.mock.calls[0]![1]).toEqual({ signer: SIGNER.signer, nonce: 7 });
    const b = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicSuccess")])));
    await send(b.call, { address: SIGNER.address, sign: () => new Uint8Array() } as never, { nonce: 3 });
    expect(b.raw.signAndSend.mock.calls[0]![1]).toEqual({ nonce: 3 });
  });

  it("signs with a keyring pair when given one", async () => {
    const { call, raw } = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicSuccess")])));
    const pair = { address: SIGNER.address, sign: () => new Uint8Array() };
    expect((await send(call, pair as never)).ok).toBe(true);
    expect(raw.signAndSend.mock.calls[0]![0]).toBe(pair);
  });

  it("translates a module error into a short English sentence", async () => {
    const { call } = fakeCall((cb) =>
      cb(inBlock([event("system", "ExtrinsicFailed")], moduleError("NameTaken"))),
    );
    const result = await send(call, SIGNER);
    expect(result).toMatchObject({ ok: false, errorName: "NameTaken", error: "That name is already taken." });
  });

  it("falls back to the error name for an error it has no sentence for", async () => {
    const { call } = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicFailed")], moduleError("BrandNewError"))));
    expect(await send(call, SIGNER)).toMatchObject({ ok: false, errorName: "BrandNewError", error: "BrandNewError" });
  });

  it("names a bad origin and an undecodable failure", async () => {
    const bad = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicFailed")], { isModule: false, isBadOrigin: true, type: "BadOrigin", toString: () => "BadOrigin" })));
    expect(await send(bad.call, SIGNER)).toMatchObject({ ok: false, errorName: "BadOrigin" });
    const none = fakeCall((cb) => cb(inBlock([event("system", "ExtrinsicFailed")])));
    expect(await send(none.call, SIGNER)).toMatchObject({ ok: false, error: "The transaction failed." });
  });

  it("refuses a block that holds neither success nor failure", async () => {
    const { call } = fakeCall((cb) => cb(inBlock([])));
    expect(await send(call, SIGNER)).toMatchObject({ ok: false });
  });

  it("maps a pool rejection to the daily limit without throwing", async () => {
    const unsub = vi.fn();
    const call = {
      method: { section: "identitee", method: "setBio" },
      registry: {},
      signAndSend: () =>
        Promise.reject(Object.assign(new Error("1010: Invalid Transaction: Inability to pay some fees"), { code: 1010 })),
    };
    expect(await send(call as never, SIGNER)).toEqual({
      ok: false,
      events: [],
      errorName: "DailyLimit",
      error: "Daily limit reached. Try again tomorrow.",
    });
    expect(unsub).not.toHaveBeenCalled();
  });

  it("reports a transaction the network dropped", async () => {
    const { call } = fakeCall((cb) => cb({ isError: true, status: { type: "Dropped", isInBlock: false }, events: [] }));
    expect(await send(call, SIGNER)).toMatchObject({ ok: false, errorName: "Dropped" });
  });

  it("gives up if the block never comes", async () => {
    vi.useFakeTimers();
    try {
      const { call, unsub } = fakeCall((cb) => cb({ isError: false, status: { isInBlock: false }, events: [] }));
      const pending = send(call, SIGNER);
      await vi.advanceTimersByTimeAsync(91_000);
      expect(await pending).toMatchObject({ ok: false, errorName: "Timeout" });
      expect(unsub).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out while the wallet waits for the person to sign", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const unsub = vi.fn();
      const call = {
        method: { section: "identitee", method: "setBio" },
        registry: {},
        signAndSend: (...args: unknown[]) =>
          new Promise((resolve) => {
            release = () => {
              const cb = args[args.length - 1] as Callback;
              queueMicrotask(() => cb(inBlock([event("system", "ExtrinsicSuccess")])));
              resolve(unsub);
            };
          }),
      };
      const pending = send(call as never, SIGNER);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      release();
      expect(await pending).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
