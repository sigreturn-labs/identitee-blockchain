import type { Username } from "../api.ts";
import { FeedPage, FeedTable } from "../ui/feed.tsx";

export function Usernames() {
  return (
    <FeedPage title="Usernames">
      <FeedTable<Username> path="/api/usernames" label="Usernames" empty="No usernames yet." fallback={(u) => `Name ${u.name} ${u.kind}`} />
    </FeedPage>
  );
}
