// Disposable mailboxes: an email whose domain, or whose MX host, belongs to a throwaway
// mailbox provider cannot be verified. The list is dotID's `EMAIL_FORWARDER_MX_DOMAINS`. Aliasing
// forwarders (SimpleLogin, addy.io, Apple and Firefox relays) are not on it: they front real inboxes.
// A DNS failure lets the email through, so that a flaky resolver never blocks an honest person.

import { Resolver } from 'node:dns/promises';

export const DISPOSABLE_MX_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'yopmail.com',
  '10minutemail.com',
  '10minutemail.net',
  'temp-mail.org',
  'tempmail.com',
  'tempr.email',
  'trashmail.com',
  'trashmail.de',
  'maildrop.cc',
  'dispostable.com',
  'getairmail.com',
  'mintemail.com',
  'throwawaymail.com',
  'fakeinbox.com',
]);

/** The MX records of a domain (tests pass their own). */
export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

/** The system's resolver, 3 seconds a try. */
export const systemMx: MxResolver = (domain) => new Resolver({ timeout: 3000, tries: 2 }).resolveMx(domain);

/** The overall wait for a lookup. */
const LOOKUP_MS = 5000;

const host = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

/** Whether `name` is a listed provider or one of its subdomains. */
const listed = (name: string): boolean => {
  const h = host(name);
  for (const provider of DISPOSABLE_MX_DOMAINS) {
    if (h === provider || h.endsWith(`.${provider}`)) return true;
  }
  return false;
};

/**
 * Whether the email's domain, or an MX host of it, is a disposable provider. `false` for text
 * without a domain and when the lookup fails or exceeds `timeoutMs`.
 */
export async function isDisposableEmail(email: string, resolveMx: MxResolver = systemMx, timeoutMs: number = LOOKUP_MS): Promise<boolean> {
  const domain = host(email.slice(email.lastIndexOf('@') + 1));
  if (!email.includes('@') || domain === '') return false;
  if (listed(domain)) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MX lookup timed out')), timeoutMs);
      }),
    ]);
    return records.some((record) => listed(record.exchange));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
