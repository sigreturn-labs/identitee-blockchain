// The verification packet of a private field, as web/src/chain/packet.ts makes it: the
// value, its salt and its commitment, with the field, the account and the chain, signed by the
// account's wallet (`signRaw`, the JSON of the first 8 keys wrapped in <Bytes>...</Bytes>). The
// service checks it the way the authority page does (web/src/chain/inbox.ts `checkPacket`), against
// the chain now.
//
// A packet holds a private value: it is kept in memory only (`PacketMemory`, 10 minutes), never in
// SQLite, never logged, and errors about it never quote it.

import { randomBytes } from 'node:crypto';

import { hexToU8a, isHex, stringToU8a, u8aEq, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';

import { canonicalAddress, FIELD_LABELS, isFieldKind, privateCommitment, publicKeyOf, SALT_LENGTH, type Chain, type FieldKey } from './chain.ts';
import type { Ctx } from './ctx.ts';
import { HttpError, type Router } from './http.ts';

export { privateCommitment };

export const PACKET_TYPE = 'identitee-verification-packet';
export const PACKET_VERSION = 1;
/** How long a checked packet is kept for the channel that uses it. */
export const PACKET_TTL_MS = 10 * 60_000;
const MAX_PACKETS = 10_000;

const KEYS = ['type', 'version', 'chain', 'address', 'field', 'value', 'salt', 'commitment', 'signature'];
/** Every field kind of the chain (a packet may name one the verifier does not verify). */
const ALL_KINDS = ['DisplayName', 'LegalName', 'Web', 'Email', 'Matrix', 'X', 'Discord', 'GitHub', 'Telegram', 'Pgp'];

type PacketField = { typed: string } | { custom: string };

interface Packet {
  type: string;
  version: number;
  chain: string;
  address: string;
  field: PacketField;
  value: string;
  salt: string;
  commitment: string;
  signature: string;
}

const hex = (value: unknown, bytes?: number): value is string =>
  typeof value === 'string' && isHex(value) && (bytes === undefined || value.length === 2 + bytes * 2);

function fieldOf(value: unknown): PacketField | null {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 1) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.typed === 'string' && ALL_KINDS.includes(entry.typed)) return { typed: entry.typed };
  if (typeof entry.custom === 'string' && entry.custom !== '') return { custom: entry.custom };
  return null;
}

const OTHER_LABELS: Record<string, string> = { DisplayName: 'Display name', LegalName: 'Legal name' };
const labelOf = (field: PacketField): string =>
  'typed' in field ? (isFieldKind(field.typed) ? FIELD_LABELS[field.typed] : (OTHER_LABELS[field.typed] ?? field.typed)) : field.custom;

const isPgp = (field: PacketField): boolean => 'typed' in field && field.typed === 'Pgp';

/** The signed text: the content's fields in their fixed order (web `packetMessage`). */
const messageOf = (p: Packet): string => {
  const { type, version, chain, address, field, value, salt, commitment } = p;
  return JSON.stringify({ type, version, chain, address, field, value, salt, commitment });
};

/** A packet as an object or as its JSON text: its content and the value's bytes if it is well
 * formed, signed by the account it names, and its value and salt give its commitment. */
async function readPacket(input: unknown): Promise<{ packet: Packet; value: Uint8Array } | { error: string }> {
  const notOne = { error: 'This is not a verification packet.' };
  let json: unknown = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      return notOne; // the parser's message would quote the text
    }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return notOne;
  const p = json as Record<string, unknown>;
  if (Object.keys(p).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(p, k))) return notOne;
  if (p.type !== PACKET_TYPE) return notOne;
  if (p.version !== PACKET_VERSION) return { error: 'This packet was made by another version of identit.ee.' };
  const field = fieldOf(p.field);
  const damaged = { error: 'This verification packet is damaged.' };
  if (
    !hex(p.chain, 32) ||
    typeof p.address !== 'string' ||
    canonicalAddress(p.address) !== p.address ||
    field === null ||
    typeof p.value !== 'string' ||
    !hex(p.salt, SALT_LENGTH) ||
    !hex(p.commitment, 32) ||
    !hex(p.signature)
  ) {
    return damaged;
  }
  if (isPgp(field) && !hex(p.value)) return damaged;
  const packet = { ...(p as unknown as Packet), field };
  const value = isPgp(field) ? hexToU8a(packet.value) : stringToU8a(packet.value);
  if (!(await walletSigned(messageOf(packet), packet.signature, packet.address))) return { error: 'The signature of this packet does not match the account.' };
  if (privateCommitment(hexToU8a(packet.salt), value) !== packet.commitment.toLowerCase()) {
    return { error: 'The value and salt do not give the commitment of the packet.' };
  }
  return { packet, value };
}

/** Whether `signature` is `address`'s wallet signature of the text `message` (wrapped in `<Bytes>`, as wallets sign). */
export async function walletSigned(message: string, signature: string, address: string): Promise<boolean> {
  await cryptoWaitReady();
  try {
    return signatureVerify(u8aWrapBytes(stringToU8a(message)), signature, address).isValid;
  } catch {
    return false;
  }
}

/**
 * Whether `packet` (an object or its JSON text) proves field `expected.key` of `expected.address`
 * as the chain holds it now: signed by that account, for that field, for this chain, the field
 * still private, and `privateCommitment(salt, value)` equal to the commitment on chain. The value
 * (a PGP fingerprint as lowercase hex without 0x) and that commitment, or one sentence.
 */
