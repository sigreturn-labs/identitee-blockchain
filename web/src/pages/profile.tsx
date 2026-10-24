// A public profile, read from the chain: `/:name`, `/a/:address`, and the home page of a
// connected account. `ProfileView` only draws a `Profile` (nothing in it asks the chain);
// `ProfilePage` reads it and covers the other states: loading, nothing there, a failed read.
//
// What the card calls "Verified" and the level pill come from `readProfile` alone (the runtime
// folds expiry, revocation and changed values into them), never from anything computed here.
// "Pending" is shown only for a value an authority has been asked to judge: the requests are read
// at the same block as the profile, and `standingOf` (chain/requests.ts) ranks both, as /requests does.

import { useEffect, useMemo, useState } from "preact/hooks";
import { isAddress, publicKeyOf, toIdentitee } from "../chain/address.ts";
import { DecodeError, type Member, type Profile, type ProfileField, readProfile, resolveName } from "../chain/identity.ts";
import { isValidName } from "../chain/name.ts";
import { shorten } from "../chain/short.ts";
import { type PendingRequest, type Standing, pendingRequestsOf, requestedIds, standingOf } from "../chain/requests.ts";
import { snapshot } from "../chain/reader.ts";
import { RESERVED_PATHS, profilePath } from "../routes.ts";
import { Avatar, ChainAvatar } from "../ui/avatar.tsx";
import { Card, MessageCard, ProfileSkeleton } from "../ui/card.tsx";
import { CopyButton } from "../ui/copy.tsx";
import { LEVEL_LABELS, LevelBadge, StateMark } from "../ui/level.tsx";
import { Lookup } from "../ui/lookup.tsx";

export type ProfileTarget = { by: "address"; address: string } | { by: "name"; name: string };

/** Up to this many fields the card has one column; beyond it, two (and it widens). */
export const ONE_COLUMN_MAX = 6;


// --- What the card shows ----------------------------------------------------------------------

/** The public display name, if the person set one and left it public. */
export function displayNameOf(profile: Profile): string | null {
  const field = profile.fields.find((f) => f.id === "typed:DisplayName");
  const value = field?.privacy === "public" ? field.value?.trim() : undefined;
  return value ? value : null;
}

/** The name in the header (display name, else username, else the short address) and the username
 * to show beneath it when the header shows something else. */
export function headline(profile: Profile): { title: string; handle: string | null; titleIsAddress: boolean } {
  const display = displayNameOf(profile);
  const username = profile.name;
  if (display) {
    return { title: display, handle: username && username.toLowerCase() !== display.toLowerCase() ? username : null, titleIsAddress: false };
  }
  if (username) return { title: username, handle: null, titleIsAddress: false };
  return { title: shorten(profile.address), handle: null, titleIsAddress: true };
}

/** The fields to list: the public display name already is the title of the card. */
export function fieldRows(profile: Profile): ProfileField[] {
  return profile.fields.filter((f) => !(f.id === "typed:DisplayName" && displayNameOf(profile) !== null));
}

/** What a field's value looks like: a PGP fingerprint in groups of four, as GnuPG prints it (it
 * wraps at the groups); anything else as it is. */
export function displayValue(field: ProfileField): string {
  const value = field.value ?? "";
  return field.id === "typed:Pgp" ? (value.match(/.{1,4}/g) ?? []).join(" ") : value;
}

/** A link's address as shown (host and path), and where it leads: only http and https are
 * followed, anything else is shown as text. */
export function describeUrl(url: string): { text: string; href: string | null } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { text: url, href: null };
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return { text: `${parsed.host}${path}`, href: parsed.href };
  } catch {
    return { text: url, href: null };
  }
}

/** A Website field as a link: the value as typed (with or without its scheme), followed only for
 * http and https, as a link row is. */
export function websiteOf(value: string): { text: string; href: string | null } {
  const typed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  const described = describeUrl(withScheme);
  return described.href !== null && /^([^\s%]+\.[^\s%]+)$/.test(new URL(described.href).host) ? described : { text: typed, href: null };
}

// --- Reading ----------------------------------------------------------------------------------

type Reading =
  | { state: "loading" }
  | { state: "found"; profile: Profile; pending: PendingRequest[] }
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "failed"; message: string };

const MISSING: Reading = { state: "missing" };

async function read(target: ProfileTarget): Promise<Reading> {
  let address: string;
  if (target.by === "name") {
    // text that cannot be a username (a stray `robots.txt`, a long junk path) never reaches the chain
    const name = target.name.toLowerCase();
    if (!isValidName(name)) return MISSING;
    const owner = await resolveName(name);
    if (owner === null) return MISSING;
    address = owner;
  } else {
    // a bad address never reaches the chain, nor the avatar
    if (!isAddress(target.address)) return { state: "malformed" };
    address = toIdentitee(target.address);
  }
  // the identity and the requests waiting on it, read at one block
  const at = await snapshot();
  const [profile, pending] = await Promise.all([readProfile(address, at), pendingRequestsOf(address, at)]);
  return profile === null ? MISSING : { state: "found", profile, pending };
}

