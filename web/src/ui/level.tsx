import type { TrustLevel } from "../chain/identity.ts";

export const LEVEL_LABELS: Record<TrustLevel, string> = {
  Certified: "Certified",
  FullyVerified: "Fully Verified",
  PartiallyVerified: "Partially Verified",
  Declared: "Declared",
  Fraudulent: "Fraudulent",
};

// a twelve-lobed seal, for Certified
const SEAL =
  Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * 2 * Math.PI - Math.PI / 2;
    const r = i % 2 ? 6.6 : 8;
    return `${i ? "L" : "M"}${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ") + " Z";

/**
 * The badge beside the name: none for Declared, an outlined check for Partially Verified, a filled
 * check for Fully Verified, a filled seal for Certified, a warning for Fraudulent.
 */
export function LevelBadge({ trust }: { trust: TrustLevel }) {
  const label = LEVEL_LABELS[trust];
  switch (trust) {
    case "Declared":
      return null;
    case "PartiallyVerified":
      return (
        <svg class="badge" width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={label}>
          <title>{label}</title>
          <circle cx="9" cy="9" r="7.4" fill="none" stroke="var(--ink-2)" stroke-width="1.3" />
          <path d="M5.8 9.2l2.2 2.2 4.3-4.6" fill="none" stroke="var(--ink-2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    case "FullyVerified":
      return (
        <svg class="badge" width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={label}>
          <title>{label}</title>
          <circle cx="9" cy="9" r="8" fill="var(--ink)" />
          <path d="M5.6 9.2l2.3 2.3 4.5-4.8" fill="none" stroke="var(--ground)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    case "Certified":
      return (
        <svg class="badge" width="20" height="20" viewBox="0 0 16 16" role="img" aria-label={label}>
          <title>{label}</title>
          <path d={SEAL} fill="var(--ink)" />
          <path d="M5.1 8.2l1.9 1.9 3.9-4.1" fill="none" stroke="var(--ground)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    case "Fraudulent":
      return (
        <svg class="badge" width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={label}>
          <title>{label}</title>
          <path d="M9 1.8l7.6 13.4H1.4z" fill="var(--ink)" stroke="var(--ink)" stroke-width="1.2" stroke-linejoin="round" />
          <path d="M9 6.6v4.2" stroke="var(--ground)" stroke-width="1.7" stroke-linecap="round" />
          <circle cx="9" cy="13.1" r="1" fill="var(--ground)" />
        </svg>
      );
  }
}

/** The mark of a field or a link: a filled check when verified, a dashed ring while an authority
 * is asked, a struck ring when rejected. */
export function StateMark({ standing }: { standing: "Verified" | "Pending" | "Rejected" }) {
  if (standing === "Verified") {
    return (
      <svg class="mark-icon" width="13" height="13" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="var(--ink)" />
        <path d="M5.6 9.2l2.3 2.3 4.5-4.8" fill="none" stroke="var(--ground)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }
  return (
    <svg class="mark-icon" width="13" height="13" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7.3" fill="none" stroke="var(--ink-2)" stroke-width="1.4" stroke-dasharray={standing === "Pending" ? "2.4 2.2" : undefined} />
      {standing === "Rejected" && <path d="M4.2 13.8l9.6-9.6" stroke="var(--ink-2)" stroke-width="1.4" stroke-linecap="round" />}
    </svg>
  );
}