export async function checkPacket(
  packet: unknown,
  chain: Chain,
  expected: { address: string; key: FieldKey },
): Promise<{ value: string; commitment: string } | { error: string }> {
  const read = await readPacket(packet);
  if ('error' in read) return read;
  const { packet: p } = read;
  let who: Uint8Array;
  try {
    who = chain.decodeAddress(expected.address);
  } catch {
    return { error: 'This is not a valid account address.' };
  }
  if (!u8aEq(publicKeyOf(p.address), who)) return { error: 'This packet is signed by another account.' };
  const label = FIELD_LABELS[expected.key.Typed];
  if (!('typed' in p.field) || p.field.typed !== expected.key.Typed) return { error: `This packet is for ${labelOf(p.field)}, not ${label}.` };
  if (p.chain.toLowerCase() !== chain.genesis.toLowerCase()) return { error: 'This packet was made for another chain.' };
  const now = await chain.field(expected.address, expected.key);
  if (now === null) return { error: `Your ${label} is no longer on your identity.` };
  if (!now.private) return { error: `Your ${label} is public now: verify it without a packet.` };
  if (p.commitment.toLowerCase() !== now.commitment.toLowerCase()) {
    return { error: `This packet does not match your ${label} on chain. It may have changed: verify it again.` };
  }
  return { value: isPgp(p.field) ? p.value.slice(2).toLowerCase() : p.value, commitment: now.commitment };
}

// --- Checked packets, in memory --------------------------------------------------------------------

export interface CheckedPrivate {
  /** Prefix 2426. */
  address: string;
  key: FieldKey;
  value: string;
  commitment: string;
}

/** Checked packets by random id, for 10 minutes, in this process's memory only. */
export class PacketMemory {
  private readonly items = new Map<string, CheckedPrivate & { expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  put(checked: CheckedPrivate): string {
    this.sweep();
    if (this.items.size >= MAX_PACKETS) this.items.delete(this.items.keys().next().value as string);
    const id = randomBytes(18).toString('base64url');
    this.items.set(id, { ...checked, expires: this.now() + PACKET_TTL_MS });
    return id;
  }

  get(id: string): CheckedPrivate | null {
    const item = this.items.get(id);
    if (item === undefined || item.expires <= this.now()) return null;
    const { expires: _expires, ...checked } = item;
    return checked;
  }

  /** Forget the expired packets; how many. */
  sweep(): number {
    let n = 0;
    for (const [id, item] of this.items) {
      if (item.expires <= this.now()) {
        this.items.delete(id);
        n++;
      }
    }
    return n;
  }
}

/**
 * The value and commitment of private field `key` of `address`, from an inline packet (object or
 * JSON text) or from the id `POST /api/packet` gave; checked against the chain now. One sentence
 * otherwise. Channels call this when the field is private.
 */
export async function resolvePrivate(
  ctx: Pick<Ctx, 'chain' | 'packets'>,
  address: string,
  key: FieldKey,
  packetOrId: unknown,
): Promise<{ value: string; commitment: string } | { error: string }> {
  if (typeof packetOrId !== 'string' || packetOrId.trimStart().startsWith('{')) return checkPacket(packetOrId, ctx.chain, { address, key });
  const expired = { error: 'This verification has expired. Start again.' };
  const stored = ctx.packets.get(packetOrId);
  if (stored === null || stored.key.Typed !== key.Typed || stored.address !== canonicalAddress(address)) return expired;
  const now = await ctx.chain.field(address, key);
  const label = FIELD_LABELS[key.Typed];
  if (now === null) return { error: `Your ${label} is no longer on your identity.` };
  if (!now.private || now.commitment.toLowerCase() !== stored.commitment.toLowerCase()) return { error: `Your ${label} changed. Verify it again.` };
  return { value: stored.value, commitment: stored.commitment };
}

/** Proof starts allowed per IP and hour. */
const PACKETS_PER_HOUR = 30;

/** `POST /api/packet {address, packet}` → `{ id }`: check a packet and keep it 10 minutes. */
export function registerPacketRoute(router: Router, ctx: Ctx): void {
  router.route('POST', '/api/packet', async (req) => {
    const body = (req.body ?? {}) as { address?: unknown; packet?: unknown };
    const address = typeof body.address === 'string' ? canonicalAddress(body.address) : null;
    if (address === null) throw new HttpError(400, 'This is not a valid account address.');
    if (!ctx.store.hit('packet', req.ip, PACKETS_PER_HOUR, 60 * 60_000)) throw new HttpError(429, 'Too many attempts. Try again later.');
    let packet = body.packet;
    if (typeof packet === 'string') {
      try {
        packet = JSON.parse(packet);
      } catch {
        packet = undefined; // the parser's message would quote the text
      }
    }
    if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) throw new HttpError(400, 'This is not a verification packet.');
    const field = (packet as { field?: unknown }).field;
    const typed = typeof field === 'object' && field !== null ? (field as { typed?: unknown }).typed : undefined;
    if (!isFieldKind(typed)) throw new HttpError(400, 'This field cannot be verified automatically.');
    const key: FieldKey = { Typed: typed };
    const checked = await checkPacket(packet, ctx.chain, { address, key });
    if ('error' in checked) throw new HttpError(400, checked.error);
    const id = ctx.packets.put({ address, key, value: checked.value, commitment: checked.commitment });
    ctx.log('info', 'packet-checked', { who: address, field: key.Typed });
    return { id };
  });
}
