// Verifying a field from /me: the panel that opens under a saved field (one channel each), the
// identity document row, and what the page says once the service has attested.
//
// The service (chain/verify.ts) checks the proof and writes the attestation itself: no transaction
// from the person. A private field first needs its verification packet (one wallet message
// signature), which goes to the service with the request. What the page then shows as verified is
// what the chain says, read again every few seconds until the attestation is there.
//
// What happens is said twice: in words on the page, and through one live region that stays mounted
// (progress and results), so a screen reader hears each step.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { stringToU8a, u8aToHex } from "@polkadot/util";
import { toIdentitee } from "../chain/address.ts";
import { connect } from "../chain/api.ts";
import type { FieldDraft } from "../chain/edit.ts";
import { FIELD_LABELS, type FieldKind, type Profile, readProfile } from "../chain/identity.ts";
import type { VerificationPacket } from "../chain/packet.ts";
import { Refusal } from "../chain/refusal.ts";
import {
  type Channels,
  type KycStatus,
  type OAuthProvider,
  emailCheck,
  emailSend,
  kindOfChannel,
  kycMessage,
  kycStart,
  kycStatus,
  matrixCheck,
  matrixStart,
  oauthStartUrl,
  pgpChallenge,
  pgpVerify,
  readChannels,
  storePacket,
  telegramCheck,
  telegramStart,
  verifierOrigin,
  verifySentence,
  webCheck,
} from "../chain/verify.ts";
import { CopyButton } from "../ui/copy.tsx";
import { IconButton, XIcon } from "../ui/icons.tsx";
import type { WalletModule } from "../ui/lazy-wallet.ts";
import { checkPrivateValue, type IdentitySecret, onEnter, SecretBlock, signedPacket, walletProblem } from "./me-private.tsx";
import type { Saving } from "./me-sections.tsx";
import { State } from "./profile.tsx";

/** How often the chain is read again after a verification, and for how long. */
export const WATCH_EVERY_MS = 3_000;
export const WATCH_FOR_MS = 120_000;
/** How long the chain is read after a sign-in window went quiet: the person may still be signing in
 * (a provider such as X cuts the window from this page as soon as it opens, so it reads as closed). */
export const SIGN_IN_FOR_MS = 10 * 60_000;
export const AWAY = "Finish the sign-in in the other window.";
/** How often an identity check under way is looked at again, and for how long. */
export const KYC_EVERY_MS = 5_000;
export const KYC_FOR_MS = 15 * 60_000;
export const SLOW = "Verified. It may take a moment to show.";
export const WINDOW_CLOSED = "The sign-in window closed. If you finished, your field shows as verified in a moment; otherwise try again.";
/** The answers after which only a new start helps: the panel offers "Start again". */
const RESTART = ["This code has expired. Ask for a new one.", "Too many wrong codes. Ask for a new one."];
const PLAIN_WEBSITE = "Write your website as a plain address, like example.com.";

/** The page leaves for the service in this tab (a phone): this mark, kept in the tab, lets the page
 * trust what the service sends back in the address (a link from elsewhere cannot set it). */
const RETURN_MARK = "identitee-verify-return";

/** A phone: a full page sign-in rather than a window, and Didit in this tab. */
export function isPhone(): boolean {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse || window.innerWidth < 640;
}

const markReturn = (what: string) => {
  try {
    sessionStorage.setItem(RETURN_MARK, what);
  } catch {
    // without it the page says nothing on return; the chain still shows what happened
  }
};

const hasDocument = (profile: Profile | null): boolean => profile?.facts.some((f) => f.kind === "DocumentChecked" && f.active) ?? false;
const showsVerified = (profile: Profile | null, kind: FieldKind): boolean =>
  profile?.fields.some((f) => "typed" in f.ref && f.ref.typed === kind && f.verified) ?? false;

export type Notice = { tone: "status" | "problem"; text: string; where: "fields" | "document" };

export interface Verification {
  /** The channels the service offers; `null` until read (or when the service cannot be reached). */
  channels: Channels | null;
  notice: Notice | null;
  /** What the live region says now; `seq` changes with each announcement, even a repeated one. */
  live: { text: string; seq: number };
  /** The service attested `kind`: say so and read the chain until it shows. */
  verified(kind: FieldKind): void;
  /** A sign-in window closed without a word (a provider can cut the link to this page, the sign-in
   * may still be going on): read the chain for up to 10 minutes. `then(found)` lets an open panel say
   * the outcome itself (it returns true). Returns a way to stop reading. */
  afterSignIn(kind: FieldKind, then: (found: boolean) => boolean): () => void;
  say(notice: Notice | null): void;
  announce(text: string): void;
  /** Read the identity into the form again, unless it has unsaved changes. */
  refresh(): Promise<void>;
}

