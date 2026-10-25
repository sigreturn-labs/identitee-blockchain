// Display helpers. Amounts arrive as planck decimal strings and stay BigInt-safe.

/** One IDT is 10^12 planck (`UNIT` in runtime/src/lib.rs). */
export const DECIMALS = 12;

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `1,234.5 IDT` for "1234500000000000": every significant decimal is kept, trailing zeros are not.
 * Anything that is not a planck amount is returned unchanged. */
export function formatIdt(planck: string): string {
  if (!/^\d+$/.test(planck)) return planck;
  const padded = planck.replace(/^0+(?=\d)/, "").padStart(DECIMALS + 1, "0");
  const whole = padded.slice(0, -DECIMALS);
  const fraction = padded.slice(-DECIMALS).replace(/0+$/, "");
  return `${group(whole)}${fraction ? `.${fraction}` : ""} IDT`;
}

/** `6 s ago`, `3 min ago`, `5 h ago`, `2 d ago`: the largest whole unit. */
export function ago(ms: number, now: number): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** `0x1a2b3c…7d8e9f`: the edges of a hash. The full hash belongs in a `title`. */
export function shortHash(h: string): string {
  return h.length <= 16 ? h : `${h.slice(0, 8)}…${h.slice(-6)}`;
}

/** `1,234,567` */
export const formatNumber = (n: number): string => group(String(n));

/** `2026-10-25 13:46:40 UTC` */
export const formatTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
