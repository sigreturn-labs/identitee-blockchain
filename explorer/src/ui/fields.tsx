// Pieces of the detail pages: a field row, a block title, who produced and who finalized a block.
import type { ComponentChildren } from "preact";
import type { BlockDetail, BlockItem, LabelledKey } from "../api.ts";
import { formatNumber, shortHash } from "../format.ts";
import { AccountLink, BlockLink } from "./table.tsx";

/** A page title for a block id: its number, or the edges of its hash. */
export const blockTitle = (id: string): string => (/^\d+$/.test(id) ? formatNumber(Number(id)) : shortHash(id));

export const Row = ({ label, children }: { label: string; children: ComponentChildren }) => (
  <div class="row">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** A key by its label, else by the edges of the key. */
export const keyName = (k: LabelledKey): string => k.label ?? shortHash(k.key);

/** The producer of a block: the account owning its Aura key (by its username or display name, as
 * any account link), else its label, else the edges of the key. */
export const Producer = ({ author, label, account }: { author: string | null; label: string | null; account: string | null }) =>
  account !== null ? (
    <AccountLink address={account} />
  ) : label !== null ? (
    <>{label}</>
  ) : author !== null ? (
    <span title={author}>{shortHash(author)}</span>
  ) : (
    <span class="x-quiet">Unknown</span>
  );

/** A block of a list, by its number, saying when it is not final yet. */
export const BlockCell = ({ block }: { block: Pick<BlockItem, "number" | "finalized"> }) => (
  <>
    <BlockLink n={block.number} />
    {!block.finalized && <span class="x-unfinal">Not finalized</span>}
  </>
);

/** Who finalized the block: the signers of its justification when it carries one, else the
 * GRANDPA set that was in charge (with its members when the node could read them). */
export function finalizedBy(block: BlockDetail): string {
  if (block.signers !== null) return `Signed by ${block.signers.map(keyName).join(", ")}`;
  // final, but not indexed yet: the set in charge is not known
  if (block.authoritySet === null) return "GRANDPA";
  const { id, members } = block.authoritySet;
  return `GRANDPA authority set #${id}${members !== null && members.length > 0 ? `: ${members.map(keyName).join(", ")}` : ""}`;
}
