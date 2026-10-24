// The connection to the chain: one shared @polkadot/api instance, reconnecting by itself.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { findUnknownExtensions } from "@polkadot/types/extrinsic/signedExtensions";

/** The public RPC endpoint of the identitee chain. */
export const DEFAULT_RPC = "wss://rpc.identit.ee";

/** The endpoint this build talks to: `VITE_RPC` at build time, else the public one. */
export function rpcEndpoint(): string {
  const configured: unknown = import.meta.env.VITE_RPC;
  return typeof configured === "string" && configured !== "" ? configured : DEFAULT_RPC;
}

/** Signed extensions of the chain that polkadot.js does not know by name and that carry no data.
 * For an unknown extension it encodes nothing, which is only right for one with no data:
 * `AuthorizeCall` (frame_system) has none. Any other unknown extension would produce invalid
 * transactions without a word, so connecting refuses it until someone has looked at it. */
export const UNKNOWN_EXTENSIONS_ALLOWED: readonly string[] = ["AuthorizeCall"];

/** Longest wait for the first connection. */
const CONNECT_TIMEOUT_MS = 20_000;
/** A first connection gives up after this many failed attempts in a row (a node that is down
 * refuses at once: no need to wait for the timeout). */
const FIRST_ATTEMPTS = 3;
/** Delay before the provider retries a dropped connection. */
const RECONNECT_MS = 2_500;

export type LinkState = "connecting" | "connected" | "disconnected";

interface Link {
  url: string;
  provider: WsProvider;
  api: Promise<ApiPromise>;
}

let link: Link | null = null;
let state: LinkState = "disconnected";
const listeners = new Set<(state: LinkState) => void>();

function setState(next: LinkState): void {
  if (state === next) return;
  state = next;
  for (const listener of [...listeners]) listener(next);
}

/** The state of the link now: `connecting` until the first connection, then `connected` or
 * `disconnected` (the provider retries on its own while it is). */
export function linkState(): LinkState {
  return state;
}

/** Call `listener` on each change of the link state; returns the function that stops it. */
export function onLinkState(listener: (state: LinkState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Throw unless every signed extension unknown to polkadot.js is in the allow-list. */
export function assertKnownExtensions(api: ApiPromise): void {
  const unexpected = findUnknownExtensions(api.registry.signedExtensions).filter(
    (name) => !UNKNOWN_EXTENSIONS_ALLOWED.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`The chain uses signed extensions this app cannot sign: ${unexpected.join(", ")}.`);
  }
}

/** Throw unless `api` is an identitee node that serves `IdentiteeApi`. */
export function assertIdentitee(api: ApiPromise): void {
  if (api.runtimeVersion.specName.toString() !== "identitee") {
    throw new Error("This endpoint is not an identitee node.");
  }
  if (!api.call.identiteeApi) throw new Error("This node does not serve the identitee runtime API.");
}

async function open(url: string, provider: WsProvider): Promise<ApiPromise> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopCounting = (): void => undefined;
  const timeout = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("Cannot reach the identit.ee network."));
    timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    stopCounting = provider.on("disconnected", () => {
      if (++failures >= FIRST_ATTEMPTS) fail();
    });
  });
  // `noInitWarn`: the RPC methods polkadot.js lists as undecorated are the new chainHead ones,
  // which it does not use.
  const created = ApiPromise.create({ provider, noInitWarn: true });
  try {
    const api = await Promise.race([created, timeout]);
    try {
      assertIdentitee(api);
      assertKnownExtensions(api);
    } catch (e) {
      await api.disconnect();
      throw e;
    }
    return api;
  } catch (e) {
    // a late success must not leave a connection open behind a failed connect()
    created.then((api) => api.disconnect()).catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
    stopCounting();
  }
}

/**
 * The shared API. The first call opens the connection and every later call returns the same
 * instance, whether or not it names the endpoint; a dropped connection is retried by the
 * provider, and `onLinkState` reports it. A failed first connection is forgotten, so the next
 * call tries again. Naming another endpoint closes the current connection and opens that one.
 */
export function connect(endpoint?: string): Promise<ApiPromise> {
  if (link && (endpoint === undefined || link.url === endpoint)) return link.api;
  const url = endpoint ?? rpcEndpoint();
  if (link) void disconnect();

  const provider = new WsProvider(url, RECONNECT_MS);
  setState("connecting");
  provider.on("connected", () => {
    if (link?.provider === provider) setState("connected");
  });
  provider.on("disconnected", () => {
    if (link?.provider === provider) setState("disconnected");
  });

  const api = open(url, provider);
  const mine: Link = { url, provider, api };
  link = mine;
  api.catch(async () => {
    if (link !== mine) return;
    link = null;
    setState("disconnected");
    await provider.disconnect().catch(() => undefined);
  });
  return api;
}

/** Close the shared connection, if any. */
export async function disconnect(): Promise<void> {
  const closing = link;
  link = null;
  setState("disconnected");
  if (!closing) return;
  // Stop the socket and its retries now; once the API exists, let it drop its own subscriptions.
  void closing.api.then((api) => api.disconnect(), () => undefined);
  await closing.provider.disconnect().catch(() => undefined);
}
