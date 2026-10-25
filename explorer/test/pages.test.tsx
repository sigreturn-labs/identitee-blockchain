// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.tsx";
import { Value } from "../src/ui/value.tsx";
import { LocationProvider } from "preact-iso";
import { FakeEventSource } from "./support/no-network.ts";
import { PENDING, failing, serve, waitFor } from "./support/serve.ts";
import account from "./fixtures/account.json";
import block from "./fixtures/block.json";
import blocks from "./fixtures/blocks.json";
import events from "./fixtures/events.json";
import extrinsicFailed from "./fixtures/extrinsic-failed.json";
import extrinsicSudo from "./fixtures/extrinsic-sudo.json";
import extrinsics from "./fixtures/extrinsics.json";
import historyPage2 from "./fixtures/history-2.json";
import historyPage from "./fixtures/history.json";
import network from "./fixtures/network.json";
import stats from "./fixtures/stats.json";
import status from "./fixtures/status.json";
import transfers from "./fixtures/transfers.json";

const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const BOB = "idq6mNVZUu81C8CHeHPoHeScVrnwwiVw61SMCYkfeoAdHGiUc";
const ALICE_ED = "0x88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0ee";

const COMMON = { "/api/status": status, "/api/network": network };
const signedOnly = { ...extrinsics, items: extrinsics.items.filter((x) => x.signer !== null) };
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
const row = (label: string) => [...main().querySelectorAll(".x-fields .row")].find((r) => r.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
const expectClean = () => expect(root.textContent).not.toMatch(/[·—]/);

describe("Home", () => {
  it("shows the heads, the counters, the latest blocks, signed extrinsics and identitee events, and follows the live head", async () => {
    const asked = serve({
      ...COMMON,
      "/api/stats": stats,
      "/api/blocks": blocks,
      "/api/extrinsics?signed=1&limit=10": signedOnly,
      "/api/events": events,
    });
    open("/");
    await waitFor(() => expect(text()).toContain("Name bob assigned to idq6mN…dHGiUc"));
    const latest = main().querySelector('[aria-label="Latest blocks"]')!;
    await waitFor(() => expect(latest.textContent).toContain("1,240"));
    expect(latest.textContent).toContain("identitee-01");
    expect(text()).toContain("Accounts");
    expect(asked).toContain("/api/blocks?limit=10");
    expect(asked).toContain("/api/events?pallet=identitee&limit=10");
    // the API leaves the unsigned inherents out
    expect(asked).toContain("/api/extrinsics?signed=1&limit=10");
    // the producer's label comes with the block
    expect(asked).not.toContain("/api/network");
    const xts = main().querySelector('[aria-label="Latest extrinsics"]')!;
    await waitFor(() => expect(xts.textContent).toContain("identitee.claim_name"));
    expect(xts.textContent).not.toContain("timestamp.set");
    expectClean();

    const next = { ...blocks, items: [{ ...blocks.items[0]!, number: 1241 }, ...blocks.items] };
    serve({ ...COMMON, "/api/stats": stats, "/api/blocks": next, "/api/extrinsics": signedOnly, "/api/events": events });
    FakeEventSource.instances.at(-1)!.emit("head", '{"best":1241,"finalized":1238,"indexed":1241}');
    await waitFor(() => expect(latest.textContent).toContain("1,241"));
    await waitFor(() => expect(main().querySelector('[aria-label="Heads"]')?.textContent).toContain("1,238"));
  });

  it("shows the heads the API does not know while the node is down as unknown", async () => {
    const down = { ...status, best: null, finalized: null, node: "down" };
    serve({ "/api/status": down, "/api/stats": { ...stats, authorities: null }, "/api/blocks": blocks, "/api/extrinsics": extrinsics, "/api/events": events });
    open("/");
    const heads = await waitFor(() => {
      const h = main().querySelector('[aria-label="Heads"]');
      expect(h?.textContent).toContain("Indexed1,240");
      return h!;
    });
    expect(heads.textContent).toContain("BestUnknown");
    expect(heads.textContent).toContain("FinalizedUnknown");
    expect(heads.querySelector('a[href="/block/0"]')).toBeNull();
    expect(root.querySelector(".x-height a")).toBeNull();
    expectClean();
  });

  it("turns known heads back to unknown when the stream says the node went away", async () => {
    serve({ ...COMMON, "/api/stats": stats, "/api/blocks": blocks, "/api/extrinsics": extrinsics, "/api/events": events });
    open("/");
    const heads = await waitFor(() => {
      const h = main().querySelector('[aria-label="Heads"]');
      expect(h?.textContent).toContain("Finalized1,236");
      return h!;
    });
    FakeEventSource.instances.at(-1)!.emit("head", '{"best":null,"finalized":null,"indexed":1240}');
    await waitFor(() => expect(heads.textContent).toContain("FinalizedUnknown"));
    expect(heads.textContent).toContain("BestUnknown");
    expect(heads.textContent).toContain("Indexed1,240");
  });

  it("shows an error card when the API is down", async () => {
    open("/");
    await waitFor(() => expect(text()).toContain("The explorer API is not answering"));
    expectClean();
  });
});

describe("Block", () => {
  it("shows its fields, who produced it and the GRANDPA set that finalized it", async () => {
    const asked = serve({ "/api/status": status, "/api/block/1236": block });
    open("/block/1236");
    await waitFor(() => expect(root.querySelector("h1")?.textContent).toBe("Block 1,236"));
    await waitFor(() => expect(row("Produced by")).toBe("identitee-01"));
    await waitFor(() => expect(row("Finalized by")).toBe("GRANDPA authority set #0: identitee-01"));
    expect(row("Hash")).toContain(block.hash);
    expect(main().querySelector('[aria-label="Extrinsics"]')?.textContent).toContain("balances.transfer_keep_alive");
    expect(main().querySelector('[aria-label="Events"]')?.textContent).toContain("1 IDT sent from");
    expect(main().querySelector('a[rel="prev"]')?.getAttribute("href")).toBe("/block/1235");
    expect(main().querySelector('a[rel="next"]')?.getAttribute("href")).toBe("/block/1237");
    const logs = main().querySelector('[aria-label="Digest logs"]')!;
    expect(logs.textContent).toContain("PreRuntime");
    expect(logs.textContent).toContain("Seal");
    expect(logs.textContent).toContain("aura");
    expect(logs.textContent).toContain("0x2a5c8d1100000000");
    expect(asked).not.toContain("/api/network");
    expectClean();
  });

  it("says the digest logs are not available while the node is unreachable", async () => {
    serve({ "/api/status": status, "/api/block/1236": { ...block, logs: null } });
    open("/block/1236");
    await waitFor(() => expect(main().querySelector('[aria-label="Digest logs"]')?.textContent).toContain("Not available while the node is unreachable"));
    expectClean();
  });

  it("names the GRANDPA signers when the block carries a justification", async () => {
    const signers = [
      { key: ALICE_ED, label: "identitee-01" },
      { key: BOB_ED, label: "identitee-02" },
    ];
    serve({ "/api/status": status, "/api/block/1024": { ...block, number: 1024, justificationSigners: [ALICE_ED, BOB_ED], signers } });
    open("/block/1024");
    await waitFor(() => expect(row("Finalized by")).toBe("Signed by identitee-01, identitee-02"));
    expect(text()).not.toContain("GRANDPA authority set");
  });

  it("falls back to short keys when the labels are unknown", async () => {
    serve({ "/api/status": status, "/api/block/1024": { ...block, number: 1024, authorLabel: null, justificationSigners: [ALICE_ED], signers: [{ key: ALICE_ED, label: null }] } });
    open("/block/1024");
    await waitFor(() => expect(text()).toContain("Signed by 0x88dc34…a6b0ee"));
    expect(row("Produced by")).toBe("0xd43593…6da27d");
  });

  it("names only the set id when the members of the set are not known", async () => {
    serve({ "/api/status": status, "/api/block/1236": { ...block, authoritySet: { id: 4, members: null }, authoritySetId: 4 } });
    open("/block/1236");
    await waitFor(() => expect(row("Finalized by")).toBe("GRANDPA authority set #4"));
  });

  it("says Unknown for the finality until the finalized head is known", async () => {
    serve({ "/api/status": PENDING, "/api/block/1024": { ...block, number: 1024, justificationSigners: [ALICE_ED], signers: [{ key: ALICE_ED, label: "identitee-01" }] } });
    open("/block/1024");
    await waitFor(() => expect(row("Produced by")).toBe("identitee-01"));
    expect(row("Finalized by")).toBe("Unknown");
    expect(text()).not.toContain("Signed by");
  });

  it("says Unknown for the finality while the node is down", async () => {
    serve({ "/api/status": { ...status, best: null, finalized: null, node: "down" }, "/api/block/1236": block });
    open("/block/1236");
    await waitFor(() => expect(row("Hash")).toContain(block.hash));
    await new Promise((r) => setTimeout(r, 20));
    expect(row("Finalized by")).toBe("Unknown");
    expect(text()).not.toContain("GRANDPA authority set");
  });

  it("marks a block above the finalized head", async () => {
    serve({ ...COMMON, "/api/block/1240": { ...block, number: 1240 } });
    open("/block/1240");
    await waitFor(() => expect(text()).toContain("Not finalized yet"));
    expect(main().querySelector('a[rel="next"]')).toBeNull();
    // the header and the page follow the head on the same stream
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("renders a not-found card for a block the API does not know", async () => {
    serve(COMMON);
    open("/block/99999");
    await waitFor(() => expect(main().querySelector(".x-card")?.textContent).toContain("Not found"));
    expect(text()).toContain("No block 99999");
    expectClean();
  });
});

describe("Extrinsic", () => {
  it("shows a failed result with the error and its docs", async () => {
    serve({ ...COMMON, "/api/extrinsic/1239-1": extrinsicFailed });
    open("/extrinsic/1239-1");
    await waitFor(() => expect(text()).toContain("Failed"));
    expect(text()).toContain("identitee.NameTaken");
    expect(text()).toContain("The name is held by another account.");
    expect(text()).toContain("0.000098 IDT");
    expect(main().querySelector(`a[href="/account/${BOB}"]`)).not.toBeNull();
    expectClean();
  });

  it("renders a nested call with its arguments and address links", async () => {
    serve({ ...COMMON, "/api/extrinsic/1237-1": extrinsicSudo });
    open("/extrinsic/1237-1");
    await waitFor(() => expect(text()).toContain("identitee.set_username_for"));
    const call = main().querySelector('[aria-label="Call"]')!;
    expect(call.querySelector(".x-call .x-call")).not.toBeNull();
    expect(call.querySelector(`a[href="/account/${BOB}"]`)?.textContent).toBe("idq6mN…dHGiUc");
    expect(main().querySelector('[aria-label="Events"]')?.textContent).toContain("Name bob assigned");
    expectClean();
  });

  it("lists every inclusion of a hash found more than once", async () => {
    const hash = extrinsics.items[2]!.hash;
    serve({ ...COMMON, [`/api/extrinsic/${hash}`]: { matches: [extrinsics.items[2], { ...extrinsics.items[2], id: "1100-1", block: 1100 }] } });
    open(`/extrinsic/${hash}`);
    await waitFor(() => expect(text()).toContain("included 2 times"));
    expect(main().querySelector('a[href="/extrinsic/1100-1"]')).not.toBeNull();
  });
});

describe("Account", () => {
  it("shows balances, the identity with its trust badge, roles and the profile link", async () => {
    serve({ ...COMMON, [`/api/account/${ALICE}`]: account, [`/api/account/${ALICE}/history`]: historyPage, [`/api/account/${ALICE}/transfers`]: transfers });
    open(`/account/${ALICE}`);
    await waitFor(() => expect(text()).toContain("Alice"));
    expect(main().querySelector('svg[aria-label="Fully Verified"]')).not.toBeNull();
    expect(text()).toContain("1,152,921.504606846976 IDT");
    expect(text()).toContain("@alice");
    expect(text()).toContain("Sudo");
    expect(text()).toContain("Agent of identitee");
    const profile = main().querySelector<HTMLAnchorElement>('a[href="https://identit.ee/alice"]')!;
    expect(profile.textContent).toBe("View profile on identit.ee");
    expect(text()).toContain("identit.ee is in restricted access");
    expectClean();
  });

  it("pages through the history, and switches to transfers", async () => {
    const asked = serve({
      ...COMMON,
      [`/api/account/${ALICE}`]: account,
      [`/api/account/${ALICE}/history?limit=25`]: historyPage,
      [`/api/account/${ALICE}/history?limit=25&cursor=1235-e-1`]: historyPage2,
      [`/api/account/${ALICE}/transfers?limit=25`]: transfers,
    });
    open(`/account/${ALICE}`);
    const list = await waitFor(() => {
      const l = main().querySelector('[aria-label="History"]');
      expect(l?.textContent).toContain("balances.transfer_keep_alive");
      return l!;
    });
    expect(list.textContent).toContain("Email attested for");
    const more = [...main().querySelectorAll("button")].find((b) => b.textContent === "Load more")!;
    more.click();
    await waitFor(() => expect(main().querySelector('[aria-label="History"]')?.textContent).toContain("sudo.sudo"));
    expect(main().querySelector('[aria-label="History"]')?.textContent).toContain("balances.transfer_keep_alive");
    expect([...main().querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(false);
    expect(asked).toContain(`/api/account/${ALICE}/history?limit=25&cursor=1235-e-1`);

    [...main().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Transfers")!.click();
    await waitFor(() => expect(main().querySelector('[aria-label="Transfers"]')?.textContent).toContain("1 IDT"));
  });

  it("says what is missing while the node is away", async () => {
    serve({
      ...COMMON,
      [`/api/account/${BOB}`]: { ...account, address: BOB, balance: null, nonce: null, identity: null, roles: null, node: "down" },
      [`/api/account/${BOB}/history`]: { items: [], next: null },
    });
    open(`/account/${BOB}`);
    await waitFor(() => expect(text()).toContain("The node is not answering"));
    await waitFor(() => expect(text()).toContain("No activity for this account yet."));
  });
});

describe("Lists", () => {
  it("pages the blocks with Load more", async () => {
    const asked = serve({ "/api/status": status, "/api/blocks?limit=25": blocks, "/api/blocks?limit=25&cursor=1237": { items: [{ ...blocks.items[2]!, number: 1237, authorLabel: null }], next: null } });
    open("/blocks");
    await waitFor(() => expect(text()).toContain("1,238"));
    expect(text()).toContain("identitee-01");
    expect(asked).not.toContain("/api/network");
    [...main().querySelectorAll("button")].find((b) => b.textContent === "Load more")!.click();
    await waitFor(() => expect(text()).toContain("1,237"));
    expectClean();
  });

  it("lists extrinsics with their result", async () => {
    serve({ ...COMMON, "/api/extrinsics": extrinsics });
    open("/extrinsics");
    await waitFor(() => expect(text()).toContain("identitee.claim_name"));
    expect(text()).toContain("Failed");
    expect(text()).toContain("sudo.sudo");
    expect(text()).toContain("identitee.set_username_for");
    expectClean();
  });

  it("shows an empty state", async () => {
    serve({ ...COMMON, "/api/events": { items: [], next: null } });
    open("/events");
    await waitFor(() => expect(text()).toContain("No events yet."));
  });

  it("shows a skeleton while loading and an error card when the node is down", async () => {
    let answer: (r: Response) => void = () => {};
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
    open("/events");
    await waitFor(() => expect(main().querySelector('[aria-busy="true"]')).not.toBeNull());
    answer(new Response(JSON.stringify({ error: "node_down" }), { status: 503 }));
    serve({ "/api/events": failing(503, "node_down") });
    render(null, root);
    open("/events");
    await waitFor(() => expect(text()).toContain("The node behind the explorer is not answering"));
  });
});

describe("Value", () => {
  it("formats balances, links addresses and indents nested calls", () => {
    render(
      <LocationProvider>
        <Value value={{ dest: ALICE, value: "1500000000000", keep: true, note: null, list: [1, 2], call: { pallet: "system", method: "remark", args: { remark: "hi" } } }} />
      </LocationProvider>,
      root,
    );
    expect(root.textContent).toContain("1.5 IDT");
    expect(root.querySelector(`a[href="/account/${ALICE}"]`)).not.toBeNull();
    expect(root.querySelector(".x-call")?.textContent).toContain("system.remark");
    expect(root.textContent).toContain("hi");
    expect(root.textContent).toContain("Yes");
    expect(root.textContent).toContain("None");
    expectClean();
  });
});
