// `/me` for a connected account: the avatar, the bio, the fields and the links of its identity.
// An account with no identity gets the same form, empty: the first save creates the identity.
//
// Every save signs one call with the wallet and sends it with `send`. Nothing here estimates or
// shows a fee (identity calls are free, even from an account with nothing in it); a refused call
// says why in a sentence (the daily limit among them). After a save the identity is read again
// from the chain, and what the page then shows is what the chain says.

import { useEffect, useRef, useState } from "preact/hooks";
import { publicKeyOf } from "../chain/address.ts";
import { type Call, updateProfileCall, updateSize } from "../chain/calls.ts";
import { type Profile, readProfile } from "../chain/identity.ts";
import { NOT_PREPARED, sentenceOf } from "../chain/refusal.ts";
import { shorten } from "../chain/short.ts";
import { send } from "../chain/tx.ts";
import { profilePath } from "../routes.ts";
import { AvatarEditor } from "../ui/avatar-editor.tsx";
import { Avatar, ChainAvatar } from "../ui/avatar.tsx";
import { Card, MessageCard, ProfileSkeleton } from "../ui/card.tsx";
import { CopyButton } from "../ui/copy.tsx";
import { IconButton, UndoIcon } from "../ui/icons.tsx";
import { useUnsaved } from "../ui/unsaved.ts";
import type { GateProps } from "../ui/account-gate.tsx";
import { useIdentitySecret } from "./me-private.tsx";
import { useProfileForm } from "./me-form.ts";
import { DocumentRow, useVerification } from "./me-verify.tsx";
import { BioSection, FieldsSection, LinksSection, SaveBar, type Saving, type Section, type Status } from "./me-sections.tsx";
import { describeFailure, headline } from "./profile.tsx";

type Own = { state: "loading" } | { state: "ready"; profile: Profile | null } | { state: "failed"; message: string };

/** The identity of `address`, read again on demand. `reload` keeps showing the current one while it
 * reads, so the form does not flash, and keeps it (and every draft) if the read fails, saying so by
 * returning `false`; `retry` starts over. */
function useOwnProfile(address: string) {
  const [own, setOwn] = useState<Own>({ state: "loading" });
  const latest = useRef(0);
  const load = async (quiet: boolean): Promise<boolean> => {
    const ticket = ++latest.current;
    if (!quiet) setOwn({ state: "loading" });
    try {
      const profile = await readProfile(address);
      if (ticket === latest.current) setOwn({ state: "ready", profile });
      return true;
    } catch (error) {
      if (ticket === latest.current && !quiet) setOwn({ state: "failed", message: describeFailure(error) });
      return false;
    }
  };
  useEffect(() => {
    void load(false);
    return () => void latest.current++;
  }, [address]);
  return { own, reload: () => load(true), retry: () => void load(false) };
}

const SAVED_NOT_READ = "Saved, but the identity could not be read again.";

