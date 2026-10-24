import { AccountGate } from "../ui/account-gate.tsx";

// `/requests`: verifications, username, sub-accounts and migration. The page (and the chain
// libraries it needs) is only downloaded once an account is chosen; until then this is the
// Connect wallet card.
const loadRequests = () => import("./requests-page.tsx").then((module) => module.MyRequests);

export function Requests() {
  return <AccountGate load={loadRequests} purpose="Connect your wallet to see your requests." />;
}
