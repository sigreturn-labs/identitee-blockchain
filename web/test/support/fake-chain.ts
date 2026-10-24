// A small stand-in for the chain, for the editor's tests: it keeps one identity in the JSON shape
// the runtime API returns (so `decodeProfile` reads it like a real answer), applies the calls the
// editor sends, and remembers every argument it was given, which is what would have gone over the
// network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { decodeProfile, type Profile } from "../../src/chain/identity.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "profile-user.json"), "utf8")) as Record<string, any>;

export interface Sent {
  method: string;
  args: unknown[];
}

export function fakeChain(address: string, { empty = false }: { empty?: boolean } = {}) {
  const raw = structuredClone(fixture);
  raw.attestations = [];
  if (empty) raw.identity.typed = {};
  if (empty) raw.identity.custom = {};
  let blob: Uint8Array | null = null;
  const sent: Sent[] = [];

  const apply: Record<string, (...args: any[]) => void> = {
    setIdentity(changes: [any, any][]) {
      for (const [key, value] of changes) {
        const [table, name] = "Typed" in key ? [raw.identity.typed, key.Typed] : [raw.identity.custom, key.Custom];
        if (value === null) delete table[name];
        else table[name] = "Public" in value ? { public: value.Public } : { private: value.Private };
      }
    },
    setIdentitySecret(hex: string) {
      blob = hexToU8a(hex);
    },
    // in the pallet's order: the secret, the bio, the avatar, the fields, then the links
    updateProfile(update: any) {
      if (update.secret !== null) blob = hexToU8a(update.secret);
      if (update.bio !== null) raw.identity.bio = update.bio;
      if (update.avatar !== null) raw.identity.avatar = "Some" in update.avatar ? update.avatar.Some : null;
      apply.setIdentity!(update.fields);
      if (update.links !== null) {
        const byId = new Map((raw.identity.links ?? []).map((l: any) => [l.id, l]));
        raw.identity.links = update.links.map((edit: any) => {
          if ("Keep" in edit) return byId.get(edit.Keep);
          if ("Update" in edit) return { ...edit.Update };
          return { id: raw.identity.nextLinkId++, ...edit.Add };
        });
      }
    },
    revealField(key: any, value: string) {
      const [table, name] = "Typed" in key ? [raw.identity.typed, key.Typed] : [raw.identity.custom, key.Custom];
      table[name] = { public: value };
    },
  };

  /** `api.tx.identitee`: each call records its arguments and returns a marker `send` applies. */
  const tx = new Proxy(
    {},
    {
      // not a thenable: `await` would take it for a promise
      get: (_, method: string) =>
        method === "then"
          ? undefined
          : (...args: unknown[]) => {
          const call = { method, args };
          sent.push(call);
          return call;
        },
    },
  );

  return {
    sent,
    tx,
    /** What `tx.send` does once the call is "in a block". */
    include(call: Sent) {
      apply[call.method]?.(...call.args);
    },
    profile: (): Profile => decodeProfile(address, raw),
    secret: (): Uint8Array | null => (blob ? blob.slice() : null),
    setPrivate(kind: string, commitment: `0x${string}`) {
      raw.identity.typed[kind] = { private: commitment };
    },
    setSecret(bytes: Uint8Array) {
      blob = hexToU8a(u8aToHex(bytes));
    },
  };
}
