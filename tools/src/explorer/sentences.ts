// One plain English sentence per event the explorer explains: every identitee event, plus
// transfers, new accounts and sudo results. Reads the JSON of `eventData` (decode.ts).

export interface SentenceContext {
  /** The registered name of an authority, or null if unknown. */
  authorityName(id: number): string | null;
}

type Data = Record<string, unknown>;

class Malformed extends Error {}

/** `idrfve…YX3ogk`: the first and last 6 characters of an address. */
export function shorten(address: string, edge = 6): string {
  return address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

const ucfirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function str(data: Data, key: string): string {
  const v = data[key];
  if (typeof v !== 'string') throw new Malformed(key);
  return v;
}

function num(data: Data, key: string): number {
  const v = data[key];
  if (typeof v !== 'number') throw new Malformed(key);
  return v;
}

/** A single-variant enum value `{ Variant: inner }`. */
function variant(v: unknown): [string, unknown] {
  if (typeof v !== 'object' || v === null) throw new Malformed('variant');
  const entries = Object.entries(v);
  if (entries.length !== 1) throw new Malformed('variant');
  return entries[0];
}

const FIELD_KINDS: Record<string, string> = {
  DisplayName: 'display name',
  LegalName: 'legal name',
  Web: 'website',
  Email: 'email',
  Matrix: 'Matrix',
  X: 'X',
  Discord: 'Discord',
  GitHub: 'GitHub',
  Telegram: 'Telegram',
  Pgp: 'PGP key',
};

const FACTS: Record<string, string> = { DocumentChecked: 'document check', Fraud: 'fraud fact' };

const REASONS: Record<string, string> = {
  ValueMismatch: 'value mismatch',
  Disposable: 'disposable',
  Impersonation: 'impersonation',
  DocumentInvalid: 'invalid document',
  UserRequest: 'user request',
  Abuse: 'abuse',
  Other: 'other',
};

function lookup(table: Record<string, string>, v: unknown): string {
  if (typeof v !== 'string') throw new Malformed('label');
  return table[v] ?? v;
}

function fieldKey(v: unknown): string {
  const [kind, inner] = variant(v);
  if (kind === 'Typed') return lookup(FIELD_KINDS, inner);
  if (kind === 'Custom' && typeof inner === 'string') return `custom field "${inner}"`;
  if (kind === 'Link' && typeof inner === 'number') return `link #${inner}`;
  throw new Malformed('key');
}

function target(v: unknown): string {
  const [kind, inner] = variant(v);
  if (kind === 'Field') return `check the ${fieldKey(inner)}`;
  if (kind === 'Fact') return `record a ${lookup(FACTS, inner)}`;
  throw new Malformed('target');
}

/** `, reason: abuse`, or nothing when the reason is unspecified. */
function reason(data: Data): string {
  const r = str(data, 'reason');
  return r === 'Unspecified' ? '' : `, reason: ${lookup(REASONS, r)}`;
}

/** A planck amount as IDT (12 decimals), without trailing zeros. */
function idt(planck: string): string {
  if (!/^\d+$/.test(planck)) throw new Malformed('amount');
  const padded = planck.padStart(13, '0');
  const whole = padded.slice(0, -12).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = padded.slice(-12).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} IDT`;
}

function identitee(method: string, d: Data, ctx: SentenceContext): string | null {
  const who = () => shorten(str(d, 'who'));
  const auth = () => {
    const id = num(d, 'authority');
    return ctx.authorityName(id) ?? `authority #${id}`;
  };
  const key = () => fieldKey(d.key);
  const name = () => str(d, 'name');
  const parent = () => shorten(str(d, 'parent'));
  const sub = () => shorten(str(d, 'sub'));
  const source = () => str(d, 'source');
  switch (method) {
    case 'BioSet': return `Bio set by ${who()}`;
    case 'FieldSet': return `${ucfirst(key())} set by ${who()}`;
    case 'FieldCleared': return `${ucfirst(key())} cleared by ${who()}`;
    case 'LinkAdded': return `Link #${num(d, 'id')} added by ${who()}`;
    case 'LinkUpdated': return `Link #${num(d, 'id')} updated by ${who()}`;
    case 'LinkRemoved': return `Link #${num(d, 'id')} removed by ${who()}`;
    case 'LinksReordered': return `Links reordered by ${who()}`;
    case 'AvatarSet': return `Avatar set by ${who()}`;
    case 'AvatarCleared': return `Avatar cleared by ${who()}`;
    case 'FieldRevealed': return `${ucfirst(key())} revealed by ${who()}`;
    case 'IdentityCleared': return `Identity of ${who()} cleared`;
    case 'IdentityPurged': return `Identity of ${who()} purged`;
    case 'AuthorityRegistered': return `Authority "${str(d, 'name')}" registered as #${num(d, 'id')}`;
    case 'AgentSet': return `${shorten(str(d, 'agent'))} set as agent of ${auth()}`;
    case 'AgentRemoved': return `${shorten(str(d, 'agent'))} removed as agent of ${auth()}`;
    case 'AuthorityStatusChanged': {
      if (typeof d.active !== 'boolean') throw new Malformed('active');
      return `${ucfirst(auth())} ${d.active ? 'activated' : 'deactivated'}`;
    }
    case 'AttestationRequested': return `${who()} asked ${auth()} to ${target(d.target)}`;
    case 'RequestCancelled': return `${who()} withdrew the request to ${auth()} to ${target(d.target)}`;
    case 'FieldAttested': {
      const verdict = str(d, 'verdict');
      if (verdict !== 'Verified' && verdict !== 'Rejected') throw new Malformed('verdict');
      return `${ucfirst(key())} ${verdict === 'Verified' ? 'attested' : 'rejected'} for ${who()} by ${auth()}`;
    }
    case 'AttestationRevoked': return `${ucfirst(key())} attestation for ${who()} revoked by ${auth()}${reason(d)}`;
    case 'RequestRejected': return `Request of ${who()} to ${target(d.target)} rejected by ${auth()}${reason(d)}`;
    case 'FactGranted': return `${ucfirst(lookup(FACTS, d.kind))} recorded for ${who()} by ${auth()}`;
    case 'FactRevoked': return `${ucfirst(lookup(FACTS, d.kind))} for ${who()} revoked by ${auth()}${reason(d)}`;
    case 'NameClaimed': return `Name ${name()} claimed by ${who()}`;
    case 'NameReleased': return `Name ${name()} released by ${who()}`;
    case 'NameReserved': return `Name ${name()} reserved`;
    case 'NameUnreserved': return `Name ${name()} unreserved`;
    case 'NameAssigned': return `Name ${name()} assigned to ${who()}`;
    case 'NameRevoked': return `Name ${name()} taken from ${who()}${reason(d)}`;
    case 'SubProposed': return `${parent()} proposed ${sub()} as a sub-account`;
    case 'SubAccepted': return `${sub()} became a sub-account of ${parent()}`;
    case 'SubRemoved': return `Sub-account ${sub()} removed from ${parent()}`;
    case 'SubLeft': return `Sub-account ${sub()} left ${parent()}`;
    case 'SubDeclined': return `${sub()} declined to be a sub-account of ${parent()}`;
    case 'SubLabelSet': return `Label of sub-account ${sub()} set by ${parent()}`;
    case 'MigrationRequested': return `${who()} asked to migrate their identity from ${source()}`;
    case 'MigrationCancelled': return `${who()} cancelled their migration from ${source()}`;
    case 'MigrationFulfilled': return `Identity of ${who()} migrated from ${source()} block ${num(d, 'block')}`;
    case 'MigrationRejected': return `Migration of ${who()} from ${source()} rejected${reason(d)}`;
    case 'IdentitySecretSet': return `Identity secret set by ${who()}`;
    case 'IdentitySecretCleared': return `Identity secret cleared by ${who()}`;
    case 'ProfileUpdated': return `Profile updated by ${who()}`;
    default: return null;
  }
}

/** The sentence of an event, or null when the explorer does not explain it or its data is not
 * the expected shape. `pallet` and `method` as in `eventData`: `identitee`, `FieldAttested`. */
export function sentence(pallet: string, method: string, data: Data, ctx: SentenceContext): string | null {
  try {
    if (pallet === 'identitee') return identitee(method, data, ctx);
    if (pallet === 'balances' && method === 'Transfer') {
      return `${idt(str(data, 'amount'))} sent from ${shorten(str(data, 'from'))} to ${shorten(str(data, 'to'))}`;
    }
    if (pallet === 'system' && method === 'NewAccount') return `Account ${shorten(str(data, 'account'))} created`;
    if (pallet === 'sudo' && method === 'Sudid') {
      const [result] = variant(data.sudo_result);
      if (result === 'Ok') return 'Sudo call succeeded';
      if (result === 'Err') return 'Sudo call failed';
      throw new Malformed('sudo_result');
    }
    return null;
  } catch (e) {
    if (e instanceof Malformed) return null;
    throw e;
  }
}
