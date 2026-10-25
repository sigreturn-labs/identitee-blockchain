import type { Migration } from "../api.ts";
import { FeedPage, FeedTable } from "../ui/feed.tsx";

export function Migrations() {
  return (
    <FeedPage title="Migrations">
      <FeedTable<Migration> path="/api/migrations" label="Migrations" empty="No migrations yet." fallback={(m) => `Migration ${m.kind}`} />
    </FeedPage>
  );
}
