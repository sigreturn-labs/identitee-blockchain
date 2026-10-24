import type { ComponentChildren } from "preact";

/** The frame of every page: a frosted glass card, 440 px wide (780 px with `wide`, 560 px for the
 * editor with `edit`, which has inputs to fit). */
export function Card({
  children,
  wide = false,
  edit = false,
  label,
  busy = false,
}: {
  children?: ComponentChildren;
  wide?: boolean;
  edit?: boolean;
  label?: string;
  busy?: boolean;
}) {
  return (
    <section class={`card${wide ? " wide" : ""}${edit ? " edit" : ""} glass`} aria-label={label} aria-busy={busy || undefined}>
      {children}
    </section>
  );
}

/** A card holding one sober sentence, and what to do about it if there is something to do. */
export function MessageCard({ children, label, action }: { children: ComponentChildren; label?: string; action?: ComponentChildren }) {
  return (
    <Card label={label}>
      <p class="note">{children}</p>
      {action}
    </Card>
  );
}

/** What a profile card looks like before its data is there: the same head, the same width, a few
 * quiet bars. The page does not move when the real card replaces it. */
export function ProfileSkeleton() {
  return (
    <Card label="Loading" busy>
      <div class="head" aria-hidden="true">
        <span class="avatar bone" style={{ width: "56px", height: "56px" }} />
        <div>
          <span class="bone bar" style={{ width: "132px", height: "17px" }} />
          <span class="bone bar" style={{ width: "164px", height: "13px" }} />
        </div>
      </div>
      <div class="fields" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div class="row" key={i}>
            <span class="bone bar" style={{ width: "60px", height: "12px" }} />
            <span class="bone bar" style={{ width: "70%", height: "14px" }} />
            <span />
          </div>
        ))}
      </div>
    </Card>
  );
}
