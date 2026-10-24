// Private fields in the editor: the identity secret they need, and what can be done with a private
// field already on chain (reveal it, or make its verification packet).
//
// The secret is read (encrypted) from the chain, opened with the passphrase and then kept in memory
// for this visit only (crypto/session.ts). The passphrase lives in an input until it is used, then
// the input is emptied. A private value is typed again each time it is needed: the chain does not
// have it, and this page keeps none.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { stringToU8a, u8aEq } from "@polkadot/util";
import { connect } from "../chain/api.ts";
import { revealFieldCall } from "../chain/calls.ts";
import { type FieldDraft, parsePgp } from "../chain/edit.ts";
import { privateCommitment } from "../chain/formulas.ts";
import { identitySecret } from "../chain/identity.ts";
import { makePacket, type VerificationPacket } from "../chain/packet.ts";
import { Refusal, sentenceOf } from "../chain/refusal.ts";
import { fieldSalt, newSecret, openSecret, passphraseProblem, sealSecret, SecretError } from "../crypto/secret.ts";
import { forgetSecret, keepSecret, unlockedSecret } from "../crypto/session.ts";
import { CopyButton } from "../ui/copy.tsx";
import { IconButton, LockIcon, UndoIcon } from "../ui/icons.tsx";
import type { WalletModule } from "../ui/lazy-wallet.ts";
import { type Saving, StatusLine } from "./me-sections.tsx";

export type SecretState =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "none" }
  | { phase: "locked"; blob: Uint8Array }
  | { phase: "unlocked"; blob: Uint8Array; secret: Uint8Array }
  /** Made here and not on chain yet: it goes with the next Save, with the private fields it salts.
   * `was`: what the chain held before (a replaced secret), to go back to on Cancel. */
  | { phase: "new"; blob: Uint8Array; secret: Uint8Array; was: SecretState };

export interface IdentitySecret {
  state: SecretState;
  /** The unlocked secret, or `null`. */
  secret: Uint8Array | null;
  /** Open the secret on chain; a sentence if that failed. */
  unlock(passphrase: string): Promise<string | null>;
  /** Make a new secret and encrypt it with `passphrase`; it is stored by the next Save. `replace`:
   * the person chose to replace the secret they have (forgotten passphrase). A sentence if it
   * cannot be made (another device stored one meanwhile). */
  create(passphrase: string, replace?: boolean): Promise<string | null>;
  /** The new secret, encrypted, while it waits for the Save; `null` otherwise. */
  pending: Uint8Array | null;
  /** The Save stored the new secret: keep it unlocked for this visit. */
  stored(): void;
  /** Cancel: drop the new secret. */
  discard(): void;
  lock(): void;
  retry(): void;
}

const stateOf = (address: string, blob: Uint8Array | null): SecretState => {
  if (blob === null) return { phase: "none" };
  const secret = unlockedSecret(address, blob);
  return secret ? { phase: "unlocked", blob, secret } : { phase: "locked", blob };
};

