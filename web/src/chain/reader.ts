// Where a read is made: the latest state of the shared connection, or the state at one block.
//
// A page that shows several things read together (the requests page, the authority's inbox) reads
// them all at one block hash (`snapshot`), so it never shows half of one moment and half of another:
// a request and the field it points at, a migration request and its history.

import type { ApiDecoration } from "@polkadot/api/types";
import { connect } from "./api.ts";

/** What the readers use: runtime calls, storage and constants. The shared `ApiPromise` (the latest
 * state) or `api.at(hash)` (the state at that block) both fit. */
export type Reader = Pick<ApiDecoration<"promise">, "call" | "query" | "consts">;

/** `at` if given, else the shared connection. */
export async function reader(at?: Reader): Promise<Reader> {
  return at ?? (await connect());
}

/** The state at the best block now: every read through it answers for that one block. */
export async function snapshot(): Promise<Reader> {
  const api = await connect();
  return api.at(await api.rpc.chain.getBlockHash());
}