/** The verification state of /me: the channels, the line it says, the live region, and the watch
 * after a success. `reload` reads the identity again into the form; it is only called while the form
 * has no unsaved changes (reading wipes them). */
export function useVerification(address: string, reload: () => Promise<boolean>, dirty: boolean): Verification {
  const [channels, setChannels] = useState<Channels | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [live, setLive] = useState({ text: "", seq: 0 });
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  const watching = useRef(0);

  const announce = (text: string) => setLive((now) => ({ text, seq: now.seq + 1 }));
  const say = (next: Notice | null) => {
    setNotice(next);
    if (next) announce(next.text);
  };
  const refresh = async () => {
    if (!dirtyNow.current) await reload();
  };

  useEffect(() => {
    let alive = true;
    readChannels().then(
      (found) => alive && setChannels(found),
      () => undefined,
    );
    return () => {
      alive = false;
      watching.current++;
    };
  }, []);

  /** Read the chain every 3 s for `forMs` (2 min) until `kind` shows verified. Returns a stop. */
  function watch(kind: FieldKind, onFound: () => void, onTimeout: () => void, forMs = WATCH_FOR_MS): () => void {
    const ticket = ++watching.current;
    const until = Date.now() + forMs;
    const step = async () => {
      if (ticket !== watching.current) return;
      let profile: Profile | null = null;
      try {
        profile = await readProfile(address);
      } catch {
        // read again at the next step
      }
      if (ticket !== watching.current) return;
      if (showsVerified(profile, kind)) {
        await refresh();
        onFound();
        // the row's Verify button is gone with the reload: its label takes the focus it had
        requestAnimationFrame(() => {
          if (document.activeElement === document.body || document.activeElement === null) document.getElementById(`label-typed:${kind}`)?.focus();
        });
        return;
      }
      if (Date.now() >= until) return onTimeout();
      setTimeout(() => void step(), WATCH_EVERY_MS);
    };
    void step();
    return () => {
      if (watching.current === ticket) watching.current++;
    };
  }

  function verified(kind: FieldKind) {
    say({ tone: "status", text: `${FIELD_LABELS[kind]} verified.`, where: "fields" });
    watch(kind, () => undefined, () => say({ tone: "status", text: SLOW, where: "fields" }));
  }

  function afterSignIn(kind: FieldKind, then: (found: boolean) => boolean): () => void {
    announce(AWAY);
    return watch(
      kind,
      () => {
        say({ tone: "status", text: `${FIELD_LABELS[kind]} verified.`, where: "fields" });
        then(true);
      },
      () => {
        if (!then(false)) say({ tone: "status", text: WINDOW_CLOSED, where: "fields" });
        else announce(WINDOW_CLOSED);
      },
      SIGN_IN_FOR_MS,
    );
  }

  // the service sends a page back here: a phone after a sign-in or Didit, or a sign-in window whose
  // link to this page was cut
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const channel = query.get("verified");
    const error = query.get("verify_error");
    const kyc = query.get("kyc");
    if (channel === null && error === null && kyc === null) return;
    const kind = channel === null ? null : kindOfChannel(channel);

    // a sign-in window that came back here: hand the answer to the page that opened it, and close
    const opener = window.opener as Window | null;
    if (opener && opener !== window && (kind || error !== null)) {
      let same = false;
      try {
        same = opener.location.origin === location.origin;
      } catch {
        // another origin: not ours to talk to
      }
      if (same) {
        opener.postMessage(kind ? { type: "identitee-verified", channel } : { type: "identitee-verify-error", message: error }, location.origin);
        window.close();
        return;
      }
    }

    let expected = false;
    try {
      expected = sessionStorage.getItem(RETURN_MARK) !== null;
      sessionStorage.removeItem(RETURN_MARK);
    } catch {
      // no storage: nothing in the address is believed, the chain still says what happened
    }
    for (const key of ["verified", "verify_error", "kyc"]) query.delete(key);
    // Didit adds its own parameters to the return (verificationSessionId, status…): /me has none of
    // its own, so all of them go
    const rest = kyc === null ? query.toString() : "";
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    if (kind && expected) verified(kind);
    // not sent from this tab (a link, or a window cut from its opener): said only once the chain shows it
    else if (kind) watch(kind, () => say({ tone: "status", text: `${FIELD_LABELS[kind]} verified.`, where: "fields" }), () => undefined);
    else if (error !== null && expected) say({ tone: "problem", text: error.slice(0, 300), where: "fields" });
    else if (kyc === "done") say({ tone: "status", text: "Your identity document is being checked.", where: "document" });
  }, []);

  return { channels, notice, live, verified, afterSignIn, say, announce, refresh };
}

