import { AccountGate } from "../ui/account-gate.tsx";

// `/me`: editing your own identity. The editor (and the chain libraries it needs) is only
// downloaded once an account is chosen; until then this is the Connect wallet card.
const loadEditor = () => import("./me-editor.tsx").then((module) => module.MyIdentity);

export function Me() {
  return <AccountGate load={loadEditor} purpose="Connect your wallet to create or edit your identity." />;
}
