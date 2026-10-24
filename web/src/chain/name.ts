// What a username can be, as the runtime checks it (pallets/identitee/src/validate.rs,
// `validate_name`): 3 to 32 bytes, each one of a-z, 0-9, hyphen and underscore. The alphabet is
// ASCII, so a character is a byte: a name with an accent or an emoji is too long or invalid
// whatever its character count. No dependency but routes.ts, which has none: the profile page uses
// this file before loading the chain.

import { RESERVED_PATHS } from "../routes.ts";

export const NAME_MIN = 3;
export const NAME_MAX = 32;

/** Whether `name` can be a username. Anything else, such as `robots.txt` or `favicon.ico`, cannot
 * exist on the chain and is not worth asking it about. */
export function isValidName(name: string): boolean {
  const bytes = new TextEncoder().encode(name).length;
  return bytes >= NAME_MIN && bytes <= NAME_MAX && /^[a-z0-9_-]+$/.test(name);
}

/** What the runtime refuses in `name` (the alphabet, the length), as a sentence, or `null`. An
 * authority reserving a name goes by this alone: it may reserve the name of a page of the app,
 * precisely so that nobody can claim it. */
export function ruleProblem(name: string): string | null {
  if (!/^[a-z0-9_-]*$/.test(name)) return "Names use only a to z, 0 to 9, hyphens and underscores.";
  if (name.length < NAME_MIN) return `Names have at least ${NAME_MIN} characters.`;
  if (name.length > NAME_MAX) return `Names have at most ${NAME_MAX} characters.`;
  return null;
}

/**
 * What is wrong with `name` as a username to claim or to give, as a sentence, or `null`. It is
 * checked before the chain is asked anything, so a name that cannot exist never costs a request.
 * Beyond the runtime's rules (`ruleProblem`), a name equal to a page of the app is refused:
 * `/requests` would show that page, never the profile.
 */
export function nameProblem(name: string): string | null {
  const problem = ruleProblem(name);
  if (problem !== null) return problem;
  if (RESERVED_PATHS.includes(name)) return "That name belongs to a page of this site and cannot be taken.";
  return null;
}
