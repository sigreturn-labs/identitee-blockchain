// Paths of the app. `/:name` shows the profile of a username, so a username equal to a fixed path
// would be shadowed by that page (app.tsx lists the fixed routes before `/:name`): such a name is
// linked through `/a/<address>` instead. Names have at least 3 characters, so `me` and `a` cannot
// exist; `requests` and `authority` can, until the chain reserves them.

/** First path segments that belong to the app. */
export const RESERVED_PATHS: readonly string[] = ["me", "requests", "authority", "a"];

/** Where the public profile of an account lives: its username's page, else its address's. */
export function profilePath(name: string | null, address: string): string {
  return name !== null && name !== "" && !RESERVED_PATHS.includes(name) ? `/${encodeURIComponent(name)}` : `/a/${address}`;
}

/** Pages that show their own Connect wallet card to a visitor with no account: the header then
 * has no second button for the same thing. */
export const CONNECT_CARD_PATHS: readonly string[] = ["/", "/me", "/requests", "/authority"];