/** The identity secret of `address`: read from the chain, unlocked on demand. */
export function useIdentitySecret(address: string, saving: Pick<Saving, "save">): IdentitySecret {
  const [state, setState] = useState<SecretState>({ phase: "loading" });
  const latest = useRef(0);
  const load = async () => {
    const ticket = ++latest.current;
    setState({ phase: "loading" });
    try {
      const blob = await identitySecret(address);
      if (ticket === latest.current) setState(stateOf(address, blob));
    } catch {
      if (ticket === latest.current) setState({ phase: "failed" });
    }
  };
  useEffect(() => {
    void load();
    return () => void latest.current++;
  }, [address]);

  async function unlock(passphrase: string): Promise<string | null> {
    if (state.phase !== "locked") return null;
    const { blob } = state;
    try {
      const secret = await openSecret(blob, passphrase);
      keepSecret(address, blob, secret);
      setState({ phase: "unlocked", blob, secret });
      return null;
    } catch (error) {
      return error instanceof SecretError ? error.message : "The identity secret could not be opened.";
    }
  }

  async function create(passphrase: string, replace = false): Promise<string | null> {
    const known = state.phase === "locked" || state.phase === "unlocked" ? state.blob : null;
    try {
      // another device may have stored a secret since this page read it: never overwrite one the
      // person did not choose to replace
      const now = await identitySecret(address);
      if (now !== null && !(replace && known !== null && u8aEq(now, known))) {
        ++latest.current;
        setState(stateOf(address, now));
        return "An identity secret was saved meanwhile, from another device. Unlock it with its passphrase.";
      }
      const secret = newSecret();
      const blob = await sealSecret(secret, passphrase);
      setState({ phase: "new", blob, secret, was: state.phase === "new" ? state.was : state });
      return null;
    } catch (error) {
      return sentenceOf(error, "The identity secret could not be made. Try again.");
    }
  }

  return {
    state,
    secret: state.phase === "unlocked" || state.phase === "new" ? state.secret : null,
    unlock,
    create,
    pending: state.phase === "new" ? state.blob : null,
    stored: () => {
      if (state.phase !== "new") return;
      keepSecret(address, state.blob, state.secret);
      setState({ phase: "unlocked", blob: state.blob, secret: state.secret });
    },
    discard: () => {
      if (state.phase === "new") setState(state.was);
    },
    lock: () => {
      forgetSecret(address);
      if (state.phase === "unlocked") setState({ phase: "locked", blob: state.blob });
    },
    retry: () => void load(),
  };
}

/** Enter in a field of these blocks does what their main button does (they are not forms: they sit
 * inside the editor's own sections). */
export const onEnter = (action: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    action();
  }
};

function Passphrase({
  id,
  label,
  value,
  onInput,
  autoFocus,
  onSubmit,
}: {
  id: string;
  label: string;
  value: string;
  onInput(v: string): void;
  autoFocus?: boolean;
  onSubmit?(): void;
}) {
  return (
    <>
      <label class="label" for={id}>
        {label}
      </label>
      <input
        id={id}
        class="input"
        type="password"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={value}
        autoFocus={autoFocus}
        onKeyDown={onSubmit && onEnter(onSubmit)}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
    </>
  );
}

