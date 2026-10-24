// The verification service (verify.identit.ee): it checks a field the way its channel allows (a code
// sent by email, Telegram or Matrix, a sign-in with X, Discord or GitHub, a file or DNS record on a
// website, a PGP signature, an identity document with Didit) and then writes the attestation on
// chain itself. This is its client: plain JSON over HTTPS, every refusal a sentence for the person.
//
// What goes to the service: the account address, the codes the person types, a signed challenge,
// and for a private field its verification packet (the value is needed to check it). Nothing here
// stores any of it.

import type { FieldKind } from "./identity.ts";
import type { VerificationPacket } from "./packet.ts";

/** The public service. */
export const DEFAULT_VERIFIER = "https://verify.identit.ee";

/** What the person reads when the service cannot be reached or answers nothing usable. */
export const UNAVAILABLE = "Verification is unavailable right now. Try again in a moment.";

/** Longest wait for an answer (a website or a keyserver check takes a few seconds). */
const TIMEOUT_MS = 25_000;

/** The service this build talks to: `VITE_VERIFIER` at build time, else the public one. */
export function verifierBase(): string {
  const configured: unknown = import.meta.env.VITE_VERIFIER;
  const base = typeof configured === "string" && configured !== "" ? configured : DEFAULT_VERIFIER;
  return base.replace(/\/+$/, "");
}

/** The origin the service's sign-in windows post their message from. */
export function verifierOrigin(): string {
  return new URL(verifierBase()).origin;
}

/** A refusal of the service, as the sentence it gave, or `UNAVAILABLE`. */
export class VerifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

/** The sentence to show for anything a call threw. */
export const verifySentence = (error: unknown): string => (error instanceof VerifyError ? error.message : UNAVAILABLE);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${verifierBase()}${path}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new VerifyError(UNAVAILABLE, 0);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // an answer that is not JSON (a proxy's error page) says nothing to the person
  }
  if (!response.ok) {
    const sentence = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : "";
    throw new VerifyError(sentence !== "" ? sentence : UNAVAILABLE, response.status);
  }
  if (json === null || typeof json !== "object") throw new VerifyError(UNAVAILABLE, response.status);
  return json as T;
}

const post = <T>(path: string, body: unknown) => call<T>("POST", path, body);
const get = <T>(path: string) => call<T>("GET", path);

// --- Channels ---------------------------------------------------------------------------------

/** The channel of each typed field the service can verify. */
export const CHANNEL_OF: Partial<Record<FieldKind, Channel>> = {
  Email: "email",
  X: "x",
  Discord: "discord",
  GitHub: "github",
  Telegram: "telegram",
  Matrix: "matrix",
  Web: "web",
  Pgp: "pgp",
};

export type Channel = "email" | "x" | "discord" | "github" | "telegram" | "matrix" | "web" | "pgp" | "kyc";
export type OAuthProvider = "x" | "discord" | "github";
export const OAUTH: readonly Channel[] = ["x", "discord", "github"];

/** The typed field a channel verifies (`null` for the identity document). */
export function kindOfChannel(channel: string): FieldKind | null {
  const found = Object.entries(CHANNEL_OF).find(([, c]) => c === channel);
  return found ? (found[0] as FieldKind) : null;
}

export interface Channels {
  /** The channels the service has turned on. Empty when it could not be reached. */
  enabled: ReadonlySet<string>;
  matrixBot?: string;
  telegramBot?: string;
}

let channelsRead: Promise<Channels> | null = null;

/** The channels the service offers, read once per page load. A failed read is not kept: the next
 * call asks again. */
export function readChannels(): Promise<Channels> {
  channelsRead ??= get<{ channels?: unknown; matrixBot?: unknown; telegramBot?: unknown }>("/api/channels").then(
    (json) => ({
      enabled: new Set(Array.isArray(json.channels) ? json.channels.filter((c): c is string => typeof c === "string") : []),
      matrixBot: typeof json.matrixBot === "string" ? json.matrixBot : undefined,
      telegramBot: typeof json.telegramBot === "string" ? json.telegramBot : undefined,
    }),
    (error: unknown) => {
      channelsRead = null;
      throw error;
    },
  );
  return channelsRead;
}

/** Forget the channels read (tests). */
export function forgetChannels(): void {
  channelsRead = null;
}

// --- Calls ------------------------------------------------------------------------------------

/** A private field's packet, or nothing for a public field. */
type Packet = VerificationPacket | undefined;
const withPacket = (address: string, packet: Packet) => (packet ? { address, packet } : { address });

export const emailSend = (address: string, packet?: Packet) => post<{ sent: true; session: string }>("/api/email/send", withPacket(address, packet));
export const emailCheck = (address: string, session: string, code: string) => post<{ verified: true }>("/api/email/check", { address, session, code });

export const telegramStart = (address: string, packet?: Packet) => post<{ url: string; session: string }>("/api/telegram/start", withPacket(address, packet));
export const telegramCheck = (address: string, session: string, code: string) => post<{ verified: true }>("/api/telegram/check", { address, session, code });

export const matrixStart = (address: string, packet?: Packet) =>
  post<{ command: string; bot: string; session: string }>("/api/matrix/start", withPacket(address, packet));
export const matrixCheck = (address: string, session: string, code: string) => post<{ verified: true }>("/api/matrix/check", { address, session, code });

export const webCheck = (address: string) => post<{ verified: true; method: "WebFile" | "Dns" }>("/api/web/check", { address });

export const pgpChallenge = (address: string, packet?: Packet) => post<{ challenge: string; session: string }>("/api/pgp/challenge", withPacket(address, packet));
export const pgpVerify = ({ address, session, signed, key, packet }: { address: string; session: string; signed: string; key?: string; packet?: Packet }) =>
  post<{ verified: true }>("/api/pgp/verify", { address, session, signed, ...(key ? { key } : {}), ...(packet ? { packet } : {}) });

/** Leave a private field's packet with the service for a sign-in, which cannot carry it: its id. */
export const storePacket = (address: string, packet: VerificationPacket) => post<{ id: string }>("/api/packet", { address, packet }).then((r) => r.id);

/** Where a sign-in with X, Discord or GitHub starts. It must be opened as a page of its own (a
 * window or this tab), from this site: the service refuses it otherwise. */
export function oauthStartUrl(provider: OAuthProvider, address: string, mode: "popup" | "redirect", packetId?: string): string {
  const query = new URLSearchParams({ address, mode });
  if (packetId) query.set("packet", packetId);
  return `${verifierBase()}/oauth/${provider}/start?${query}`;
}

export type KycStatus = "none" | "pending" | "approved" | "declined";

export async function kycStatus(address: string): Promise<KycStatus> {
  const { status } = await get<{ status?: unknown }>(`/api/kyc/status?${new URLSearchParams({ address })}`);
  return status === "pending" || status === "approved" || status === "declined" ? status : "none";
}

/** The message the wallet signs to start an identity check: four lines, the time in milliseconds.
 * `address` with the identitee prefix, `genesis` in lowercase hexadecimal. */
export function kycMessage(genesis: string, address: string, time: number): string {
  return ["identitee kyc", `chain: ${genesis.toLowerCase()}`, `address: ${address}`, `time: ${time}`].join("\n");
}

export const kycStart = (address: string, message: string, signature: string) => post<{ url: string }>("/api/kyc/start", { address, message, signature });
