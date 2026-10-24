import { AccountGate, type GateProps } from "../ui/account-gate.tsx";

/** `/`: the profile of the connected account, or a way to connect. */
const loadProfile = () =>
  import("./profile.tsx").then(
    (module) =>
      function OwnProfile({ address }: GateProps) {
        return <module.ProfilePage target={{ by: "address", address }} own />;
      },
  );

export function Home() {
  return <AccountGate load={loadProfile} lookup />;
}
