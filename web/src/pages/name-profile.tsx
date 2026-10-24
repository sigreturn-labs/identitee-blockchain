import { ProfilePage } from "./profile.tsx";

/** `/:name`: the public profile of a username. */
export function NameProfile({ name = "" }: { name?: string }) {
  return <ProfilePage target={{ by: "name", name }} />;
}
