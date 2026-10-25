import { useLocation } from "preact-iso";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, get, type SearchMatch, type SearchResult } from "../api.ts";
import { shortHash } from "../format.ts";

const HINT = "Type a block number, hash, extrinsic id, address or username.";

/** The page a search match opens. A username leads to its owner's account. */
export function matchPath({ kind, target }: SearchMatch): string {
  if (kind === "block") return `/block/${target}`;
  if (kind === "extrinsic") return `/extrinsic/${target}`;
  return `/account/${target}`;
}

function describe(match: SearchMatch): string {
  if (match.kind === "username") return `the username ${match.name ?? shortHash(match.target)}`;
  if (match.kind === "block") return `block ${match.target}`;
  if (match.kind === "extrinsic") return `extrinsic ${shortHash(match.target)}`;
  return `the account ${shortHash(match.target)}`;
}

type Outcome = { problem: string } | { alternatives: SearchMatch[] } | null;

/** One box for every kind of term: it asks `/api/search`, opens the match and offers the others
 * ("Did you mean the username 123?"). With `initial` (the /search page) it searches at once. */
export function Search({ initial = "" }: { initial?: string }) {
  const { route } = useLocation();
  const [text, setText] = useState(initial);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  // only the latest search may route or speak
  const latest = useRef(0);

  async function run(term: string, replace = false) {
    const q = term.trim();
    const ticket = ++latest.current;
    if (q === "") return setOutcome({ problem: HINT });
    setBusy(true);
    try {
      const result = await get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
      if (ticket !== latest.current) return;
      if (result.kind === "none") {
        setOutcome(result.alternatives.length > 0 ? { alternatives: result.alternatives } : { problem: `Nothing found for "${q}".` });
        return;
      }
      setOutcome(result.alternatives.length > 0 ? { alternatives: result.alternatives } : null);
      route(matchPath({ kind: result.kind, target: result.target }), replace);
    } catch (error) {
      if (ticket !== latest.current) return;
      setOutcome({ problem: error instanceof ApiError && error.code === "bad_query" ? HINT : "Search is unavailable. Try again." });
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (initial.trim() !== "") void run(initial, true);
  }, [initial]);

  return (
    <form
      class="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        // the box itself, not the state: a value typed or filled just before submitting counts
        const box = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
        void run(box.value);
      }}
    >
      <input
        class="input"
        type="search"
        name="q"
        aria-label="Search"
        placeholder="Block, extrinsic, address or username"
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        value={text}
        aria-invalid={(outcome !== null && "problem" in outcome) || undefined}
        aria-describedby="search-outcome"
        onInput={(e) => {
          setText(e.currentTarget.value);
          setOutcome(null);
        }}
      />
      <button class="button" type="submit" disabled={busy}>
        Search
      </button>
      <div id="search-outcome" class="search-outcome" aria-live="polite">
        {outcome && "problem" in outcome && <p class="problem">{outcome.problem}</p>}
        {outcome &&
          "alternatives" in outcome &&
          outcome.alternatives.map((match) => {
            const label = describe(match);
            const [lead, shown] = match.kind === "username" ? ["the username ", match.name ?? shortHash(match.target)] : ["", label];
            return (
              <p class="note" key={`${match.kind}:${match.target}`}>
                Did you mean {lead}
                <a href={matchPath(match)} title={match.target} onClick={() => setOutcome(null)}>
                  {shown}
                </a>
                ?
              </p>
            );
          })}
      </div>
    </form>
  );
}
