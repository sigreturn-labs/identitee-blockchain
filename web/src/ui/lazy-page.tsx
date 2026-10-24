import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { MessageCard, ProfileSkeleton } from "./card.tsx";

/** What to show when the code of a page cannot be downloaded. After a new release, a tab that was
 * left open asks for chunks that no longer exist; reloading fetches the current ones. */
export function LoadFailed() {
  return (
    <MessageCard
      label="Not available"
      action={
        <button class="button" type="button" onClick={() => location.reload()}>
          Reload
        </button>
      }
    >
      This page could not be loaded. The site may have been updated.
    </MessageCard>
  );
}

/**
 * A page whose code is downloaded when its route is first visited. Until it arrives a quiet card
 * of the usual shape stands in (a visitor who opens a profile directly would otherwise see an
 * empty page while the chain libraries download); if the download fails, the card above, with a
 * Reload button. preact-iso's `lazy` shows nothing in that case: it keeps the rejected promise and
 * never renders again.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>, Fallback: ComponentType = ProfileSkeleton): ComponentType<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<void> | undefined;
  const start = (): Promise<void> =>
    (loading ??= load().then(
      (component) => {
        loaded = component;
      },
      (error: unknown) => {
        // forgotten, so that visiting the route again tries again
        loading = undefined;
        throw error;
      },
    ));

  return function Page(props: P) {
    const [, update] = useState(0);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (loaded) return;
      let current = true;
      start().then(
        () => current && update((n) => n + 1),
        () => current && setFailed(true),
      );
      return () => {
        current = false;
      };
    }, []);
    if (loaded) {
      const Loaded = loaded;
      return <Loaded {...props} />;
    }
    return failed ? <LoadFailed /> : <Fallback />;
  };
}
