// Pieces of the detail pages: a field row, a block title, and who finalized a block.
import type { ComponentChildren } from "preact";
import type { BlockDetail } from "../api.ts";
import { type Labels, keyLabel } from "../data.ts";
import { formatNumber, shortHash } from "../format.ts";

/** A page title for a block id: its number, or the edges of its hash. */
export const blockTitle = (id: string): string => (/^\d+$/.test(id) ? formatNumber(Number(id)) : shortHash(id));

export const Row = ({ label, children }: { label: string; children: ComponentChildren }) => (
  <div class="row">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** Who finalized the block: the signers of its justification when it carries one, else the
 * GRANDPA set that was in charge (with its members when the node is on that set). */
export function finalizedBy(block: BlockDetail, labels: Labels): string {
  if (block.justificationSigners !== null) return `Signed by ${block.justificationSigners.map((k) => keyLabel(labels, k, shortHash)).join(", ")}`;
  const members = labels.setId === block.authoritySetId && labels.grandpa.length > 0 ? `: ${labels.grandpa.join(", ")}` : "";
  return `GRANDPA authority set #${block.authoritySetId}${members}`;
}
