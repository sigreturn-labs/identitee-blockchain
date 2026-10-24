// Cleanup for the self-tests (migrator-selftest.ts, verifier-selftest.ts), which may run on a
// production server: whatever ends a run (a failure, an unhandled rejection, Ctrl-C, SIGTERM from `timeout`,
// SIGHUP from a dropped ssh), the processes it started are killed with SIGKILL and its temporary
// directories removed, so that no dev node or service is left running. Only SIGKILL of the self-test
// itself escapes it (nothing can run then).

import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

const children = new Set<ChildProcess>();
const dirs = new Set<string>();
let installed = false;

/** Kill every child still running and remove every directory; safe to call more than once, synchronous. */
export function cleanupAll(): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}

export function guardChild(child: ChildProcess): void {
  children.add(child);
  child.once('exit', () => children.delete(child));
}

export function guardDir(dir: string): void {
  dirs.add(dir);
}

/**
 * Install the hooks once: on `exit` the cleanup alone; on SIGINT, SIGTERM, SIGHUP and an unhandled
 * rejection, `report(why)` (the summary and the last log lines), then the cleanup, then exit non-zero.
 */
export function installGuard(report: (why: string) => void): void {
  if (installed) return;
  installed = true;
  process.on('exit', cleanupAll);
  const fatal = (why: string, code: number): void => {
    try {
      report(why);
    } catch {
      // the cleanup matters more than the report
    }
    cleanupAll();
    process.exit(code);
  };
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    process.on(signal, () => fatal(`interrupted by ${signal}`, code));
  }
  process.on('unhandledRejection', (e) => fatal(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`, 1));
}
