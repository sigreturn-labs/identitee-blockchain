import { TypeRegistry } from "@polkadot/types";

/** A registry whose signed extensions are those of the identitee chain. */
export const registry = new TypeRegistry();
registry.setSignedExtensions([
  "CheckNonce",
  "CheckMortality",
  "ChargeTransactionPayment",
  "AuthorizeCall",
]);
