import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * A button that asks once before doing something that is hard to take back: pressing it shows
 * `ask` with the real action (`confirm`) and a way out (`keep`). Keyboard focus moves to the
 * action, so Enter confirms, and Escape backs out.
 */
export function ConfirmButton({
  label,
  ask,
  confirm,
  keep = "Keep",
  disabled = false,
  onConfirm,
  quiet = false,
  icon,
  describe,
  onOpen,
}: {
  label: string;
  ask: ComponentChildren;
  confirm: string;
  keep?: string;
  disabled?: boolean;
  onConfirm(): void;
  /** The small grey button of a row, instead of the outlined one. */
  quiet?: boolean;
  /** An icon in place of the label: the label is then the button's name (aria-label and title). */
  icon?: ComponentChildren;
  /** The accessible name of the opening button, when the label alone is not enough. */
  describe?: string;
  /** The question was opened: the last result of the page is no longer news. */
  onOpen?(): void;
}) {
  const [asking, setAsking] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  // the action takes focus when the question opens: Enter confirms, Escape backs out
  useEffect(() => {
    if (asking) confirmButton.current?.focus();
  }, [asking]);
  if (!asking) {
    if (icon) {
      const name = describe ?? label;
      return (
        <button
          class="icon-button"
          type="button"
          disabled={disabled}
          aria-label={name}
          title={name}
          onClick={() => {
            onOpen?.();
            setAsking(true);
          }}
        >
          {icon}
        </button>
      );
    }
    return (
      <button
        class={quiet ? "quiet" : "button"}
        type="button"
        disabled={disabled}
        aria-label={describe}
        onClick={() => {
          onOpen?.();
          setAsking(true);
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <div class="confirm" role="group" aria-label={describe ?? label} onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
      <p class="hint">{ask}</p>
      <div class="actions">
        <button
          class="button primary"
          type="button"
          ref={confirmButton}
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
        <button class="button" type="button" onClick={() => setAsking(false)}>
          {keep}
        </button>
      </div>
    </div>
  );
}
