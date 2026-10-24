// The verification packet of a private field. The chain only holds the field's commitment; to
// have it verified, the person sends an authority the value and the salt behind it. The packet
// carries them with the field, the account and the chain, signed by the account's wallet, so the
// authority can check that the account vouches for it and that value and salt give the
// commitment it reads on chain.
//
// The packet holds a private value and its salt: it is built when the person asks for it, shown to
// them to copy, and never sent, stored or logged by the app.
//
// Signed text: the packet without its signature, as JSON with its keys in the order of
// `PacketContent`, given to the wallet's `signRaw` as bytes (wallets wrap them in
// <Bytes>...</Bytes> before signing; `signatureVerify` accepts the text with or without it).

import { hexToU8a, isHex, stringToU8a, u8aToHex, u8aToString, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { isAddress, toIdentitee } from "./address.ts";
import { type Hex, privateCommitment, SALT_LENGTH } from "./formulas.ts";
import { FIELD_LABELS, type FieldRef } from "./identity.ts";
import { Refusal } from "./refusal.ts";

export const PACKET_TYPE = "identitee-verification-packet";
export const PACKET_VERSION = 1;

export interface PacketContent {
  type: typeof PACKET_TYPE;
  version: typeof PACKET_VERSION;
  /** Genesis hash of the chain the field is on. */
  chain: Hex;
  /** The account, prefix 2426. */
  address: string;
  field: FieldRef;
  /** The value as text; a PGP fingerprint as the 0x hexadecimal of its bytes. */
  value: string;
  salt: Hex;
  /** `privateCommitment(salt, value)`: what the chain should hold for the field. */
  commitment: Hex;
}

export interface VerificationPacket extends PacketContent {
  signature: Hex;
}

const KEYS = ["type", "version", "chain", "address", "field", "value", "salt", "commitment", "signature"];

const isPgp = (ref: FieldRef): boolean => "typed" in ref && ref.typed === "Pgp";

/** The text that is signed: the content's fields in a fixed order. */
export function packetMessage(content: PacketContent): string {
  const { type, version, chain, address, field, value, salt, commitment } = content;
  const ref = "typed" in field ? { typed: field.typed } : { custom: field.custom };
  return JSON.stringify({ type, version, chain, address, field: ref, value, salt, commitment });
}

/** Signs `data` (hex of the text) the way `signRaw({ type: "bytes" })` does. */
export type SignRaw = (data: Hex) => Promise<Hex>;

const verified = async (message: string, signature: Hex, address: string): Promise<boolean> => {
  await cryptoWaitReady();
  try {
    return signatureVerify(u8aWrapBytes(stringToU8a(message)), signature, address).isValid;
  } catch {
    return false;
  }
};

/** Build and sign the packet of a private field. Throws if the wallet's signature is not the
 * account's. */
export async function makePacket(
  input: { chain: Hex; address: string; ref: FieldRef; value: Uint8Array; salt: Uint8Array },
  sign: SignRaw,
): Promise<VerificationPacket> {
  const content: PacketContent = {
    type: PACKET_TYPE,
    version: PACKET_VERSION,
    chain: input.chain,
    address: toIdentitee(input.address),
    field: input.ref,
    value: isPgp(input.ref) ? u8aToHex(input.value) : u8aToString(input.value),
    salt: u8aToHex(input.salt),
    commitment: privateCommitment(input.salt, input.value),
  };
  const message = packetMessage(content);
  const signature = await sign(u8aToHex(stringToU8a(message)));
  if (!(await verified(message, signature, content.address))) throw new Refusal("The wallet signed with another account.");
  return { ...content, signature };
}

const hex = (value: unknown, bytes?: number): value is Hex =>
  typeof value === "string" && isHex(value) && (bytes === undefined || value.length === 2 + bytes * 2);

function fieldOf(value: unknown): FieldRef | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.typed === "string" && Object.hasOwn(FIELD_LABELS, entry.typed)) return { typed: entry.typed as keyof typeof FIELD_LABELS };
  if (typeof entry.custom === "string" && entry.custom !== "") return { custom: entry.custom };
  return null;
}

/** Read a pasted packet: its content and the value's bytes if the signature is the account's and
 * value and salt give the commitment; otherwise a sentence. Whether the chain holds that commitment
 * for the field is for the caller to check. */
export async function readPacket(text: string): Promise<{ packet: VerificationPacket; value: Uint8Array } | { problem: string }> {
  const notOne = { problem: "This is not a verification packet." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return notOne;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return notOne;
  const p = json as Record<string, unknown>;
  if (Object.keys(p).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(p, k))) return notOne;
  if (p.type !== PACKET_TYPE) return notOne;
  if (p.version !== PACKET_VERSION) return { problem: "This packet was made by another version of identit.ee." };
  const field = fieldOf(p.field);
  if (
    !hex(p.chain, 32) ||
    typeof p.address !== "string" ||
    !isAddress(p.address) ||
    toIdentitee(p.address) !== p.address ||
    field === null ||
    typeof p.value !== "string" ||
    !hex(p.salt, SALT_LENGTH) ||
    !hex(p.commitment, 32) ||
    !hex(p.signature)
  ) {
    return { problem: "This verification packet is damaged." };
  }
  if (isPgp(field) && !hex(p.value)) return { problem: "This verification packet is damaged." };
  const packet = { ...(p as unknown as VerificationPacket), field };
  const value = isPgp(field) ? hexToU8a(packet.value) : stringToU8a(packet.value);
  if (!(await verified(packetMessage(packet), packet.signature, packet.address))) return { problem: "The signature does not match the account." };
  if (privateCommitment(hexToU8a(packet.salt), value) !== packet.commitment.toLowerCase()) {
    return { problem: "The value and salt do not give the commitment of the packet." };
  }
  return { packet, value };
}
