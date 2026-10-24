// Migration: bring over the identity this account registered on the Polkadot or Kusama People
// Chain. The person asks; a migration service reads that identity and either creates it here or
// refuses. Where it stands comes from the chain (a request waiting, or the history of an import);
// a refusal leaves nothing on the chain, no more than a withdrawal does, so a request that ended
// is the one state this browser remembers (chain/migration.ts).

import { cancelMigrationCall, requestMigrationCall } from "../chain/calls.ts";
import { SOURCES, storedMarkers } from "../chain/markers.ts";
import type { Migration } from "../chain/migration.ts";
import type { Overview } from "../chain/overview.ts";
import { type Acting, StatusLine } from "./requests-acting.tsx";

function Intro() {
  return <p class="hint">Import the identity this account registered on the Polkadot or Kusama People Chain. A migration service reads it and creates your identity here.</p>;
}

function Body({ migration, hasIdentity, acting, address, reload }: { migration: Migration; hasIdentity: boolean; acting: Acting; address: string; reload(): Promise<boolean> }) {
  if (migration.state === "imported") {
    return (
      <p class="member">
        Imported from {migration.source} at block {migration.block}.
      </p>
    );
  }
  if (migration.state === "pending") {
    return (
      <>
        {hasIdentity ? (
          <p class="problem">
            This account has an identity here now, so the migration service cannot import the {migration.source} one over it. Cancel this request.
          </p>
        ) : (
          <p class="member">Waiting for the migration service to read your {migration.source} identity.</p>
        )}
        <div class="actions">
          <button
            class="button"
            type="button"
            disabled={acting.pending}
            onClick={() => void acting.run("migration", cancelMigrationCall, "Migration request cancelled.", () => storedMarkers.clear(address))}
          >
            Cancel request
          </button>
        </div>
      </>
    );
  }
  const ended = migration.state === "ended";
  return (
    <>
      {ended && (
        <p class="member">
          The migration from {migration.source} ended without an import: it was refused or withdrawn.{hasIdentity ? "" : " You can ask again."}
        </p>
      )}
      {!ended && !hasIdentity && <Intro />}
      <div class="actions">
        {!hasIdentity &&
          SOURCES.map((source) => (
            <button
              key={source}
              class="button"
              type="button"
              disabled={acting.pending}
              onClick={() => void acting.run("migration", () => requestMigrationCall(source), "Migration requested.", () => storedMarkers.set(address, source))}
            >
              Migrate from {source}
            </button>
          ))}
        {ended && (
          <button
            class="quiet"
            type="button"
            disabled={acting.pending}
            onClick={() => {
              storedMarkers.clear(address);
              void reload();
            }}
          >
            Dismiss
          </button>
        )}
      </div>
    </>
  );
}

/** An account that has an identity and no migration to tell about has nothing to do here: the
 * section is left out. */
export function MigrationSection({ overview, acting, address, reload }: { overview: Overview; acting: Acting; address: string; reload(): Promise<boolean> }) {
  if (overview.profile !== null && overview.migration.state === "none") return null;
  return (
    <section class="block" aria-label="Migration">
      <h2 class="section">Migration</h2>
      <Body migration={overview.migration} hasIdentity={overview.profile !== null} acting={acting} address={address} reload={reload} />
      <StatusLine acting={acting} section="migration" />
    </section>
  );
}