/** The one live region of the verification: always mounted, so that what it is given is read out
 * (a region that appears together with its text is often not). */
export function LiveRegion({ verification }: { verification: Verification }) {
  const [shown, setShown] = useState("");
  const { text, seq } = verification.live;
  useEffect(() => {
    setShown("");
    if (text === "") return;
    const timer = setTimeout(() => setShown(text), 50);
    return () => clearTimeout(timer);
  }, [seq]);
  return (
    <p class="visually-hidden" role="status" id="verify-live">
      {shown}
    </p>
  );
}

/** The line a notice of `where` makes, if there is one (read out by the live region). */
export function NoticeLine({ verification, where }: { verification: Verification; where: Notice["where"] }) {
  const { notice } = verification;
  if (!notice || notice.where !== where) return null;
  return <p class={`${notice.tone === "problem" ? "problem" : "status"} verify-notice`}>{notice.text}</p>;
}

// --- Pieces of a panel ------------------------------------------------------------------------

type Announce = (text: string) => void;

function Problem({ text }: { text: string | null }) {
  return text ? <p class="problem">{text}</p> : null;
}

/** A sentence for the panel, said also through the live region. */
function useProblem(announce: Announce): [string | null, (text: string | null) => void] {
  const [problem, setProblem] = useState<string | null>(null);
  return [
    problem,
    (text) => {
      setProblem(text);
      if (text) announce(text);
    },
  ];
}

/** Something to copy exactly (a command, a file address, a DNS value), with its Copy button.
 * `children`: how it shows, when that differs from the text (a part kept on one line). */
function Copyable({ text, what, children }: { text: string; what: string; children?: ComponentChildren }) {
  return (
    <div class="copyable">
      <span class="copyable-text">{children ?? text}</span>
      <CopyButton text={text} what={what} />
    </div>
  );
}

