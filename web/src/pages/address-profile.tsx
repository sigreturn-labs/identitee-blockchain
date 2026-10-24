import { ProfilePage } from "./profile.tsx";

/** `/a/:address`: the public profile of an address (any SS58 prefix, or a 0x public key). */
export function AddressProfile({ address = "" }: { address?: string }) {
  return <ProfilePage target={{ by: "address", address }} />;
}
