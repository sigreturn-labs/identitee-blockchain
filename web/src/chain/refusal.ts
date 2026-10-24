// A sentence written for the person: what the app refuses to send, and why. Anything else that is
// thrown (a library, the network) carries technical text that a page replaces with a sentence of
// its own. No dependency, so a page can tell the two apart without loading the chain.

export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** What a page says when the call it was about to sign could not be built and the cause is not a
 * `Refusal` (a library, the network): the technical text stays out of the page. */
export const NOT_PREPARED = "The call could not be prepared. Try again.";

/** The sentence of a `Refusal`, else `otherwise`. */
export const sentenceOf = (error: unknown, otherwise: string): string => (error instanceof Refusal && error.message ? error.message : otherwise);
