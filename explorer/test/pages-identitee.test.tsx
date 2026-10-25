// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import { failing, serve, waitFor } from "./support/serve.ts";
import attestations from "./fixtures/attestations.json";
import authorities from "./fixtures/authorities.json";
import authority from "./fixtures/authority.json";
import migrations from "./fixtures/migrations.json";
import network from "./fixtures/network.json";
import runtime from "./fixtures/runtime.json";
import status from "./fixtures/status.json";
import usernames from "./fixtures/usernames.json";

const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const BOB = "idq6mNVZUu81C8CHeHPoHeScVrnwwiVw61SMCYkfeoAdHGiUc";
const BOB_ED = "0xd17c2d7823ebf260fd138f2d7e27d114c0145d968b5ff5006125f2414fadae69";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

function open(path: string) {
  history.replaceState(null, "", path);
  render(<App />, root);
}

const main = () => root.querySelector("main")!;
const text = () => main().textContent ?? "";
const part = (label: string) => main().querySelector(`[aria-label="${label}"]`);
const row = (label: string) => [...main().querySelectorAll(".x-fields .row")].find((r) => r.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
const expectClean = () => expect(root.textContent).not.toMatch(/[·—]/);

describe("Authorities", () => {
  it("lists each authority with its status and agent count", async () => {
    serve({ "/api/status": status, "/api/authorities": authorities });
    open("/authorities");
    const table = await waitFor(() => {
      const t = part("Authorities");
      expect(t?.textContent).toContain("identitee");
      return t!;
    });
    expect(table.querySelector('a[href="/authority/0"]')?.textContent).toBe("identitee");
    expect(table.querySelector('a[href="/authority/1"]')?.textContent).toBe("example.com");
    const rows = [...table.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((d) => d.textContent));
    expect(rows[0]).toEqual(["identitee", "0", "Active", "2"]);
    expect(rows[1]).toEqual(["example.com", "1", "Inactive", "0"]);
    expectClean();
  });

  it("says when the node behind the list is not answering", async () => {
    serve({ "/api/status": status, "/api/authorities": failing(503, "node_down") });
    open("/authorities");
    await waitFor(() => expect(text()).toContain("The node behind the explorer is not answering"));
  });
});

describe("Authority", () => {
  it("shows its agents with their capabilities and its latest attestations", async () => {
    const asked = serve({ "/api/status": status, "/api/authority/0": authority, "/api/attestations?authority=0&limit=25": attestations });
    open("/authority/0");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("identitee"));
    expect(row("Status")).toBe("Active");
    const agents = part("Agents")!;
    expect(agents.querySelector(`a[href="/account/${ALICE}"]`)).not.toBeNull();
    expect(agents.textContent).toContain("Attest fields, Person facts");
    await waitFor(() => expect(part("Attestations")?.textContent).toContain("Email attested for idrfve…YX3ogk by identitee"));
    expect(asked).toContain("/api/attestations?authority=0&limit=25");
    expectClean();
  });

  it("keeps the attestations on screen while the node is away", async () => {
    serve({ "/api/status": status, "/api/authority/0": failing(503, "node_down"), "/api/attestations?authority=0&limit=25": attestations });
    open("/authority/0");
    await waitFor(() => expect(text()).toContain("The node behind the explorer is not answering"));
    await waitFor(() => expect(part("Attestations")?.textContent).toContain("Email attested"));
    expect(root.querySelector("h1")?.textContent).toBe("Authority 0");
  });

  it("renders a not-found card for an unknown authority", async () => {
    serve({ "/api/status": status, "/api/authority/9": failing(404, "not_found"), "/api/attestations": { items: [], next: null } });
    open("/authority/9");
    await waitFor(() => expect(text()).toContain("No authority 9 on this chain."));
  });
});