/** Where the person creates, unlocks or locks the identity secret. */
/** `stranded`: the identity already has private fields, which a new secret would leave unprovable. */
export function SecretBlock({ secret, saving, stranded = false }: { secret: IdentitySecret; saving: Saving; stranded?: boolean }) {
  const { state } = secret;
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const clear = () => {
    setPass("");
    setRepeat("");
    setProblem(null);
  };
  // a sentence that must outlive the change of phase it comes with (a secret found on chain while
  // creating one sends the block to Unlock, with the reason)
  const carried = useRef<string | null>(null);
  // Reset only on a real change of phase: running on mount too would wipe the first keys typed.
  const phase = useRef(state.phase);
  useEffect(() => {
    if (phase.current === state.phase) return;
    phase.current = state.phase;
    clear();
    setProblem(carried.current);
    carried.current = null;
    setReplacing(false);
  }, [state.phase]);

  const wrap = (children: ComponentChildren) => (
    <div class="secret" role="group" aria-label="Identity secret">
      {children}
    </div>
  );
  const typing = (set: (v: string) => void) => (v: string) => {
    saving.touch("secret");
    setProblem(null);
    set(v);
  };

  if (state.phase === "loading") return wrap(<p class="hint">Reading your identity secret</p>);
  if (state.phase === "failed") {
    return wrap(
      <>
        <p class="problem">Your identity secret could not be read.</p>
        <div class="actions">
          <button class="button" type="button" onClick={secret.retry}>
            Try again
          </button>
        </div>
      </>,
    );
  }
  if (state.phase === "new") {
    return wrap(
      <div class="actions">
        <p class="status">New identity secret, stored with your next Save</p>
        <IconButton label="Undo the new identity secret" onClick={secret.discard}>
          <UndoIcon />
        </IconButton>
      </div>,
    );
  }
  if (state.phase === "unlocked") {
    return wrap(
      <div class="actions">
        <p class="status">Identity secret unlocked</p>
        <IconButton label="Lock the identity secret" onClick={secret.lock}>
          <LockIcon />
        </IconButton>
      </div>,
    );
  }
  if (state.phase === "locked" && !replacing) {
    const unlock = async () => {
      if (pass === "") return setProblem("Enter your passphrase.");
      setBusy(true);
      const failed = await secret.unlock(pass);
      setBusy(false);
      if (failed) {
        setPass("");
        setProblem(failed);
      }
    };
    return wrap(
      <>
        <p class="hint">Your private fields need your identity secret. Enter its passphrase to unlock it for this visit.</p>
        <Passphrase id="secret-pass" label="Passphrase" value={pass} onInput={typing(setPass)} onSubmit={() => void (busy || saving.pending || unlock())} />
        {problem && (
          <p class="problem" role="alert">
            {problem}
          </p>
        )}
        <div class="actions">
          <button class="button primary" type="button" disabled={busy || saving.pending} onClick={() => void unlock()}>
            Unlock
          </button>
          {busy && <p class="status">Unlocking</p>}
          <button class="quiet" type="button" disabled={busy || saving.pending} onClick={() => setReplacing(true)}>
            Forgot your passphrase?
          </button>
          <StatusLine saving={saving} section="secret" />
        </div>
      </>,
    );
  }

  const trouble = passphraseProblem(pass, repeat);
  const create = async () => {
    if (trouble) return setProblem(trouble);
    const failed = await secret.create(pass, replacing);
    if (failed) {
      carried.current = failed;
      setProblem(failed);
    } else clear();
  };
  return wrap(
    <>
      {replacing ? (
        <p class="hint">
          A new secret replaces the old one. Private fields saved with the old one can no longer be revealed or verified: remove them and add them
          again.
        </p>
      ) : stranded ? (
        <p class="hint">
          Private fields need an identity secret, and yours has none. Private fields saved without it can no longer be revealed or verified: remove
          them and add them again.
        </p>
      ) : (
        <p class="hint">
          Private fields need an identity secret. It is stored on chain, encrypted with a passphrase you choose. Without the passphrase, your
          private fields cannot be revealed or verified, by anyone.
        </p>
      )}
      <Passphrase id="secret-new" label="Passphrase" value={pass} onInput={typing(setPass)} />
      <Passphrase id="secret-repeat" label="Repeat passphrase" value={repeat} onInput={typing(setRepeat)} onSubmit={() => void (saving.pending || create())} />
      {problem && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="actions">
        <button class="button" type="button" disabled={saving.pending} onClick={() => void create()}>
          {replacing ? "Create a new secret" : "Create secret"}
        </button>
        {replacing && (
          <button class="button" type="button" disabled={saving.pending} onClick={() => setReplacing(false)}>
            Cancel
          </button>
        )}
        <StatusLine saving={saving} section="secret" />
      </div>
    </>,
  );
}

export type PanelKind = "reveal" | "packet";

/** A salt is fixed per field: once given away, a new private value in the same field can be guessed. */
export const REUSE_HINT = "Once this packet is sent, do not keep another private value in this field: it could be guessed.";

/** The bytes of a private value as typed again, or a sentence. */
function typedValue(draft: FieldDraft, text: string): Uint8Array | string {
  const trimmed = text.trim();
  if (trimmed === "") return "Type the value of the field.";
  const isPgp = "typed" in draft.ref && draft.ref.typed === "Pgp";
  if (!isPgp) return stringToU8a(trimmed);
  return parsePgp(trimmed) ?? "A PGP fingerprint has 40 or 64 hexadecimal characters.";
}

const MISMATCH = "That is not the value of this field, or it was saved with another identity secret.";

/** The value typed again for a private field and its salt, if they give the field's commitment;
 * otherwise the sentence to show. */
export function checkPrivateValue(draft: FieldDraft, text: string, secret: Uint8Array): { value: Uint8Array; salt: Uint8Array } | string {
  const value = typedValue(draft, text);
  if (typeof value === "string") return value;
  const salt = fieldSalt(secret, draft.ref);
  if (privateCommitment(salt, value) !== draft.original?.commitment) return MISMATCH;
  return { value, salt };
}

/** The verification packet of a private field, signed by the wallet (one message signature). */
export async function signedPacket(wallet: WalletModule, address: string, draft: FieldDraft, value: Uint8Array, salt: Uint8Array): Promise<VerificationPacket> {
  const { signer } = await wallet.signerFor(address);
  if (!signer.signRaw) throw new Refusal("This wallet cannot sign a message.");
  const chain = (await connect()).genesisHash.toHex();
  const signRaw = signer.signRaw;
  return makePacket({ chain, address, ref: draft.ref, value, salt }, async (data) => (await signRaw({ address, data, type: "bytes" })).signature);
}

/** What to say when the wallet did not sign: a sentence of the app as is, a wallet's own text only
 * to tell a cancellation. */
export function walletProblem(error: unknown, otherwise: string): string {
  const cancelled = !(error instanceof Refusal) && error instanceof Error && /cancel|reject/i.test(error.message);
  return cancelled ? "Cancelled in the wallet." : sentenceOf(error, otherwise);
}

/** Under a private field: reveal it, or make its verification packet. Both start by checking the
 * value typed against the field's commitment, here, before the wallet is asked anything. */
export function PrivatePanel({
  kind,
  draft,
  secret,
  saving,
  wallet,
  address,
  onClose,
}: {
  kind: PanelKind;
  draft: FieldDraft;
  secret: IdentitySecret;
  saving: Saving;
  wallet: WalletModule;
  address: string;
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [packet, setPacket] = useState<VerificationPacket | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = `${kind}-${draft.id}`;

  if (!secret.secret) return <SecretBlock secret={secret} saving={saving} stranded />;
  const key = secret.secret;

  /** The value and its salt, if they give the field's commitment. */
  const checked = (): { value: Uint8Array; salt: Uint8Array } | null => {
    const found = checkPrivateValue(draft, text, key);
    if (typeof found === "string") return void setProblem(found), null;
    return found;
  };

  async function reveal() {
    const ok = checked();
    if (!ok) return;
    if (await saving.save("fields", () => revealFieldCall(draft.ref, ok.value, ok.salt))) onClose();
  }

  async function makeOne() {
    const ok = checked();
    if (!ok) return;
    setBusy(true);
    try {
      setPacket(await signedPacket(wallet, address, draft, ok.value, ok.salt));
      setText("");
    } catch (error) {
      setProblem(walletProblem(error, "The wallet did not sign the packet."));
    } finally {
      setBusy(false);
    }
  }

  if (packet) {
    const json = JSON.stringify(packet, null, 2);
    return (
      <div class="panel" role="group" aria-label={`Verification packet for ${draft.label}`}>
        <div class="panel-head">
          <label class="label" for={id}>
            Verification packet
          </label>
          <CopyButton text={json} what="packet" onResult={(done) => setFailed(!done)} />
        </div>
        <textarea id={id} class="input packet" rows={8} readOnly value={json} spellcheck={false} />
        {failed && <p class="problem">Copy failed. Select the packet and copy it by hand.</p>}
        <p class="hint">Send it to the authority that verifies this field, and to no one else: it holds the value.</p>
        <p class="hint">{REUSE_HINT}</p>
        <div class="actions">
          <button class="button" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="panel" role="group" aria-label={kind === "reveal" ? `Reveal ${draft.label}` : `Verification packet for ${draft.label}`}>
      <label class="label" for={id}>
        Value of {draft.label}
      </label>
      <input
        id={id}
        class="input"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={text}
        aria-invalid={problem !== null || undefined}
        onKeyDown={onEnter(() => void (saving.pending || busy || (kind === "reveal" ? reveal() : makeOne())))}
        onInput={(e) => {
          saving.touch("fields");
          setProblem(null);
          setText(e.currentTarget.value);
        }}
      />
      <p class="hint">
        {kind === "reveal"
          ? "Revealing makes the value public. A verification of it stays valid."
          : "The packet holds the value and its salt, signed by your wallet, for the authority that verifies the field."}
      </p>
      {problem && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="actions">
        <button class="button primary" type="button" disabled={saving.pending || busy} onClick={() => void (kind === "reveal" ? reveal() : makeOne())}>
          {kind === "reveal" ? "Reveal" : "Create packet"}
        </button>
        <button class="button" type="button" disabled={saving.pending || busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
