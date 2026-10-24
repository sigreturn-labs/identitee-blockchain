// Moving an identity over from a People Chain (Polkadot or Kusama), and following the request.
//
// The chain holds a request while it waits (`migrationRequests`) and, once fulfilled, the history
// of the import (`importedHistory`). A refusal leaves nothing behind: `reject_migration` takes the
// request away and only emits an event, exactly as a withdrawal does. So this browser remembers the
// sources it has seen requested, by account, in localStorage (a source name, nothing secret): a
// request that was seen and has vanished with no import has `ended`, refused by the service or
// withdrawn from another browser, and the page cannot tell which. A withdrawal from this browser
// clears the memory first, an import clears it too. Another browser, which never saw the request,
// shows nothing; the README says so.

import { publicKeyHex } from "./address.ts";
import { DecodeError } from "./identity.ts";
import { type Markers, SOURCES, type Source, storedMarkers } from "./markers.ts";
import { type Reader, snapshot } from "./reader.ts";

export type Migration =
  | { state: "none" }
  | { state: "pending"; source: Source; since: number }
  | { state: "imported"; source: Source; block: number }
  /** Seen waiting, then gone with nothing imported: refused or withdrawn elsewhere. */
  | { state: "ended"; source: Source };

type Json = any;

const asSource = (raw: Json): Source => ((SOURCES as readonly string[]).includes(raw) ? (raw as Source) : fail());
const fail = (): never => {
  throw new DecodeError("migration source");
};

/**
 * The migration state from the two storage rows (JSON as polkadot.js gives it) and the source this
 * browser remembers: `request` is `(source, block)` or null, `history` is `(source, block, hash,
 * judgements)` or null.
 */
export function decodeMigration(request: Json, history: Json, remembered: Source | null): Migration {
  if (history !== null && history !== undefined) {
    if (!Array.isArray(history) || !Number.isSafeInteger(history[1])) throw new DecodeError("migration history");
    return { state: "imported", source: asSource(history[0]), block: history[1] };
  }
  if (request !== null && request !== undefined) {
    if (!Array.isArray(request) || !Number.isSafeInteger(request[1])) throw new DecodeError("migration request");
    return { state: "pending", source: asSource(request[0]), since: request[1] };
  }
  return remembered !== null ? { state: "ended", source: remembered } : { state: "none" };
}

// --- Reading -----------------------------------------------------------------------------------

/** The two storage rows of `address`, as JSON. */
export type MigrationRows = { request: Json; history: Json };

/** `readMigration` with the rows and the memory given: the state, and the memory brought in line
 * with it (a pending request is remembered, an import is forgotten). */
export async function readMigrationWith(
  address: string,
  rows: (address: string) => Promise<MigrationRows>,
  markers: Markers,
): Promise<Migration> {
  const { request, history } = await rows(address);
  const migration = decodeMigration(request, history, markers.get(address));
  if (migration.state === "pending" && markers.get(address) !== migration.source) markers.set(address, migration.source);
  if (migration.state === "imported") markers.clear(address);
  return migration;
}

/** Both rows at the same block: `at`, or the latest. */
async function chainRows(address: string, at?: Reader): Promise<MigrationRows> {
  const api = at ?? (await snapshot());
  const identitee = (api.query as Json).identitee;
  const [request, history] = await Promise.all([
    identitee.migrationRequests(publicKeyHex(address)),
    identitee.importedHistory(publicKeyHex(address)),
  ]);
  return { request: request.toJSON(), history: history.toJSON() };
}

/** Where the migration of `address` stands. `markers` is what this browser remembers; `at` reads at
 * that block (`snapshot`), else at the best block now. */
export function readMigration(address: string, markers: Markers = storedMarkers, at?: Reader): Promise<Migration> {
  return readMigrationWith(address, (a) => chainRows(a, at), markers);
}