describe("Feeds", () => {
  it("lists attestations newest first with the account, the block and the age", async () => {
    serve({ "/api/status": status, "/api/attestations?limit=25": attestations });
    open("/attestations");
    const table = await waitFor(() => {
      const t = part("Attestations");
      expect(t?.textContent).toContain("Email attested for idrfve…YX3ogk by identitee");
      return t!;
    });
    const sentences = [...table.querySelectorAll("tbody tr")].map((r) => r.querySelector("td")?.textContent);
    expect(sentences[0]).toContain("Email attested");
    expect(sentences[1]).toContain("asked identitee");
    // an event the explorer cannot phrase still says what happened
    expect(sentences[2]).toBe("Attestation revoked");
    expect(table.querySelector(`a[href="/account/${ALICE}"]`)).not.toBeNull();
    expect(table.querySelector('a[href="/block/1235"]')?.textContent).toBe("1,235");
    expect(table.querySelector("time")).not.toBeNull();
    expect([...main().querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(true);
    expect(main().querySelector('[aria-label="Identity feeds"] a[aria-current="page"]')?.textContent).toBe("Attestations");
    expectClean();
  });

  it("lists migrations", async () => {
    serve({ "/api/status": status, "/api/migrations": migrations });
    open("/migrations");
    await waitFor(() => expect(part("Migrations")?.textContent).toContain("Identity of idrfve…YX3ogk migrated from People Chain block 4100200"));
    expect(part("Migrations")!.querySelector('a[href="/block/1220"]')).not.toBeNull();
    expectClean();
  });

  it("lists usernames, a reserved name having no account", async () => {
    serve({ "/api/status": status, "/api/usernames": usernames });
    open("/usernames");
    const table = await waitFor(() => {
      const t = part("Usernames");
      expect(t?.textContent).toContain("Name bob assigned to idq6mN…dHGiUc");
      return t!;
    });
    expect(table.querySelector(`a[href="/account/${BOB}"]`)).not.toBeNull();
    expect(table.textContent).toContain("Name admin reserved");
    expect(table.textContent).toContain("None");
    expectClean();
  });

  it("shows an empty feed", async () => {
    serve({ "/api/status": status, "/api/migrations": { items: [], next: null } });
    open("/migrations");
    await waitFor(() => expect(text()).toContain("No migrations yet."));
  });
});

describe("Runtime", () => {
  it("shows the current spec, the upgrades and the calls of the Identitee pallet", async () => {
    serve({ "/api/status": status, "/api/runtime": runtime });
    open("/runtime");
    await waitFor(() => expect(row("Spec name")).toBe("identitee"));
    expect(row("Spec version")).toBe("3");
    const upgrades = part("Upgrades")!;
    expect(upgrades.querySelector('a[href="/block/980"]')).not.toBeNull();
    // newest first
    expect(upgrades.querySelector("tbody tr td")?.textContent).toBe("3");
    const pallet = [...main().querySelectorAll("details")].find((d) => d.querySelector("summary")?.textContent?.startsWith("Identitee"))!;
    const calls = pallet.querySelector('[aria-label="Calls of Identitee"]')!;
    expect(calls.textContent).toContain("claim_name");
    expect(calls.textContent).toContain("Claim a free name for the caller.");
    expect(calls.textContent).toContain("request_attestation");
    expect(pallet.textContent).toContain("NameTaken");
    expect(pallet.textContent).toContain("NameDeposit");
    expectClean();
  });

  it("says the current version is unknown when the API has none", async () => {
    serve({ "/api/status": status, "/api/runtime": { ...runtime, current: null } });
    open("/runtime");
    await waitFor(() => expect(row("Spec version")).toBe("Unknown"));
  });
});

describe("Network", () => {
  it("shows the validators with their keys and roles, the peers, the block time and the set id", async () => {
    const two = {
      ...network,
      validators: { ...network.validators, grandpa: [...network.validators.grandpa, { key: BOB_ED, weight: 1, label: null }] },
    };
    serve({ "/api/status": status, "/api/network": two });
    open("/network");
    const table = await waitFor(() => {
      const t = part("Validators");
      expect(t?.textContent).toContain("identitee-01");
      return t!;
    });
    const rows = [...table.querySelectorAll("tbody tr")];
    // the Aura and GRANDPA keys of one label are one validator
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("0xd43593…6da27d");
    expect(rows[0]!.textContent).toContain("0x88dc34…a6b0ee");
    expect(rows[0]!.textContent).toContain("Producing");
    expect(rows[0]!.textContent).toContain("Finalizing");
    expect(rows[1]!.textContent).toContain("0xd17c2d…adae69");
    expect(rows[1]!.textContent).not.toContain("Producing");
    expect(row("Peers")).toBe("1");
    expect(row("Block time")).toBe("6.01 s on average over the last 100 blocks, target 6 s");
    expect(row("GRANDPA set")).toBe("#0");
    expectClean();
  });

  it("says when the node is not answering", async () => {
    serve({ "/api/status": status, "/api/network": failing(503, "node_down") });
    open("/network");
    await waitFor(() => expect(text()).toContain("The node behind the explorer is not answering"));
  });
});
