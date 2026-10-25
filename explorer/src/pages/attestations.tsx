import type { Attestation } from "../api.ts";
import { FeedPage, FeedTable } from "../ui/feed.tsx";

export function Attestations() {
  return (
    <FeedPage title="Attestations">
      <FeedTable<Attestation> path="/api/attestations" label="Attestations" empty="No attestations yet." fallback={(a) => `Attestation ${a.kind}`} />
    </FeedPage>
  );
}
