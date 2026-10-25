// The explorer API (tools/src/explorer/api.ts): typed reads and the live head stream. The front
// never talks to the node itself.

export const API = import.meta.env.VITE_API as string;
export const PROFILE_BASE = import.meta.env.VITE_PROFILE_BASE as string;

/** An answer other than 200: `code` is the API's `error` (`not_found`, `node_down`, `bad_query`…),
 * or `network` when there was no answer at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(0, "network");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "unknown";
    throw new ApiError(response.status, code);
  }
  return body as T;
}

export type Head = { best: number; finalized: number; indexed: number | null };

/** Calls `onHead` with every head the API pushes, reconnecting after a failure (1 s, doubling up to
 * 30 s, back to 1 s once a head arrives). Returns the function that stops it. */
export function live(onHead: (head: Head) => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wait = 1_000;
  let stopped = false;
  const open = () => {
    source = new EventSource(`${API}/api/live`);
    source.addEventListener("head", (e) => {
      try {
        onHead(JSON.parse((e as MessageEvent<string>).data) as Head);
        wait = 1_000;
      } catch {
        // a line that is not a head is skipped
      }
    });
    source.onerror = () => {
      source?.close();
      if (stopped) return;
      timer = setTimeout(open, wait);
      wait = Math.min(wait * 2, 30_000);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}

// Response shapes, as served by the API.

export type Ts = { timestamp: number | null };
export type Page<T, C = string> = { items: T[]; next: C | null };

export type Status = { best: number; finalized: number; indexed: number | null; node: "up" | "down"; specVersion: number | null; genesis: string | null };
export type Stats = {
  blocks: number;
  extrinsics: number;
  events: number;
  accounts: number;
  transfers: number;
  attestations: number;
  migrations: number;
  usernames: number;
  authorities: number | null;
};

export type BlockRow = {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  timestamp: number | null;
  specVersion: number;
  author: string | null;
  authoritySetId: number;
  justificationSigners: string[] | null;
  extrinsicCount: number;
  eventCount: number;
};

export type ModuleError = { pallet: string; name: string; docs: string };
export type ExtrinsicSummary = {
  id: string;
  block: number;
  index: number;
  hash: string;
  pallet: string;
  method: string;
  signer: string | null;
  nonce: number | null;
  tip: string | null;
  fee: string | null;
  success: boolean;
  error: ModuleError | null;
  inner: Array<{ pallet: string; method: string }>;
};
export type Call = { pallet: string; method: string; args: unknown };
export type EventRow = { id: string; block: number; index: number; extrinsicIndex: number | null; pallet: string; method: string; data: unknown; sentence: string | null };
export type ExtrinsicFull = Omit<ExtrinsicSummary, "inner"> & { args: unknown } & Ts & { events: Array<EventRow & Ts> };

export type BlockDetail = BlockRow & { extrinsics: Array<ExtrinsicSummary & Ts>; events: Array<EventRow & Ts> };
export type ExtrinsicMatches = { matches: Array<ExtrinsicSummary & Ts> };

export type Transfer = { from: string; to: string; amount: string; block: number; extrinsicId: string | null; eventId: string; sentence: string | null } & Ts;
export type Attestation = {
  who: string;
  authorityId: number;
  kind: "requested" | "attested" | "revoked" | "rejected" | "cancelled";
  target: { Field: string } | { Fact: string };
  data: Record<string, unknown> | null;
  block: number;
  eventId: string;
  sentence: string | null;
} & Ts;
export type Migration = { who: string; kind: "requested" | "cancelled" | "fulfilled" | "rejected"; data: unknown; block: number; eventId: string; sentence: string | null } & Ts;
export type Username = {
  name: string;
  who: string | null;
  kind: "claimed" | "released" | "reserved" | "unreserved" | "assigned" | "revoked";
  block: number;
  eventId: string;
  sentence: string | null;
} & Ts;

export type AgentRole = { authority: number; name: string | null; capabilities: number; capabilityNames: string[] };
export type Account = {
  address: string;
  publicKey: string;
  balance: { free: string; reserved: string; frozen: string } | null;
  nonce: number | null;
  identity: { display: string | null; username: string | null; trust: string | null } | null;
  roles: { sudo: boolean; validator: boolean; agent: AgentRole[] } | null;
  profileUrl: string;
  node: "up" | "down";
};
export type HistoryItem = ({ kind: "extrinsic"; block: number; item: ExtrinsicSummary } | { kind: "event"; block: number; item: EventRow }) & Ts;

export type Agent = { address: string; capabilities: number; capabilityNames: string[] };
export type Authority = { id: number; name: string; active: boolean; agents: Agent[] };
export type AuthorityDetail = Authority & { attestations: Page<Attestation> };

export type RuntimeItem = { name: string; docs: string };
export type Runtime = {
  current: { specName: string; specVersion: number } | null;
  versions: Array<{ specVersion: number; fromBlock: number; specName: string }>;
  pallets: Array<{ name: string; index: number; calls: RuntimeItem[]; events: RuntimeItem[]; errors: RuntimeItem[]; storage: RuntimeItem[]; constants: RuntimeItem[] }>;
};

export type Network = {
  validators: { aura: Array<{ key: string; label: string | null }>; grandpa: Array<{ key: string; weight: number; label: string | null }>; setId: number };
  health: { peers: number; isSyncing: boolean; shouldHavePeers: boolean };
  blockTime: { target: number; recent: number | null };
  grandpaSetId: number;
};

export type SearchKind = "block" | "extrinsic" | "account" | "username" | "none";
export type SearchMatch = { kind: Exclude<SearchKind, "none">; target: string; name?: string };
export type SearchResult = { kind: SearchKind; target: string; alternatives: SearchMatch[]; name?: string };
