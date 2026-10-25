import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { get, knownHeight, live, PROFILE_BASE, type Status } from "../api.ts";
import { formatNumber } from "../format.ts";
import { Search } from "./search.tsx";

export const REPOSITORY = "https://github.com/sigreturn-labs/identitee-blockchain";

// [label, list page, detail pages]: a section stays current on its detail pages (/block/12 under Blocks)
export const SECTIONS: Array<[label: string, path: string, detail?: string]> = [
  ["Blocks", "/blocks", "/block/"],
  ["Extrinsics", "/extrinsics", "/extrinsic/"],
  ["Events", "/events"],
  ["Authorities", "/authorities", "/authority/"],
  ["Attestations", "/attestations"],
  ["Runtime", "/runtime"],
  ["Network", "/network"],
];

const isCurrent = (path: string, section: string, detail?: string): boolean => path === section || (detail !== undefined && path.startsWith(detail));

/** The finalized height: read once, then followed on the live stream. Null until known, and while
 * the node is away (the API then reports null). */
function useFinalized(): number | null {
  const [finalized, setFinalized] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    get<Status>("/api/status").then(
      (s) => {
        const known = knownHeight(s.finalized);
        if (!gone && s.node === "up" && known !== null) setFinalized((f) => Math.max(f ?? 0, known));
      },
      () => {},
    );
    const stop = live((head) => setFinalized(knownHeight(head.finalized)));
    return () => {
      gone = true;
      stop();
    };
  }, []);
  return finalized;
}

/** The frame of every page: the identit.ee mark with "Explorer" and the network, the search box,
 * the live finalized height, the sections, and a footer. Plain ground, no moving background. */
export function Layout({ children }: { children: ComponentChildren }) {
  const { path, query } = useLocation();
  const finalized = useFinalized();
  const term = path === "/search" ? (query.q ?? "") : "";
  return (
    <div class="frame">
      <header class="x-top">
        <div class="x-brand">
          <a class="mark" href="/" aria-label="identit.ee Explorer">
            identit<span>.ee</span>
            <span class="x-name">Explorer</span>
          </a>
          <span class="x-net">Testnet</span>
        </div>
        <Search key={term} initial={term} />
        <p class="x-height">
          {finalized !== null && (
            <>
              <span class="x-height-label">Finalized</span>
              <a href={`/block/${finalized}`}>{formatNumber(finalized)}</a>
            </>
          )}
        </p>
      </header>
      <nav class="x-nav" aria-label="Sections">
        {SECTIONS.map(([label, to, detail]) => (
          <a key={to} href={to} aria-current={isCurrent(path, to, detail) ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <main class="x-main">{children}</main>
      <footer class="x-foot">
        <a href={PROFILE_BASE}>identit.ee</a>
        <a href={REPOSITORY}>Source code</a>
      </footer>
    </div>
  );
}
