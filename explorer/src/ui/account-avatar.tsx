import { useState } from "preact/hooks";
import { Avatar } from "@web/ui/avatar.tsx";
import type { PublicKey } from "@web/ui/pixels.ts";
import { API } from "../api.ts";

/** The avatar an account set on chain, read from the API, else (none set, or an image the browser
 * cannot show) the avatar generated from its key. `version` is the hash the API gives with the
 * identity, so a new image is never served from the cache of the old one. */
export function AccountAvatar({ address, publicKey, version, size }: { address: string; publicKey: PublicKey; version: string | null | undefined; size: number }) {
  // the image that failed, not a flag: a new image gets its own chance
  const [failed, setFailed] = useState<string | null>(null);
  const src = version ? `${API}/api/avatar/${encodeURIComponent(address)}?v=${encodeURIComponent(version)}` : null;
  if (src === null || failed === src) return <Avatar publicKey={publicKey} size={size} />;
  return <img class="avatar" src={src} width={size} height={size} alt="" onError={() => setFailed(src)} />;
}