/** A sentence for a read that failed; the network is the usual reason. */
export function describeFailure(error: unknown): string {
  if (error instanceof DecodeError) return error.message;
  const text = error instanceof Error ? error.message : "";
  return /reach|connect|disconnected/i.test(text) ? "Cannot reach the identit.ee network." : "Cannot read this identity right now.";
}

const keyOf = (target: ProfileTarget): string => (target.by === "name" ? `name:${target.name}` : `address:${target.address}`);

/** The reading of `target`; `loading` as soon as the target or `attempt` changes, so a profile is
 * never shown under another one's address. */
function useReading(target: ProfileTarget, attempt: number): Reading {
  const key = keyOf(target);
  const [done, setDone] = useState<{ key: string; attempt: number; reading: Reading } | null>(null);
  useEffect(() => {
    let current = true;
    read(target).then(
      (reading) => current && setDone({ key, attempt, reading }),
      (error: unknown) => current && setDone({ key, attempt, reading: { state: "failed", message: describeFailure(error) } }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt]);
  return done !== null && done.key === key && done.attempt === attempt ? done.reading : { state: "loading" };
}

export interface ParentLink {
  title: string;
  path: string;
}

/** The parent of a sub-account as a link: its name when it can be read, its short address meanwhile. */
function useParentLink(parent: Member | null): ParentLink | null {
  const address = parent?.address ?? null;
  const [named, setNamed] = useState<{ address: string; link: ParentLink } | null>(null);
  useEffect(() => {
    if (address === null) return;
    let current = true;
    readProfile(address).then(
      (found) => {
        if (!current || found === null) return;
        const { title, titleIsAddress } = headline(found);
        setNamed({ address, link: { title, path: profilePath(titleIsAddress ? null : found.name, address) } });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [address]);
  if (address === null) return null;
  return named?.address === address ? named.link : { title: shorten(address), path: profilePath(null, address) };
}

/** Accounts as links: their name and their username's page once read (accounts with an identity
 * only), nothing meanwhile. */
export function useProfileLinks(accounts: readonly string[]): Map<string, ParentLink> {
  const addresses = accounts.join(",");
  const [named, setNamed] = useState<{ addresses: string; links: Map<string, ParentLink> } | null>(null);
  useEffect(() => {
    if (addresses === "") return;
    let current = true;
    void Promise.all(accounts.map((account) => readProfile(account).catch(() => null))).then((found) => {
      if (!current) return;
      const links = new Map<string, ParentLink>();
      found.forEach((profile, i) => {
        if (profile === null) return;
        const { title, titleIsAddress } = headline(profile);
        if (!titleIsAddress) links.set(accounts[i]!, { title, path: profilePath(profile.name, accounts[i]!) });
      });
      setNamed({ addresses, links });
    });
    return () => {
      current = false;
    };
  }, [addresses]);
  return named?.addresses === addresses ? named.links : new Map();
}

// --- Drawing ----------------------------------------------------------------------------------

/** The state of a field or a link: a dot and a word. Filled for Verified, hollow for Pending, hollow
 * and struck through for Rejected; a value with no state (nothing asked, nothing attested) has none.
 * Under 480 px only the dot shows, so the dot carries the word itself. The one place that draws it,
 * as a `dd` in a list of fields and as a `span` elsewhere. */
export function State({ standing: value, tag: Tag = "span" }: { standing: Standing; tag?: "span" | "dd" }) {
  // Verified is the check alone; the word is still there for screen readers
  return (
    <Tag class={`state standing ${value.toLowerCase()}`} title={value}>
      <StateMark standing={value} />
      <span class={value === "Verified" ? "visually-hidden" : "mark-word"}>{value}</span>
    </Tag>
  );
}

/** A profile, drawn as a Card. */
export function ProfileView({
  profile,
  parent,
  pending,
  own = false,
}: {
  profile: Profile;
  parent: ParentLink | null;
  pending: readonly PendingRequest[];
  own?: boolean;
}) {
  // `profile.address` has been through `toIdentitee`: it always decodes.
  const key = useMemo(() => publicKeyOf(profile.address), [profile.address]);
  const rows = fieldRows(profile);
  const requested = useMemo(() => requestedIds(pending), [pending]);
  const { title, handle, titleIsAddress } = headline(profile);
  const subLinks = useProfileLinks(profile.subs.map((sub) => sub.address));

  return (
    <Card wide={rows.length > ONE_COLUMN_MAX} label={title}>
      <div class="head">
        {profile.avatar ? (
          <ChainAvatar webp={profile.avatar} publicKey={key} size={56} label={`Avatar of ${title}`} />
        ) : (
          <Avatar publicKey={key} size={56} label={`Avatar of ${title}`} />
        )}
        <div>
          <div class="title-line">
            <h1 class="name" title={titleIsAddress ? profile.address : undefined}>
              {title}
            </h1>
            <LevelBadge trust={profile.trust} />
          </div>
          {handle && <span class="addr">{handle}</span>}
          <span class="addr-line">
            {!titleIsAddress && (
              <span class="addr" title={profile.address}>
                {shorten(profile.address)}
              </span>
            )}
            <CopyButton text={profile.address} what="address" />
          </span>
        </div>
        <span class={profile.trust === "Fraudulent" ? "level fraud" : "level"}>{LEVEL_LABELS[profile.trust]}</span>
      </div>

      {profile.trust === "Fraudulent" && <p class="fraud-note">An identity authority found this identity fraudulent. Do not trust what it says.</p>}

      {parent && (
        <p class="member">
          Member of <a href={parent.path}>{parent.title}</a>
        </p>
      )}
      {profile.bio !== "" && <p class="bio">{profile.bio}</p>}

      {rows.length > 0 && (
        <dl class={rows.length > ONE_COLUMN_MAX ? "fields two" : "fields"}>
          {rows.map((field) => {
            const value = standingOf(field.id, field, requested);
            return (
              <div class="row" key={field.id}>
                <dt>{field.label}</dt>
                {field.privacy === "private" ? (
                  <dd class="private">Private</dd>
                ) : field.id === "typed:Web" ? (
                  <dd>
                    <Website value={displayValue(field)} />
                  </dd>
                ) : (
                  <dd>{displayValue(field)}</dd>
                )}
                {value && <State standing={value} tag="dd" />}
              </div>
            );
          })}
        </dl>
      )}

      {profile.links.length > 0 && (
        <div class="links">
          {profile.links.map((link) => {
            const { text, href } = describeUrl(link.url);
            const value = standingOf(`link:${link.id}`, link, requested);
            const inside = (
              <>
                <span class="link-title">{link.title}</span>
                <span class="link-meta">
                  <span class="link-url">{text}</span>
                  {value && <State standing={value} />}
                </span>
              </>
            );
            return href ? (
              <a class="link glass" key={link.id} href={href} target="_blank" rel="noopener noreferrer">
                {inside}
              </a>
            ) : (
              <div class="link glass" key={link.id}>
                {inside}
              </div>
            );
          })}
        </div>
      )}

      {profile.subs.length > 0 && (
        <section class="subs" aria-label="Sub-accounts">
          <h2 class="section">Sub-accounts</h2>
          <div class="links">
            {profile.subs.map((sub) => {
              const named = subLinks.get(sub.address);
              return (
                <a class="link glass" key={sub.address} href={named?.path ?? profilePath(null, sub.address)}>
                  <span class="link-title">{sub.label || named?.title || shorten(sub.address)}</span>
                  {(sub.label || named) && (
                    <span class="link-meta" title={sub.address}>
                      <span class="link-url">{sub.label && named ? named.title : shorten(sub.address)}</span>
                    </span>
                  )}
                </a>
              );
            })}
          </div>
        </section>
      )}

      {own && (
        <a class="button" href="/me">
          Edit your identity
        </a>
      )}
    </Card>
  );
}

function Website({ value }: { value: string }) {
  const { text, href } = websiteOf(value);
  return href ? (
    <a class="value-link" href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  ) : (
    <>{text}</>
  );
}

/** Read `target` from the chain and draw it. With `own`, an account without identity is offered
 * to create one. */
export function ProfilePage({ target, own = false }: { target: ProfileTarget; own?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const reading = useReading(target, attempt);
  const profile = reading.state === "found" ? reading.profile : null;
  const parent = useParentLink(profile?.parent ?? null);

  const pageTitle = profile !== null ? headline(profile).title : reading.state === "loading" || reading.state === "failed" ? null : "Not found";
  useEffect(() => {
    if (pageTitle === null) return;
    document.title = `${pageTitle} - identit.ee`;
    return () => {
      document.title = "identit.ee";
    };
  }, [pageTitle]);

  switch (reading.state) {
    case "loading":
      return <ProfileSkeleton />;
    case "missing":
      return own ? (
        <MessageCard
          label="No identity yet"
          action={
            <a class="button primary" href="/me">
              Create your identity
            </a>
          }
        >
          This account has no identity yet.
        </MessageCard>
      ) : (
        <MessageCard label="Not found" action={<Lookup />}>
          {target.by === "name" && isValidName(target.name.toLowerCase()) && !RESERVED_PATHS.includes(target.name.toLowerCase()) ? `Nobody has the name ${target.name.toLowerCase()}.` : "No identity found."}
        </MessageCard>
      );
    case "malformed":
      return (
        <MessageCard label="Not found" action={<Lookup />}>
          This is not a valid address.
        </MessageCard>
      );
    case "failed":
      return (
        <MessageCard
          label="Not available"
          action={
            <button class="button" type="button" onClick={() => setAttempt(attempt + 1)}>
              Try again
            </button>
          }
        >
          {reading.message}
        </MessageCard>
      );
    case "found":
      return <ProfileView profile={reading.profile} parent={parent} pending={reading.pending} own={own} />;
  }
}
