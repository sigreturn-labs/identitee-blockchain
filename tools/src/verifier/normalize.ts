// Whether the account a person proved is the one their identity names: without case,
// without spaces, without a leading `@`. A Discord value made of digits is the numeric id and
// matches the id only; Matrix compares the full `@local:server` id.
//
// A value on chain may also be the profile's address, on the provider's own host only:
// `[https://]x.com/<h>` or `[https://]twitter.com/<h>` for X, `[https://]github.com/<h>` for GitHub,
// `[https://]t.me/<h>` for Telegram (a trailing `/` and a `?…` dropped), and
// `[https://]matrix.to/#/@user:server` for Matrix. Anything else (another host, more path) is read
// as a plain handle, so it matches nothing.

import type { FieldKind } from './chain.ts';

/** The account the proof showed: a name, or for Discord its name and numeric id. */
export type ProvedAccount = string | { username?: string | null; id?: string | null };

const squash = (text: string): string => text.replace(/\s+/g, '').toLowerCase();
const handle = (text: string): string => squash(text).replace(/^@/, '');

const PROFILE_HOSTS: Partial<Record<FieldKind, readonly string[]>> = {
  X: ['x.com', 'twitter.com'],
  GitHub: ['github.com'],
  Telegram: ['t.me'],
};
const PROFILE_URL = /^(?:https:\/\/)?([^/?#]+)\/([^/?#]+)\/?(?:\?.*)?$/;

/** The handle of an X, GitHub or Telegram value, written as a handle or as its profile's address. */
function handleOf(channel: FieldKind, text: string): string {
  const hosts = PROFILE_HOSTS[channel];
  const found = hosts === undefined ? null : PROFILE_URL.exec(squash(text));
  if (found !== null && hosts!.includes(found[1]!)) return handle(found[2]!);
  return handle(text);
}

/** A handle as `sameHandle` reads it for the channels that compare plain names (Telegram, X, GitHub): no case, no spaces, no leading `@`. */
export const normalizeHandle = handle;

const MATRIX_TO = /^(?:https:\/\/)?matrix\.to\/#\//;

function matrixId(text: string): string | null {
  const id = squash(text).replace(MATRIX_TO, '');
  const full = id.startsWith('@') ? id : `@${id}`;
  return /^@[^:@]+:[^:@]+(:\d+)?$/.test(full) ? full : null;
}

/** A Matrix id as `sameHandle` reads it: `@local:server`, no case, no spaces; a value that is not an id stays as it is, squashed. */
export const normalizeMatrixId = (text: string): string => matrixId(text) ?? squash(text);

export function sameHandle(channel: FieldKind, onChain: string, account: ProvedAccount): boolean {
  const username = typeof account === 'string' ? account : (account.username ?? '');
  switch (channel) {
    case 'Matrix': {
      const a = matrixId(onChain);
      return a !== null && a === matrixId(username);
    }
    case 'Discord': {
      // An all-digit value is a Discord id: it matches only the account's id, never a username made
      // of the same digits (that would let anyone claim someone else's id).
      const want = handle(onChain);
      if (want === '') return false;
      if (/^\d+$/.test(want)) return typeof account !== 'string' && account.id === want;
      return want === handle(username);
    }
    case 'Email':
      return squash(onChain) !== '' && squash(onChain) === squash(username);
    default: {
      const want = handleOf(channel, onChain);
      return want !== '' && want === handle(username);
    }
  }
}
