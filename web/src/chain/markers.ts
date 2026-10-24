// What this browser remembers about a migration request, by account: the source it saw requested
// (a source name, nothing secret), kept in localStorage. It imports no chain library, so the wallet
// (which forgets an account's marker on Disconnect) and the migration reader can both use it.

import { toIdentitee } from "./address.ts";

export const SOURCES = ["Polkadot", "Kusama"] as const;
export type Source = (typeof SOURCES)[number];

export interface Markers {
  get(address: string): Source | null;
  set(address: string, source: Source): void;
  clear(address: string): void;
}

/** The localStorage key: one JSON object, account to source. */
export const MARKERS_KEY = "identitee.migration";

const key = (address: string): string => toIdentitee(address);

/** In memory: for tests, and the fallback of a blocked localStorage. */
export function memoryMarkers(): Markers {
  const known = new Map<string, Source>();
  return {
    get: (address) => known.get(key(address)) ?? null,
    set: (address, source) => void known.set(key(address), source),
    clear: (address) => void known.delete(key(address)),
  };
}

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MARKERS_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(MARKERS_KEY);
    else localStorage.setItem(MARKERS_KEY, JSON.stringify(all));
  } catch {
    // not remembered: a refusal will not be shown
  }
}

/** The markers kept in localStorage. A blocked or full storage means they are not kept. */
export const storedMarkers: Markers = {
  get(address) {
    const source = readAll()[key(address)];
    return (SOURCES as readonly string[]).includes(source ?? "") ? (source as Source) : null;
  },
  set(address, source) {
    writeAll({ ...readAll(), [key(address)]: source });
  },
  clear(address) {
    const { [key(address)]: _gone, ...rest } = readAll();
    writeAll(rest);
  },
};
