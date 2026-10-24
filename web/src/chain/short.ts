// Dependency-free text helpers for addresses, so the header can use them without loading the
// wallet libraries.

/** `idrfveZj…s9YX3ogk`: the edges of an address, for headers and lists. The full address belongs
 * in a `title`. */
export function shorten(address: string, edge = 8): string {
  return address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
}
