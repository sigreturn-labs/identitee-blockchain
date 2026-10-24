// `/requests` for a connected account: verification requests, the username, sub-accounts and
// migration. Everything on the page is read from the chain in one go (`readOverview`); each action
// signs one call, sends it, and reads everything again, so what the page shows afterwards is what
// the chain says. Nothing here estimates or shows a fee: identity calls are free, even from an
// account with nothing in it.

import { CopyButton } from "../ui/copy.tsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { publicKeyOf } from "../chain/address.ts";
import { type Overview, readOverview } from "../chain/overview.ts";
import { shorten } from "../chain/short.ts";
import type { GateProps } from "../ui/account-gate.tsx";
import { Avatar, ChainAvatar } from "../ui/avatar.tsx";
import { Card, MessageCard, ProfileSkeleton } from "../ui/card.tsx";
import { describeFailure, headline } from "./profile.tsx";
import { POLL_MS, useActing } from "./requests-acting.tsx";
import { MigrationSection } from "./requests-migration.tsx";
import { NameSection } from "./requests-name.tsx";
import { SubsSection } from "./requests-subs.tsx";
import { VerifySection } from "./requests-verify.tsx";

export { POLL_MS };

type Reading = { state: "loading" } | { state: "ready"; overview: Overview } | { state: "failed"; message: string };

/** The overview of `address`, read again on demand. `reload` keeps showing the current one while it
 * reads, and keeps it if the read fails, saying so by returning `false`; `retry` starts over. */
function useOverview(address: string) {
  const [reading, setReading] = useState<Reading>({ state: "loading" });
  const latest = useRef(0);
  const load = async (quiet: boolean): Promise<boolean> => {
    const ticket = ++latest.current;
    if (!quiet) setReading({ state: "loading" });
    try {
      const overview = await readOverview(address);
      if (ticket === latest.current) setReading({ state: "ready", overview });
      return true;
    } catch (error) {
      if (ticket === latest.current && !quiet) setReading({ state: "failed", message: describeFailure(error) });
      return false;
    }
  };
  useEffect(() => {
    void load(false);
    return () => void latest.current++;
  }, [address]);
  return { reading, reload: () => load(true), retry: () => void load(false) };
}

/** Something is waiting for another party, so the answer can arrive while the page is open. */
const waiting = (o: Overview): boolean => o.pending.length > 0 || o.proposed.length > 0 || o.migration.state === "pending";

export function MyRequests({ address, wallet }: GateProps) {
  const { reading, reload, retry } = useOverview(address);
  const acting = useActing(address, wallet, reload);

  // read again now and then while something waits, unless the tab is hidden or an action is running
  const again = useRef(() => undefined as unknown);
  again.current = async () => {
    if (document.hidden || acting.pending) return;
    // what an action said a while ago is old news once the page has looked again
    if (await reload()) acting.clear();
  };
  const polling = reading.state === "ready" && waiting(reading.overview);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void again.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  if (reading.state === "loading") return <ProfileSkeleton />;
  if (reading.state === "failed") {
    return (
      <MessageCard
        label="Not available"
        action={
          <button class="button" type="button" onClick={retry}>
            Try again
          </button>
        }
      >
        {reading.message}
      </MessageCard>
    );
  }

  const { overview } = reading;
  const { profile } = overview;
  const key = publicKeyOf(address);
  const { title, titleIsAddress } = profile ? headline(profile) : { title: shorten(address), titleIsAddress: true };
  return (
    <Card edit label="Requests" busy={acting.pending}>
      <fieldset class="editor" disabled={acting.pending}>
        <div class="head">
          {profile?.avatar ? (
            <ChainAvatar webp={profile.avatar} publicKey={key} size={56} label="Your avatar" />
          ) : (
            <Avatar publicKey={key} size={56} label="Your avatar" />
          )}
          <div>
            <h1 class="name" title={titleIsAddress ? address : undefined}>
              {title}
            </h1>
            <span class="addr-line">
              {!titleIsAddress && (
                <span class="addr" title={address}>
                  {shorten(address)}
                </span>
              )}
              <CopyButton text={address} what="address" />
            </span>
          </div>
        </div>
        {profile === null ? (
          <div class="block">
            <p class="hint">Verifications, a username and sub-accounts of your own need an identity.</p>
            {overview.migration.state === "pending" ? (
              <p class="hint">Your migration request is waiting: creating an identity now would stop the import. Wait for it, or cancel it below.</p>
            ) : (
              <a class="quiet-link" href="/me">
                Create your identity
              </a>
            )}
          </div>
        ) : (
          <>
            <VerifySection overview={overview} acting={acting} />
            <NameSection overview={overview} acting={acting} address={address} />
          </>
        )}
        <SubsSection overview={overview} acting={acting} address={address} />
        <MigrationSection overview={overview} acting={acting} address={address} reload={reload} />
      </fieldset>
    </Card>
  );
}
