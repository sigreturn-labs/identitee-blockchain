import { AccountGate } from "../ui/account-gate.tsx";

// `/authority`: the work of an authority agent. The page (and the chain libraries it needs) is only
// downloaded once an account is chosen; until then this is the Connect wallet card. An account that
// is not an active agent gets the page that does not exist.
const loadAuthority = () => import("./authority-page.tsx").then((module) => module.AuthorityPage);

export function Authority() {
  return <AccountGate load={loadAuthority} purpose="Connect the wallet of an authority agent." />;
}