export function MyIdentity({ address, wallet }: GateProps) {
  const { own, reload, retry } = useOwnProfile(address);
  const [status, setStatus] = useState<Status | null>(null);
  const [changingAvatar, setChangingAvatar] = useState(false);
  // a save went through but the identity could not be read again: the form shows an older state
  const stale = useRef(false);
  const pending = status?.state === "saving";

  async function save(section: Section, build: () => Promise<Call>): Promise<boolean> {
    if (pending) return false;
    const fail = (message: string): false => {
      setStatus({ section, state: "error", message });
      return false;
    };
    setStatus({ section, state: "saving" });
    // The last save went through but was not read back: read now, so the page shows what the chain
    // holds. The update was built before; `update_profile` replaces the links by the list it sends,
    // so sending it again does not add a link twice.
    if (stale.current) {
      if (!(await reload())) return fail("The identity could not be read. Try again in a moment.");
      stale.current = false;
    }
    let signer;
    try {
      signer = await wallet.signerFor(address);
    } catch {
      return fail("The wallet could not be reached. Try again.");
    }
    let call: Call;
    try {
      call = await build();
    } catch (error) {
      // a sentence of the app (a limit, a form problem) is shown as is; anything else is not for the person
      return fail(sentenceOf(error, NOT_PREPARED));
    }
    // "Saved" is all `send` can say: what the chain now holds comes from reading it again
    const result = await send(call, signer);
    if (!result.ok) return fail(result.error ?? "The transaction could not be sent.");
    const read = await reload();
    stale.current = !read;
    setStatus(read ? { section, state: "saved" } : { section, state: "saved", message: SAVED_NOT_READ });
    return true;
  }
  const saving: Saving = {
    status,
    pending,
    save,
    touch: (section) => setStatus((now) => (now && now.section === section && now.state !== "saving" ? null : now)),
  };
  const secret = useIdentitySecret(address, saving);
  const form = useProfileForm(own.state === "ready" ? own.profile : null, secret.pending, secret.secret !== null);
  const verification = useVerification(address, reload, form.dirty);
  useUnsaved("avatar", changingAvatar);
  useUnsaved("profile", form.dirty);

  /** Everything that changed, in one `update_profile`: one signature. */
  async function saveProfile() {
    const ready = form.toSave();
    if ("problem" in ready) return setStatus({ section: "profile", state: "error", message: ready.problem });
    const storesSecret = ready.update.secretBlob !== undefined;
    if (await save("profile", () => updateProfileCall(ready.update, secret.secret))) {
      if (storesSecret) secret.stored();
    }
  }
  function cancel() {
    setStatus(null);
    form.reset();
    secret.discard();
    setChangingAvatar(false);
  }

  if (own.state === "loading") return <ProfileSkeleton />;
  if (own.state === "failed") {
    return (
      <MessageCard
        label="Not available"
        action={
          <button class="button" type="button" onClick={retry}>
            Try again
          </button>
        }
      >
        {own.message}
      </MessageCard>
    );
  }

  const { profile } = own;
  const key = publicKeyOf(address);
  const { title, titleIsAddress } = profile ? headline(profile) : { title: shorten(address), titleIsAddress: true };
  // the avatar as it will be: a new one chosen, removed, or the one on chain
  const avatar = form.avatar === undefined ? (profile?.avatar ?? null) : form.avatar;
  return (
    <Card edit label="My identity" busy={pending}>
      <fieldset class="editor" disabled={pending}>
        <div class="head">
          {avatar ? (
            <ChainAvatar webp={avatar} publicKey={key} size={56} label="Your avatar" />
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
        {profile === null && <p class="hint">You have no identity yet. Fill in what you want to show, then save: the first save creates it.</p>}

        <section class="block" aria-label="Avatar">
          {changingAvatar ? (
            <AvatarEditor
              pending={pending}
              onCancel={() => {
                setChangingAvatar(false);
                requestAnimationFrame(() => document.getElementById("change-avatar")?.focus());
              }}
              onSave={(webp) => {
                // the image goes with the next Save, like everything else in the form
                saving.touch("profile");
                form.setAvatar(webp);
                return Promise.resolve(true);
              }}
            />
          ) : (
            <div class="actions">
              <button id="change-avatar" class="button" type="button" onClick={() => setChangingAvatar(true)}>
                {avatar ? "Change avatar" : "Add an avatar"}
              </button>
              {avatar && (
                <button
                  class="button"
                  type="button"
                  onClick={() => {
                    saving.touch("profile");
                    form.setAvatar(profile?.avatar ? null : undefined);
                  }}
                >
                  Remove avatar
                </button>
              )}
              {form.avatar !== undefined && (
                <IconButton label="Undo the avatar change" onClick={() => form.setAvatar(undefined)}>
                  <UndoIcon />
                </IconButton>
              )}
            </div>
          )}
        </section>

        <BioSection form={form} saving={saving} />
        <FieldsSection profile={profile} form={form} saving={saving} secret={secret} wallet={wallet} address={address} verification={verification} />
        <DocumentRow profile={profile} address={address} wallet={wallet} verification={verification} />
        <LinksSection form={form} saving={saving} />

        <SaveBar form={form} saving={saving} count={updateSize(form.update)} onSave={() => void saveProfile()} onCancel={cancel} />

        {profile && (
          <a class="quiet-link" href={profilePath(profile.name, address)}>
            View your public profile
          </a>
        )}
      </fieldset>
    </Card>
  );
}
