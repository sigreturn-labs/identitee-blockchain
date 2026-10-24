import { useEffect, useState } from "preact/hooks";
import { CheckIcon, CopyIcon, XIcon } from "./icons.tsx";

/** A small Copy icon for `text` (an address, a packet), which turns into a check for a moment
 * once copied, or into a cross if the browser refused; the outcome is also announced. */
export function CopyButton({ text, what, onResult }: { text: string; what: string; onResult?(copied: boolean): void }) {
  const [said, setSaid] = useState<"Copied" | "Copy failed" | null>(null);
  useEffect(() => {
    if (said === null) return;
    const timer = setTimeout(() => setSaid(null), 1600);
    return () => clearTimeout(timer);
  }, [said]);
  const label = `Copy ${what}`;
  return (
    <>
      <button
        class="icon-button copy"
        type="button"
        aria-label={label}
        title={label}
        data-copied={said === "Copied" || undefined}
        onClick={() => {
          const writing = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"));
          void writing.then(
            () => {
              setSaid("Copied");
              onResult?.(true);
            },
            () => {
              setSaid("Copy failed");
              onResult?.(false);
            },
          );
        }}
      >
        {said === "Copied" ? <CheckIcon /> : said === "Copy failed" ? <XIcon /> : <CopyIcon />}
      </button>
      {/* a live region inside a labelled button is not reliably read: this one sits beside it */}
      <span class="visually-hidden" role="status">
        {said ?? ""}
      </span>
    </>
  );
}
