import { useLocation } from "preact-iso";
import { useState } from "preact/hooks";
import { isValidName } from "../chain/name.ts";

// An address is long base58 (or 0x and 64 hex digits for a public key): the profile page checks it
// for real. No chain library here, the home page shows this before any is downloaded.
const looksLikeAddress = (text: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(text) || /^0x[0-9a-fA-F]{64}$/.test(text);

/** Where `text` (a username or an address, as typed or pasted) leads, or a sentence saying why it
 * cannot be either. */
export function lookupPath(text: string): { path: string } | { problem: string } {
  const typed = text.trim().replace(/^@/, "");
  if (typed === "") return { problem: "Type a name or an address." };
  if (looksLikeAddress(typed)) return { path: `/a/${typed}` };
  const name = typed.toLowerCase();
  return isValidName(name) ? { path: `/${name}` } : { problem: "That is neither a name nor an address." };
}

/** Find a profile by username or address. */
export function Lookup() {
  const { route } = useLocation();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      class="lookup"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const found = lookupPath(text);
        if ("path" in found) route(found.path);
        else setProblem(found.problem);
      }}
    >
      <input
        class="input"
        type="search"
        aria-label="Name or address"
        placeholder="Name or address"
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        value={text}
        aria-invalid={problem !== null || undefined}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setProblem(null);
        }}
      />
      <button class="button" type="submit">
        Find
      </button>
      {problem && <p class="problem">{problem}</p>}
    </form>
  );
}
