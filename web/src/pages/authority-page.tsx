// `/authority` for a connected account. It is shown only to an agent of an active authority that
// holds one of the capabilities the page uses (chain/agent.ts); anyone else gets "Page not found.",
// as for a page that does not exist. Each section and each action shows only if a capability allows
// it, and the chain stays the judge: a refusal comes back as a sentence.
//
// Everything is read from the chain, and read again after each action and every 20 seconds while
// the tab is visible (requests arrive by themselves). Agent calls are free for an agent: nothing
// here estimates or shows a fee.

import { useEffect, useRef, useState } from "preact/hooks";
import { type Agent, readAgent } from "../chain/agent.ts";
import { type Account, type InboxItem, readAccount, readInbox, readReserved } from "../chain/inbox.ts";
import { type Clock, readNamingTimes } from "../chain/naming.ts";
import type { GateProps } from "../ui/account-gate.tsx";
import { Card, MessageCard, ProfileSkeleton } from "../ui/card.tsx";
import { NotFound } from "./not-found.tsx";
import { describeFailure } from "./profile.tsx";
import { AccountSection } from "./authority-account.tsx";
import { InboxSection } from "./authority-inbox.tsx";
import { ReservedSection } from "./authority-names.tsx";
import { POLL_MS, useActing } from "./requests-acting.tsx";

/** The chain's errors, said for an agent acting on someone else's identity. */
export const AGENT_MESSAGES: Record<string, string> = {
  NoIdentity: "That account has no identity.",
  AlreadyHasName: "That account already has a username.",
  NoName: "That account has no username.",
  FieldNotFound: "That field is no longer on the identity.",
  StaleCommitment: "The field changed since it was read. Look at it again.",
  UnknownRequest: "That request is no longer waiting.",
  NotAnAgent: "This account is no longer an authority agent.",
  MissingCapability: "This agent is not allowed to do that.",
  AuthorityInactive: "This agent's authority is not active.",
  NameInQuarantine: "That name was released recently and cannot be given yet.",
};

export interface Desk {
  agent: Agent;
  clock: Clock;
  /** `null` when the agent cannot act on requests. */
  inbox: InboxItem[] | null;
  /** `null` when the agent cannot manage names. */
  reserved: string[] | null;
  /** The account looked up, once one is. */
  account: Account | null;
}

type Reading = { state: "loading" } | { state: "none" } | { state: "ready"; desk: Desk } | { state: "failed"; message: string };

async function readDesk(address: string, lookedUp: string | null): Promise<Desk | null> {
  const agent = await readAgent(address);
  if (agent === null) return null;
  const id = agent.authority.id;
  const [times, inbox, reserved, account] = await Promise.all([
    readNamingTimes(address),
    agent.attest || agent.facts ? readInbox(id) : null,
    agent.names ? readReserved() : null,
    lookedUp === null ? null : readAccount(lookedUp, id),
  ]);
  return { agent, clock: times.clock, inbox, reserved, account };
}

export function AuthorityPage({ address, wallet }: GateProps) {
  const [reading, setReading] = useState<Reading>({ state: "loading" });
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const latest = useRef(0);
  const looked = useRef<string | null>(null);

  const load = async (quiet: boolean): Promise<boolean> => {
    const ticket = ++latest.current;
    if (!quiet) setReading({ state: "loading" });
    try {
      const desk = await readDesk(address, looked.current);
      if (ticket === latest.current) setReading(desk === null ? { state: "none" } : { state: "ready", desk });
      return true;
    } catch (error) {
      if (ticket === latest.current && !quiet) setReading({ state: "failed", message: describeFailure(error) });
      return false;
    }
  };
  useEffect(() => {
    looked.current = null;
    setLookedUp(null);
    void load(false);
    return () => void latest.current++;
  }, [address]);

  const acting = useActing(address, wallet, () => load(true), AGENT_MESSAGES);

  // requests arrive while the page is open: read again now and then, unless hidden or busy
  const again = useRef(() => undefined as unknown);
  again.current = async () => {
    if (document.hidden || acting.pending) return;
    if (await load(true)) acting.clear();
  };
  const ready = reading.state === "ready";
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => void again.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [ready]);

  /** Look an account up (or forget it with `null`): read the page again with it. */
  async function lookUp(account: string | null): Promise<boolean> {
    looked.current = account;
    setLookedUp(account);
    return load(true);
  }

  if (reading.state === "loading") return <ProfileSkeleton />;
  if (reading.state === "none") return <NotFound />;
  if (reading.state === "failed") {
    return (
      <MessageCard
        label="Not available"
        action={
          <button class="button" type="button" onClick={() => void load(false)}>
            Try again
          </button>
        }
      >
        {reading.message}
      </MessageCard>
    );
  }

  const { desk } = reading;
  const { agent } = desk;
  return (
    <Card edit label="Authority" busy={acting.pending}>
      <fieldset class="editor" disabled={acting.pending}>
        <div class="head">
          <div>
            <h1 class="name">{agent.authority.name}</h1>
            <span class="addr">{capabilitiesOf(agent)}</span>
          </div>
        </div>
        {/* the sections below the inbox can be far down: a way to them from the top */}
        {desk.inbox !== null && (
          <nav class="jump" aria-label="Sections">
            <a href="#requests">Requests</a>
            <a href="#accounts">Accounts</a>
            {desk.reserved !== null && <a href="#reserved">Reserved names</a>}
          </nav>
        )}
        {desk.inbox !== null && <InboxSection desk={desk} items={desk.inbox} acting={acting} reload={() => load(true)} />}
        <AccountSection desk={desk} lookedUp={lookedUp} lookUp={lookUp} acting={acting} />
        {desk.reserved !== null && <ReservedSection desk={desk} names={desk.reserved} acting={acting} />}
      </fieldset>
    </Card>
  );
}

/** What this agent may do, in a few words. */
function capabilitiesOf(agent: Agent): string {
  const can = [agent.attest && "verifies fields", agent.facts && "records facts", agent.names && "manages names"].filter(Boolean) as string[];
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} and ${can.at(-1)}` : can[0];
  return `Agent, ${list}`;
}
