import type { EventRow, Ts } from "../api.ts";
import { type Column, Age, BlockLink, PagedTable, useNow } from "../ui/table.tsx";

/** What an event says: its sentence when the explorer has one, else its name. */
export const EventText = ({ e }: { e: EventRow }) =>
  e.sentence !== null ? (
    <span class="x-sentence">{e.sentence}</span>
  ) : (
    <span>
      {e.pallet}.{e.method}
    </span>
  );

export function eventColumns(now: number, withBlock = true): Column<EventRow & Partial<Ts>>[] {
  return [
    { label: "Event", cell: (e) => e.id },
    ...(withBlock
      ? [
          { label: "Block", cell: (e: EventRow) => <BlockLink n={e.block} /> },
          { label: "Age", cell: (e: EventRow & Partial<Ts>) => <Age ms={e.timestamp ?? null} now={now} /> },
        ]
      : []),
    { label: "What", cell: (e) => <EventText e={e} />, class: "x-wide" },
    {
      label: "Extrinsic",
      cell: (e) => (e.extrinsicIndex === null ? <span class="x-quiet">None</span> : <a href={`/extrinsic/${e.block}-${e.extrinsicIndex}`}>{`${e.block}-${e.extrinsicIndex}`}</a>),
    },
  ];
}

export function Events() {
  const now = useNow();
  return (
    <section class="x-page">
      <h1>Events</h1>
      <PagedTable<EventRow & Ts> path="/api/events" label="Events" empty="No events yet." rowKey={(e) => e.id} columns={eventColumns(now)} />
    </section>
  );
}
