// The username: availability read from the chain while the person types, claim and release.
//
// What is typed is checked here first (the alphabet, the length, the names of the app's own pages),
// so a name that cannot exist never reaches the chain; a valid one is looked up once the typing
// pauses. The chain judges the claim itself: this page only keeps the button off when it already
// knows the answer (no identity, nothing verified, a name released a moment ago).

import { useEffect, useState } from "preact/hooks";
import { claimUsernameCall, releaseUsernameCall } from "../chain/calls.ts";
import { type NameStatus, nameStatus } from "../chain/identity.ts";
import { nameProblem } from "../chain/name.ts";
import type { Overview } from "../chain/overview.ts";
import { claimBlocker, type Clock, describeSpan, type NamingTimes, quarantineMessage, readBlock } from "../chain/naming.ts";
import { profilePath } from "../routes.ts";
import { ConfirmButton } from "../ui/confirm.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";

/** How long the typing must pause before the chain is asked. */
export const NAME_DEBOUNCE_MS = 300;

export type Check =
  | { state: "idle" }
  | { state: "problem"; message: string }
  | { state: "checking" }
  | { state: "failed" }
  | { state: "known"; status: NameStatus };

/** What is known of `name`, a name already trimmed and in lower case. `epoch` changes when
 * something was done on the chain, so the answer is read again. `problemOf` says what is wrong with
 * a name before the chain is asked (by default, what cannot be claimed). */
export function useNameCheck(name: string, epoch: number, problemOf: (name: string) => string | null = nameProblem): Check {
  const problem = name === "" ? null : problemOf(name);
  const [read, setRead] = useState<{ name: string; status: NameStatus | null } | null>(null);
  useEffect(() => {
    if (name === "" || problem !== null) return;
    let current = true;
    const timer = setTimeout(() => {
      nameStatus(name).then(
        (status) => current && setRead({ name, status }),
        () => current && setRead({ name, status: null }),
      );
    }, NAME_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, problem, epoch]);
  if (name === "") return { state: "idle" };
  if (problem !== null) return { state: "problem", message: problem };
  if (read === null || read.name !== name) return { state: "checking" };
  return read.status === null ? { state: "failed" } : { state: "known", status: read.status };
}

/** What the line under a name input says of `check`; `available` reads as good news, anything
 * else as a problem. */
export function nameLine(check: Check, name: string, clock: Clock): { text: string; kind: "problem" | "status" } | null {
  let line: { text: string; kind: "problem" | "status" } | null = null;
  if (check.state === "problem") line = { text: check.message, kind: "problem" };
  else if (check.state === "checking") line = { text: "Checking", kind: "status" };
  else if (check.state === "failed") line = { text: "Could not check that name. Try again in a moment.", kind: "problem" };
  else if (check.state === "known") {
    const { status } = check;
    const text =
      status.state === "available"
        ? `${name} is available.`
        : status.state === "taken"
          ? `${name} is taken.`
          : status.state === "reserved"
            ? `${name} is reserved.`
            : status.state === "quarantined"
              ? quarantineMessage(status.until, clock)
              : "That is not a valid name.";
    line = { text, kind: status.state === "available" ? "status" : "problem" };
  }
  return line;
}

/** `times` with the best block read again when a name is checked and when the window comes back
 * into focus: the wait after a release ends while the page stays open, and the page read at load
 * would keep Claim off past it. The block only moves forward. */
function useFreshTimes(times: NamingTimes, name: string): NamingTimes {
  const [block, setBlock] = useState(times.clock.block);
  const refresh = () =>
    void readBlock().then(
      (now) => setBlock((before) => Math.max(before, now)),
      () => undefined,
    );
  useEffect(() => setBlock((before) => Math.max(before, times.clock.block)), [times.clock.block]);
  useEffect(() => {
    if (name === "") return;
    const timer = setTimeout(refresh, NAME_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name]);
  useEffect(() => {
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
  }, []);
  return block === times.clock.block ? times : { ...times, clock: { ...times.clock, block } };
}

function ClaimForm({ overview, acting }: { overview: Overview; acting: Acting }) {
  const { profile } = overview;
  const [typed, setTyped] = useState("");
  const name = typed.trim().toLowerCase();
  const check = useNameCheck(name, acting.epoch);
  const times = useFreshTimes(overview.times, name);
  const blocker = claimBlocker(profile, times);
  const available = check.state === "known" && check.status.state === "available";

  const line = nameLine(check, name, times.clock);

  function claim() {
    if (!available || blocker !== null || acting.pending) return;
    void acting.run("name", () => claimUsernameCall(name), "Username claimed.");
  }

  return (
    <>
      {blocker && <p class="hint">{blocker.message}</p>}
      <form
        class="claim"
        onSubmit={(e) => {
          e.preventDefault();
          claim();
        }}
      >
        <input
          class="input"
          type="text"
          aria-label="Username to claim"
          placeholder="Choose a username"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={typed}
          aria-invalid={check.state === "problem" || (check.state === "known" && !available) || undefined}
          onInput={(e) => {
            acting.touch("name");
            setTyped(e.currentTarget.value);
          }}
        />
        <button class="button primary" type="submit" disabled={acting.pending || !available || blocker !== null}>
          Claim
        </button>
      </form>
      {line && (
        <p class={line.kind} aria-live="polite">
          {line.text}
        </p>
      )}
    </>
  );
}

export function NameSection({ overview, acting, address }: { overview: Overview; acting: Acting; address: string }) {
  const { profile, times } = overview;
  const name = profile?.name ?? null;
  return (
    <section class="block" aria-label="Username">
      <h2 class="section">Username</h2>
      {name ? (
        <>
          <p class="member">
            Your username is <a href={profilePath(name, address)}>{name}</a>.
          </p>
          <div class="actions">
            <ConfirmButton
              label="Release username"
              ask={`Release ${name}? Nobody can claim it for ${describeSpan(times.quarantineBlocks, times.clock.blockSeconds)}, and you cannot claim a name for ${describeSpan(times.cooldownBlocks, times.clock.blockSeconds)}.`}
              confirm="Release"
              disabled={acting.pending}
              onOpen={() => acting.touch("name")}
              onConfirm={() => void acting.run("name", releaseUsernameCall, "Username released.")}
            />
          </div>
        </>
      ) : (
        <ClaimForm overview={overview} acting={acting} />
      )}
      <StatusLine acting={acting} section="name" />
    </section>
  );
}
