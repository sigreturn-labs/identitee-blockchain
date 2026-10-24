import { useEffect } from "preact/hooks";
import { MessageCard } from "../ui/card.tsx";
import { Lookup } from "../ui/lookup.tsx";

export function NotFound() {
  useEffect(() => {
    document.title = "Not found - identit.ee";
    return () => {
      document.title = "identit.ee";
    };
  }, []);
  return (
    <MessageCard label="Not found" action={<Lookup />}>
      Page not found.
    </MessageCard>
  );
}
