// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import { forgetIdentities } from "../src/identities.ts";
import { AccountLink, accountName } from "../src/ui/table.tsx";
import { serve, waitFor } from "./support/serve.ts";
import status from "./fixtures/status.json";
import network from "./fixtures/network.json";

const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const BOB = "idq6mNVZUu81C8CHeHPoHeScVrnwwiVw61SMCYkfeoAdHGiUc";

let root: HTMLElement;
beforeEach(() => {
  forgetIdentities();
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

describe("Account links", () => {
  it("show the name, the edges of the address in brackets and the trust badge, read in one call", async () => {
    const asked = serve({
      "/api/identities": {
        items: {
          [ALICE]: { display: "Alice", username: "alice", trust: "FullyVerified" },
          [BOB]: { display: null, username: "bob", trust: "Declared" },
        },
      },
    });
    render(
      <div>
        <AccountLink address={ALICE} />
        <AccountLink address={BOB} />
        <AccountLink address={ALICE} />
      </div>,
      root,
    );
    const links = () => [...root.querySelectorAll("a.x-account")];
    const shown = (a: Element) => `${a.querySelector(".x-account-name")?.textContent} ${a.querySelector(".x-account-addr")?.textContent}`;
    await waitFor(() => expect(shown(links()[0]!)).toBe("@alice (idrf…3ogk)"));
    expect(links()[0]!.querySelector("svg.badge")?.getAttribute("aria-label")).toBe("Fully Verified");
    expect(shown(links()[1]!)).toBe("@bob (idq6…GiUc)");
    expect(links()[1]!.querySelector("svg.badge")).toBeNull();
    expect(asked).toEqual([`/api/identities?a=${ALICE},${BOB}`]);
  });

  it("keep the bare address when there is no identity or the read fails", async () => {
    serve({ "/api/identities": { status: 503, body: { error: "node_down" } } });
    render(<AccountLink address={ALICE} />, root);
    await new Promise((r) => setTimeout(r, 20));
    expect(root.textContent).toBe("idrfve…YX3ogk");
  });
});

describe("Account names", () => {
  it("prefer the username, then a display name that cannot pass for an address", () => {
    expect(accountName({ display: "Alice", username: "alice" })).toBe("@alice");
    expect(accountName({ display: "@alice", username: null })).toBeNull();
    expect(accountName({ display: "\uff20alice", username: null })).toBeNull();
    expect(accountName({ display: "\u24d0lice", username: null })).toBe("alice");
    expect(accountName({ display: "Alice", username: null })).toBe("Alice");
    expect(accountName({ display: "idsY…VC7q", username: null })).toBeNull();
    expect(accountName({ display: "idsYn8...R8VC7q", username: null })).toBeNull();
    expect(accountName({ display: "idsYn8tfPq3RVwqdz8ZtE2Kb7ByREd2JszPeZVPLCcR8VC7q", username: null })).toBeNull();
    expect(accountName({ display: "  ", username: null })).toBeNull();
    expect(accountName({ display: "Ech0 (idsY", username: null })).toBeNull();
    expect(accountName({ display: "idsY\u2024\u2024\u2024VC7q", username: null })).toBeNull();
    expect(accountName({ display: "Ech\u200b0", username: null })).toBeNull();
    expect(accountName({ display: "idsY\u22efVC7q", username: null })).toBeNull();
    expect(accountName({ display: "idsY\u2192VC7q", username: null })).toBeNull();
    expect(accountName({ display: "Charly Agent", username: null })).toBe("Charly Agent");
    expect(accountName({ display: "Zoë O'Brien-Smith", username: null })).toBe("Zoë O'Brien-Smith");
    expect(accountName(null)).toBeNull();
  });
});

describe("Docs", () => {
  it("lists the extrinsics, with the way to add an agent", async () => {
    serve({ "/api/status": status, "/api/network": network });
    history.replaceState(null, "", "/docs");
    render(<App />, root);
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Extrinsics"));
    expect(root.querySelector('.x-nav a[aria-current="page"]')?.textContent).toBe("Docs");
    expect(root.textContent).toContain("sudo(identitee.setAgent(0, <address>, 3))");
    expect(root.textContent).not.toMatch(/[·—]/);
  });
});
