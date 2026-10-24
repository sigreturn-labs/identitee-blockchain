// Reserved names: names nobody can claim, that only an authority gives (from Accounts). An agent
// that manages names reserves any name the runtime accepts, the names of the app's pages included
// (`requests`, `authority`: a profile there would never show), and lifts a reservation.

import { useState } from "preact/hooks";
import { reserveUsernameCall, unreserveUsernameCall } from "../chain/calls.ts";
import { ruleProblem } from "../chain/name.ts";
import { IconButton, XIcon } from "../ui/icons.tsx";
import type { Desk } from "./authority-page.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";
import { nameLine, useNameCheck } from "./requests-name.tsx";

export function ReservedSection({ desk, names, acting }: { desk: Desk; names: string[]; acting: Acting }) {
  const [typed, setTyped] = useState("");
  const name = typed.trim().toLowerCase();
  const check = useNameCheck(name, acting.epoch, ruleProblem);
  const line = nameLine(check, name, desk.clock);
  const known = check.state === "known" ? check.status.state : null;
  // a name in quarantine can be reserved: the reservation keeps it once the quarantine ends
  const reservable = known === "available" || known === "quarantined";

  function reserve() {
    if (!reservable || acting.pending) return;
    void acting.run("reserved", () => reserveUsernameCall(name), `${name} reserved.`).then((ok) => ok && setTyped(""));
  }

  return (
    <section class="block" aria-label="Reserved names" id="reserved">
      <h2 class="section">Reserved names</h2>
      {names.length === 0 && <p class="hint">No name is reserved.</p>}
      {names.length > 0 && (
        <ul class="asks" aria-label="Reserved">
          {names.map((reserved) => (
            <li class="ask" key={reserved}>
              <div class="ask-text">
                <span class="ask-label">{reserved}</span>
              </div>
              <div class="ask-side">
                <IconButton
                  label={`Lift the reservation of ${reserved}`}
                  disabled={acting.pending}
                  onClick={() => void acting.run("reserved", () => unreserveUsernameCall(reserved), `${reserved} is no longer reserved.`)}
                >
                  <XIcon />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        class="claim"
        onSubmit={(e) => {
          e.preventDefault();
          reserve();
        }}
      >
        <input
          class="input"
          type="text"
          aria-label="Name to reserve"
          placeholder="Reserve a name"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={typed}
          aria-invalid={(line?.kind === "problem" && known !== "quarantined") || undefined}
          onInput={(e) => {
            acting.touch("reserved");
            setTyped(e.currentTarget.value);
          }}
        />
        <button class="button" type="submit" disabled={acting.pending || !reservable}>
          Reserve
        </button>
      </form>
      {line && (
        <p class={known === "quarantined" ? "status" : line.kind} aria-live="polite">
          {line.text}
        </p>
      )}
      <StatusLine acting={acting} section="reserved" />
    </section>
  );
}
