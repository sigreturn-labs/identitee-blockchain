// Whether the chosen account is an authority agent, for the header's menu. The answer needs the
// chain, which the first screen does not load: chain/agent.ts comes with `import()`, once an
// account is chosen, and the header never imports it. Asked again each time the menu opens, so an
// agent removed meanwhile loses the link.

import { useEffect, useState } from "preact/hooks";

/** `true` once the chain says `address` is an active agent the authority page has work for. */
export function useIsAgent(address: string | null, asked: unknown): boolean {
  const [agent, setAgent] = useState<{ address: string; is: boolean } | null>(null);
  useEffect(() => {
    if (address === null) return;
    let current = true;
    import("../chain/agent.ts")
      .then((module) => module.readAgent(address))
      .then(
        (found) => current && setAgent({ address, is: found !== null }),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [address, asked]);
  return address !== null && agent?.address === address && agent.is;
}
