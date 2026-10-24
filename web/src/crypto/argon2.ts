// Argon2id, through hash-wasm (WebAssembly). Its own chunk: imported with `import()` by
// secret.ts the first time a passphrase is used, so no page downloads it before that.

import { argon2id } from "hash-wasm";

export interface Argon2Cost {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** A 32-byte key from `password` and `salt`. */
export function argon2Key(password: Uint8Array, salt: Uint8Array, cost: Argon2Cost): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    memorySize: cost.memoryKiB,
    iterations: cost.iterations,
    parallelism: cost.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
}