/** The 6-digit code the person types back, and Confirm. `onRestart`: offered when the code expired. */
function CodeEntry({
  id,
  announce,
  onConfirm,
  onRestart,
  disabled = false,
  focus = false,
}: {
  id: string;
  announce: Announce;
  onConfirm(code: string): Promise<string | null>;
  onRestart?(): void;
  disabled?: boolean;
  /** Take the focus on arrival (the code was just sent). */
  focus?: boolean;
}) {
  const [code, setCode] = useState("");
  useEffect(() => {
    if (focus) document.getElementById(id)?.focus();
  }, []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  const confirm = async () => {
    if (busy || disabled) return;
    if (!/^\d{6}$/.test(code.replace(/\s+/g, ""))) return setProblem("Enter the 6-digit code.");
    setBusy(true);
    announce("Checking…");
    const failed = await onConfirm(code.replace(/\s+/g, ""));
    setBusy(false);
    if (failed) setProblem(failed);
  };
  return (
    <>
      <label class="label" for={id}>
        Code
      </label>
      <div class="code-row">
        <input
          id={id}
          class="input code"
          type="text"
          inputMode="numeric"
          autocomplete="one-time-code"
          maxLength={7}
          spellcheck={false}
          disabled={disabled}
          value={code}
          onKeyDown={onEnter(() => void confirm())}
          onInput={(e) => {
            setProblem(null);
            setCode(e.currentTarget.value);
          }}
        />
        <button class="button primary" type="button" disabled={disabled || busy} onClick={() => void confirm()}>
          Confirm
        </button>
      </div>
      <Problem text={problem} />
      {onRestart && problem !== null && RESTART.includes(problem) && (
        <div class="actions">
          <button class="button" type="button" onClick={onRestart}>
            Start again
          </button>
        </div>
      )}
    </>
  );
}

/** A start call made when the panel opens (Telegram, Matrix, PGP): its answer, or a sentence and a
 * way to try again. */
function useStart<T>(start: () => Promise<T>, announce: Announce) {
  const [state, setState] = useState<{ phase: "starting" } | { phase: "ready"; value: T } | { phase: "failed"; problem: string }>({ phase: "starting" });
  const run = () => {
    setState({ phase: "starting" });
    start().then(
      (value) => setState({ phase: "ready", value }),
      (error: unknown) => {
        const problem = verifySentence(error);
        announce(problem);
        setState({ phase: "failed", problem });
      },
    );
  };
  useEffect(run, []);
  return { state, retry: run };
}

function Starting({ state, retry }: { state: { phase: "starting" } | { phase: "failed"; problem: string }; retry(): void }) {
  if (state.phase === "starting") return <p class="status">Preparing</p>;
  return (
    <>
      <Problem text={state.problem} />
      <div class="actions">
        <button class="button" type="button" onClick={retry}>
          Try again
        </button>
      </div>
    </>
  );
}

interface ChannelProps {
  address: string;
  draft: FieldDraft;
  kind: FieldKind;
  /** The private field's packet; absent for a public field. */
  packet?: VerificationPacket;
  verification: Verification;
  /** The service attested: the panel closes and the page says so. */
  onVerified(): void;
  /** Close the panel, nothing more. */
  close(): void;
}

/** A check answered: `null` once verified (the panel is told), else the sentence. */
const settle = async (check: Promise<unknown>, onVerified: () => void): Promise<string | null> => {
  try {
    await check;
    onVerified();
    return null;
  } catch (error) {
    return verifySentence(error);
  }
};

// --- Channels ---------------------------------------------------------------------------------

function EmailPanel({ address, draft, packet, verification, onVerified }: ChannelProps) {
  const { announce } = verification;
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  const send = async () => {
    setBusy(true);
    setProblem(null);
    announce("Sending…");
    try {
      setSession((await emailSend(address, packet)).session);
      announce("Code sent.");
    } catch (error) {
      setProblem(verifySentence(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p class="hint">{session ? "A code is on its way to the email on your identity. It is valid for 10 minutes." : "A 6-digit code goes to the email on your identity."}</p>
      {session && <CodeEntry key={session} focus id={`code-${draft.id}`} announce={announce} onConfirm={(code) => settle(emailCheck(address, session, code), onVerified)} />}
      <Problem text={problem} />
      <div class="actions">
        <button class={session ? "quiet start" : "button primary"} type="button" disabled={busy} onClick={() => void send()}>
          {session ? "Send a new code" : "Send code"}
        </button>
        {busy && <p class="status">Sending…</p>}
      </div>
    </>
  );
}

const PROVIDER_NAME: Record<OAuthProvider, string> = { x: "X", discord: "Discord", github: "GitHub" };
/** The sign-in windows open now, by provider: one flow per provider at a time. */
const signIns = new Map<OAuthProvider, Window>();

// Closing the panel closes its sign-in window too (and ends the flow): a flow nobody watches any
// more would come back to a page that no longer listens.
function OAuthPanel({ address, kind, packet, verification, onVerified, close, provider }: ChannelProps & { provider: OAuthProvider }) {
  const { announce } = verification;
  // waiting: the window is open; away: it reads as closed but the sign-in may go on (the chain decides)
  const [phase, setPhase] = useState<"idle" | "waiting" | "away">("idle");
  const [problem, setProblem] = useProblem(announce);
  const popup = useRef<Window | null>(null);
  const mounted = useRef(true);
  const stopWatching = useRef<(() => void) | null>(null);
  const name = PROVIDER_NAME[provider];

  const release = () => {
    stopWatching.current?.();
    stopWatching.current = null;
    if (popup.current && signIns.get(provider) === popup.current) signIns.delete(provider);
    popup.current = null;
  };
  const cancel = () => {
    release();
    setPhase("idle");
    announce("Cancelled.");
  };

  useEffect(() => {
    if (phase !== "waiting" && phase !== "away") return;
    const onMessage = (event: MessageEvent) => {
      // from the service's window, or from that same window once back on this site (/me?verified=)
      if ((event.origin !== verifierOrigin() && event.origin !== location.origin) || event.source !== popup.current || popup.current === null) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const { type, channel, message } = data as { type?: unknown; channel?: unknown; message?: unknown };
      if (type === "identitee-verified" && channel === provider) {
        release();
        setPhase("idle");
        onVerified();
      } else if (type === "identitee-verify-error" && typeof message === "string") {
        release();
        setPhase("idle");
        setProblem(message.slice(0, 300));
      }
    };
    // a window that reads as closed: the provider may have cut it from this page while the person
    // still signs in there (X does), so the provider stays taken and the chain decides, for 10 min
    let over = false;
    const watchClosed = setInterval(() => {
      if (over || phase !== "waiting" || !popup.current?.closed) return;
      over = true;
      clearInterval(watchClosed);
      setPhase("away");
      stopWatching.current = verification.afterSignIn(kind, (found) => {
        if (!mounted.current) return false;
        stopWatching.current = null;
        release();
        if (found) close();
        else {
          setPhase("idle");
          setProblem(WINDOW_CLOSED);
        }
        return true;
      });
    }, 600);
    window.addEventListener("message", onMessage);
    return () => {
      over = true;
      window.removeEventListener("message", onMessage);
      clearInterval(watchClosed);
    };
  }, [phase]);
  useEffect(
    () => () => {
      mounted.current = false;
      if (popup.current && !popup.current.closed) popup.current.close();
      release();
    },
    [],
  );

  async function start() {
    setProblem(null);
    const open = signIns.get(provider);
    if (open && !open.closed) return open.focus();
    if (open) return setProblem(AWAY);
    if (isPhone()) {
      try {
        const id = packet ? await storePacket(address, packet) : undefined;
        markReturn(provider);
        location.assign(oauthStartUrl(provider, address, "redirect", id));
      } catch (error) {
        setProblem(verifySentence(error));
      }
      return;
    }
    // opened at once, in the press: a window opened after waiting for the network is blocked
    const win = window.open(packet ? "about:blank" : oauthStartUrl(provider, address, "popup"), `identitee-${provider}`, "popup,width=500,height=700");
    if (!win) return setProblem("Allow pop-ups for identit.ee, then try again.");
    popup.current = win;
    signIns.set(provider, win);
    setPhase("waiting");
    announce("Waiting for the sign-in…");
    if (packet) {
      try {
        win.location.href = oauthStartUrl(provider, address, "popup", await storePacket(address, packet));
      } catch (error) {
        win.close();
        release();
        setPhase("idle");
        setProblem(verifySentence(error));
      }
    }
  }

  return (
    <>
      <p class="hint">Sign in to {name} to show that the account is yours.</p>
      <Problem text={problem} />
      <div class="actions">
        <button class="button primary" type="button" disabled={phase === "away"} onClick={() => void start()}>
          Continue with {name}
        </button>
        {phase === "waiting" && <p class="status">Waiting for the sign-in…</p>}
        {phase === "away" && (
          <>
            <p class="status">{AWAY}</p>
            <button class="button" type="button" onClick={cancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    </>
  );
}

function TelegramPanel({ address, draft, packet, verification, onVerified }: ChannelProps) {
  const { announce } = verification;
  const { state, retry } = useStart(() => telegramStart(address, packet), announce);
  const [opened, setOpened] = useState(false);
  if (state.phase !== "ready") return <Starting state={state} retry={retry} />;
  const { url, session } = state.value;
  return (
    <>
      <p class="hint">Tap Start in Telegram, then type the code the bot sends you.</p>
      <div class="actions">
        <a class={opened ? "button" : "button primary"} href={url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
          Open Telegram
        </a>
      </div>
      <CodeEntry
        key={session}
        id={`code-${draft.id}`}
        announce={announce}
        disabled={!opened}
        onConfirm={(code) => settle(telegramCheck(address, session, code), onVerified)}
        onRestart={() => {
          setOpened(false);
          retry();
        }}
      />
    </>
  );
}

function MatrixPanel({ address, draft, packet, verification, onVerified }: ChannelProps) {
  const { announce } = verification;
  const { state, retry } = useStart(() => matrixStart(address, packet), announce);
  if (state.phase !== "ready") return <Starting state={state} retry={retry} />;
  const { command, bot, session } = state.value;
  return (
    <>
      <p class="hint">
        Send this message to {bot} in a direct chat. The bot then invites you to a new private chat: accept it to receive your code.
      </p>
      <Copyable text={command} what="message" />
      <Copyable text={bot} what="bot address" />
      <CodeEntry
        key={session}
        id={`code-${draft.id}`}
        announce={announce}
        onConfirm={(code) => settle(matrixCheck(address, session, code), onVerified)}
        onRestart={retry}
      />
    </>
  );
}

/** The host of a website value, as the service reads it: ASCII (punycode), lowercase, no port. */
export function websiteHost(value: string): string | null {
  const text = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function WebPanel({ address, draft, verification, onVerified }: ChannelProps) {
  const { announce } = verification;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  const host = websiteHost(draft.original?.value ?? "");
  if (host === null) return <Problem text={PLAIN_WEBSITE} />;
  const owner = toIdentitee(address);
  const check = async () => {
    setBusy(true);
    setProblem(null);
    announce("Checking…");
    setProblem(await settle(webCheck(address), onVerified));
    setBusy(false);
  };
  return (
    <>
      <p class="hint">Put a file at this address, with your account address in it:</p>
      <Copyable text={`https://${host}/.well-known/identitee.txt`} what="file address" />
      <Copyable text={owner} what="account address" />
      <p class="hint">
        Or add a TXT record on {`_identitee.${host}`} or on {host}, with this value:
      </p>
      <Copyable text={`identitee=${owner}`} what="record value" />
      <Problem text={problem} />
      <div class="actions">
        <button class="button primary" type="button" disabled={busy} onClick={() => void check()}>
          Check
        </button>
        {busy && <p class="status">Checking…</p>}
      </div>
    </>
  );
}

const KEY_MISSING = "Your key is not on keys.openpgp.org. Paste your public key.";
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

function PgpPanel({ address, draft, packet, verification, onVerified }: ChannelProps) {
  const { announce } = verification;
  const { state, retry } = useStart(() => pgpChallenge(address, packet), announce);
  const [signed, setSigned] = useState("");
  const [key, setKey] = useState("");
  const isPrivate = packet !== undefined;
  const [askKey, setAskKey] = useState(isPrivate);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  if (state.phase !== "ready") return <Starting state={state} retry={retry} />;
  const { challenge, session } = state.value;
  const verify = async () => {
    if (signed.trim() === "") return setProblem("Paste the signed challenge.");
    if (isPrivate && key.trim() === "") return setProblem("Paste your public key to verify a private PGP.");
    setBusy(true);
    setProblem(null);
    announce("Checking…");
    const failed = await settle(pgpVerify({ address, session, signed, key: key.trim() || undefined, packet }), onVerified);
    setBusy(false);
    if (failed === KEY_MISSING) setAskKey(true);
    setProblem(failed);
  };
  const quoted = shellQuote(challenge);
  return (
    <>
      <p class="hint">Sign this challenge with your PGP key, then paste the whole output.</p>
      <Copyable text={`echo ${quoted} | gpg --clearsign`} what="command">
        echo {quoted} | gpg <span class="nowrap">--clearsign</span>
      </Copyable>
      <label class="label" for={`signed-${draft.id}`}>
        Signed challenge
      </label>
      <textarea
        id={`signed-${draft.id}`}
        class="input packet"
        rows={6}
        spellcheck={false}
        value={signed}
        onInput={(e) => {
          setProblem(null);
          setSigned(e.currentTarget.value);
        }}
      />
      {askKey ? (
        <>
          <label class="label" for={`key-${draft.id}`}>
            Public key
          </label>
          <textarea
            id={`key-${draft.id}`}
            class="input packet"
            rows={4}
            spellcheck={false}
            value={key}
            onInput={(e) => {
              setProblem(null);
              setKey(e.currentTarget.value);
            }}
          />
          <p class="hint">{isPrivate ? "Your public key is needed: a private fingerprint is never looked up on a keyserver." : "Only needed if your key is not on keys.openpgp.org."}</p>
        </>
      ) : (
        <button class="quiet start" type="button" onClick={() => setAskKey(true)}>
          Paste your public key instead
        </button>
      )}
      <Problem text={problem} />
      <div class="actions">
        <button class="button primary" type="button" disabled={busy} onClick={() => void verify()}>
          Verify
        </button>
        {busy && <p class="status">Checking…</p>}
      </div>
    </>
  );
}

// --- The panel --------------------------------------------------------------------------------

/** The value of a private field typed again, then its packet signed by the wallet. */
function PacketStep({
  draft,
  secret,
  saving,
  wallet,
  address,
  announce,
  onPacket,
}: {
  draft: FieldDraft;
  secret: IdentitySecret;
  saving: Saving;
  wallet: WalletModule;
  address: string;
  announce: Announce;
  onPacket(packet: VerificationPacket): void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  if (!secret.secret) return <SecretBlock secret={secret} saving={saving} stranded />;
  const key = secret.secret;
  const id = `verify-value-${draft.id}`;
  const next = async () => {
    if (busy) return;
    const found = checkPrivateValue(draft, text, key);
    if (typeof found === "string") return setProblem(found);
    setBusy(true);
    try {
      const packet = await signedPacket(wallet, address, draft, found.value, found.salt);
      setText("");
      onPacket(packet);
    } catch (error) {
      setProblem(walletProblem(error, "The wallet did not sign the packet."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
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
        onKeyDown={onEnter(() => void next())}
        onInput={(e) => {
          setProblem(null);
          setText(e.currentTarget.value);
        }}
      />
      <p class="hint">The value goes to the verification service in a packet your wallet signs. It is not kept.</p>
      <Problem text={problem} />
      <div class="actions">
        <button class="button primary" type="button" disabled={busy} onClick={() => void next()}>
          Continue
        </button>
      </div>
    </>
  );
}

function ChannelSteps(props: ChannelProps) {
  switch (props.kind) {
    case "Email":
      return <EmailPanel {...props} />;
    case "X":
      return <OAuthPanel {...props} provider="x" />;
    case "Discord":
      return <OAuthPanel {...props} provider="discord" />;
    case "GitHub":
      return <OAuthPanel {...props} provider="github" />;
    case "Telegram":
      return <TelegramPanel {...props} />;
    case "Matrix":
      return <MatrixPanel {...props} />;
    case "Web":
      return <WebPanel {...props} />;
    case "Pgp":
      return <PgpPanel {...props} />;
    default:
      return null;
  }
}

/** What a panel focuses once it has something to offer: its first input, else its main button. */
const FIRST = "input:not(:disabled), textarea:not(:disabled), .button.primary:not(:disabled), a.button";

/** Under a saved field: how to prove it, for its channel. */
export function VerifyPanel({
  draft,
  address,
  wallet,
  secret,
  saving,
  verification,
  onVerified,
  onClose,
}: {
  draft: FieldDraft;
  address: string;
  wallet: WalletModule;
  secret: IdentitySecret;
  saving: Saving;
  verification: Verification;
  onVerified(kind: FieldKind): void;
  onClose(): void;
}) {
  const [packet, setPacket] = useState<VerificationPacket | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // focus moves into the panel when it opens, and again when a step replaces its content (a start
  // answered, the packet signed), unless the person is already in it
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const panel = box.current;
      const active = document.activeElement;
      const inside = panel !== null && active !== null && panel.contains(active) && !active.closest(".panel-close");
      const target = panel?.querySelector<HTMLElement>(FIRST);
      if (inside || ++tries > 40) return clearInterval(timer);
      if (target) {
        target.focus();
        clearInterval(timer);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [packet === null]);

  if (!("typed" in draft.ref)) return null;
  const kind = draft.ref.typed;
  const isPrivate = draft.original?.privacy === "private";
  let body: ComponentChildren;
  if (isPrivate && kind === "Web") body = <p class="hint">Make your website public to verify it.</p>;
  else if (isPrivate && !packet) body = <PacketStep draft={draft} secret={secret} saving={saving} wallet={wallet} address={address} announce={verification.announce} onPacket={setPacket} />;
  else
    body = (
      <ChannelSteps kind={kind} address={address} draft={draft} packet={packet ?? undefined} verification={verification} onVerified={() => onVerified(kind)} close={onClose} />
    );
  return (
    <div class="panel verify" role="group" aria-label={`Verify ${draft.label}`} ref={box}>
      <span class="panel-close">
        <IconButton label={`Close the verification of ${draft.label}`} onClick={onClose}>
          <XIcon />
        </IconButton>
      </span>
      {body}
    </div>
  );
}

// --- Identity document --------------------------------------------------------------------------

/** "Identity document": checked (a DocumentChecked fact on chain), or a check with Didit, followed
 * to its end: while it is under way the page asks the service and reads the chain every 5 s, for
 * up to 15 min. */
export function DocumentRow({ profile, address, wallet, verification }: { profile: Profile | null; address: string; wallet: WalletModule; verification: Verification }) {
  const { announce } = verification;
  const [factSeen, setFactSeen] = useState(false);
  const checked = hasDocument(profile) || factSeen;
  const offered = verification.channels?.enabled.has("kyc") ?? false;
  const [status, setStatus] = useState<KycStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useProblem(announce);
  // a check under way: Didit said nothing final, or approved and the fact is not on chain yet
  const underWay = status === "pending" || status === "approved";

  useEffect(() => {
    if (checked || !offered || profile === null) return;
    let alive = true;
    kycStatus(address).then(
      (s) => alive && setStatus(s),
      () => alive && setStatus("none"),
    );
    return () => void (alive = false);
  }, [checked, offered, profile === null]);

  useEffect(() => {
    if (!underWay || checked) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + KYC_FOR_MS;
    const tick = async () => {
      if (!alive) return;
      try {
        const profileNow = await readProfile(address);
        if (!alive) return;
        if (hasDocument(profileNow)) {
          setFactSeen(true);
          announce("Your identity document is checked.");
          await verification.refresh();
          return;
        }
      } catch {
        // read again at the next tick
      }
      try {
        const now = await kycStatus(address);
        if (!alive) return;
        if (now === "declined" || now === "none") {
          if (now === "declined") announce("Your identity document check was declined.");
          // the Didit session is over: its link goes, the button comes back
          setUrl(null);
          return setStatus(now);
        }
      } catch {
        // ask again at the next tick
      }
      if (Date.now() < until) timer = setTimeout(() => void tick(), KYC_EVERY_MS);
    };
    timer = setTimeout(() => void tick(), KYC_EVERY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [underWay, checked]);

  if (profile === null || (!checked && !offered)) return null;

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      let genesis: string;
      try {
        genesis = (await connect()).genesisHash.toHex();
      } catch {
        return setProblem("The identity check could not be started. Try again in a moment.");
      }
      const message = kycMessage(genesis, toIdentitee(address), Date.now());
      let signature: string;
      try {
        const { signer } = await wallet.signerFor(address);
        if (!signer.signRaw) throw new Refusal("This wallet cannot sign a message.");
        ({ signature } = await signer.signRaw({ address, data: u8aToHex(stringToU8a(message)), type: "bytes" }));
      } catch (error) {
        return setProblem(walletProblem(error, "The wallet did not sign the request."));
      }
      announce("Starting the check…");
      let started: { url: string };
      try {
        started = await kycStart(address, message, signature);
      } catch (error) {
        return setProblem(verifySentence(error));
      }
      setStatus("pending");
      if (isPhone()) {
        markReturn("kyc");
        location.assign(started.url);
      } else {
        setUrl(started.url);
        announce("Open Didit to continue.");
        requestAnimationFrame(() => document.getElementById("open-didit")?.focus());
      }
    } finally {
      setBusy(false);
    }
  }

  const action = !checked && status !== null && url === null && status !== "approved";
  return (
    <section class="block" aria-label="Identity document">
      <div class="document-row">
        <span class="label" id="label-document" tabIndex={-1}>
          Identity document
        </span>
        <div class="control document-control">
          {checked ? (
            <p class="document-state">
              <State standing="Verified" />
              Checked
            </p>
          ) : status === null ? (
            <p class="document-state quiet-state">Reading</p>
          ) : underWay ? (
            <p class="document-state">Being checked.</p>
          ) : (
            <p class="document-state">{status === "declined" ? "Your last check was declined." : "Not checked"}</p>
          )}
          {action && (
            <button class={underWay ? "quiet" : "button small"} type="button" disabled={busy} onClick={() => void start()}>
              {underWay ? "Continue" : "Verify with Didit"}
            </button>
          )}
        </div>
        {url && !checked && (
          <div class="note-row panel">
            <p class="hint">Didit checks your document and a selfie. Open it here, or copy the link to continue on your phone.</p>
            <div class="actions">
              <a id="open-didit" class="button primary" href={url} target="_blank" rel="noopener noreferrer">
                Open Didit
              </a>
              <CopyButton text={url} what="link" />
            </div>
          </div>
        )}
        {problem && <p class="problem note-row">{problem}</p>}
        {verification.notice?.where === "document" && (
          <div class="note-row">
            <NoticeLine verification={verification} where="document" />
          </div>
        )}
      </div>
    </section>
  );
}
