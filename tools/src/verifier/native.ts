// The Matrix channel's native crypto module (`@matrix-org/matrix-sdk-crypto-nodejs`) ships no binary: its
// `postinstall` downloads `matrix-sdk-crypto.linux-x64-gnu.node` from GitHub, without a checksum, and a
// failed download leaves `npm ci` green. Its SHA-256 is pinned in `tools/matrix-crypto.sha256`;
// `npm run verify:native` fails when the file is missing or differs, and the channel checks it again
// before loading the module.
//
//   npm run verify:native     (a mandatory deploy step after `npm ci`)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NATIVE_NAME = 'matrix-sdk-crypto.linux-x64-gnu.node';
/** `tools/matrix-crypto.sha256`, in the format of `sha256sum`. */
export const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'matrix-crypto.sha256');

/** Where the downloaded binary is, or null when the package itself is not installed. */
export function nativePath(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('@matrix-org/matrix-sdk-crypto-nodejs/package.json');
    return join(dirname(pkg), NATIVE_NAME);
  } catch {
    return null;
  }
}

export type NativeCheck = { ok: true; sha256: string } | { ok: false; reason: 'missing' | 'mismatch' | 'no-pin' };

/** Whether `file` is the binary whose SHA-256 `pinFile` pins. */
export function verifyNative(file: string | null = nativePath(), pinFile: string = PIN_FILE): NativeCheck {
  let want: string | undefined;
  try {
    want = /^([0-9a-f]{64})\b/m.exec(readFileSync(pinFile, 'utf8'))?.[1];
  } catch {
    want = undefined;
  }
  if (want === undefined) return { ok: false, reason: 'no-pin' };
  let bytes: Buffer;
  try {
    if (file === null) return { ok: false, reason: 'missing' };
    bytes = readFileSync(file);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return sha256 === want ? { ok: true, sha256 } : { ok: false, reason: 'mismatch' };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyNative();
  if (result.ok) {
    process.stdout.write(`ok ${NATIVE_NAME} ${result.sha256}\n`);
  } else {
    const why = { missing: 'is missing (its download failed: run npm ci again)', mismatch: 'does not match the pinned SHA-256', 'no-pin': 'has no pinned SHA-256' }[result.reason];
    process.stderr.write(`${NATIVE_NAME} ${why} (${PIN_FILE})\n`);
    process.exitCode = 1;
  }
}
