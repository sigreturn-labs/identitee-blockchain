// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/chain/agent.ts";
import { privateCommitment } from "../src/chain/formulas.ts";
import { decodeProfile, type NameStatus, type Profile } from "../src/chain/identity.ts";
import { type Account, commitmentIn, inboxItem, type InboxItem } from "../src/chain/inbox.ts";
import { makePacket } from "../src/chain/packet.ts";
import type { SendResult } from "../src/chain/tx.ts";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";

// The authority page, with the chain replaced by a small world (the agent, the inbox, an account,
// the reserved names) and the calls by markers the test can read. What is under test is who sees the
// page, which actions each capability shows, what is sent and against which commitment, and that a
// pasted packet's value and salt go nowhere.

const { readAgent, readInbox, readReserved, readAccount, commitmentNow, profileNow, genesisHash, readNamingTimes, nameStatus, send, calls } = vi.hoisted(() => ({
  readAgent: vi.fn(),
  readInbox: vi.fn(),
  readReserved: vi.fn(),
  readAccount: vi.fn(),
  commitmentNow: vi.fn(),
  profileNow: vi.fn(),
  genesisHash: vi.fn(),
  readNamingTimes: vi.fn(),
  nameStatus: vi.fn(),
  send: vi.fn(),
  calls: {
    provideJudgementCall: vi.fn(),
    rejectRequestCall: vi.fn(),
    revokeAttestationCall: vi.fn(),
    grantFactCall: vi.fn(),
    revokeFactCall: vi.fn(),
    reserveUsernameCall: vi.fn(),
    unreserveUsernameCall: vi.fn(),
    setUsernameForCall: vi.fn(),
    unbindUsernameCall: vi.fn(),
  },
}));
vi.mock("../src/chain/agent.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/agent.ts")>()), readAgent }));
vi.mock("../src/chain/inbox.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/inbox.ts")>()),
  readInbox,
  readReserved,
  readAccount,
  commitmentNow,
  profileNow,
  genesisHash,
}));
vi.mock("../src/chain/naming.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/naming.ts")>()), readNamingTimes }));
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/identity.ts")>()), nameStatus }));
vi.mock("../src/chain/tx.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/tx.ts")>()), send }));
vi.mock("../src/chain/calls.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/calls.ts")>()), ...calls }));

import { AuthorityPage } from "../src/pages/authority-page.tsx";

const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const GENESIS = `0x${"35".repeat(32)}` as const;
const SALT = new Uint8Array(32).fill(0x5a);
const SECRET_VALUE = "@canary_telegram_4411";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as any;
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const OK: SendResult = { ok: true, events: [], blockHash: "0x01" };
const AUTHORITY = { id: 0, name: "identitee", active: true };
const ALL: Agent = { authority: AUTHORITY, attest: true, facts: true, names: true };

/** The fixture's identity, its Telegram private under SALT and SECRET_VALUE, nothing attested by authority 0. */
function userProfile(change: (raw: any) => void = () => undefined): Profile {
  const raw = structuredClone(fixture);
  raw.identity.typed.Telegram = { private: privateCommitment(SALT, SECRET_VALUE) };
  change(raw);
  return decodeProfile(USER, raw);
}

interface World {
  agent: Agent | null;
  profile: Profile;
  /** From USER unless `who` says otherwise; another requester has no identity. */
  requests: { target: any; since: number; who?: string }[];
  reserved: string[];
  account: Account | null;
}
let world: World;
const inbox = (): InboxItem[] =>
  world.requests.map((r) => inboxItem({ who: r.who ?? USER, target: r.target, since: r.since }, (r.who ?? USER) === USER ? world.profile : null));

function apply({ call, args }: { call: string; args: any[] }) {
  const drop = (id: string) => (world.requests = world.requests.filter((r) => JSON.stringify(r.target) !== id));
  switch (call) {
    case "provideJudgementCall":
      drop(JSON.stringify({ field: args[1] }));
      break;
    case "rejectRequestCall":
      drop(JSON.stringify(args[1]));
      break;
    case "grantFactCall":
      drop(JSON.stringify({ fact: args[1] }));
      if (world.account) world.account.facts[args[1] as "Fraud"] = { state: "active", issuedAt: 9 };
      break;
    case "revokeFactCall":
      if (world.account) world.account.facts[args[1] as "Fraud"] = { state: "revoked", issuedAt: 9 };
      break;
    case "reserveUsernameCall":
      world.reserved = [...world.reserved, args[0]].sort();
      break;
    case "unreserveUsernameCall":
      world.reserved = world.reserved.filter((n) => n !== args[0]);
      break;
  }
}

const signerFor = vi.fn();
const wallet = { signerFor } as unknown as WalletModule;
let root: HTMLElement | undefined;
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function open(change: (w: World) => void = () => undefined) {
  world = {
    agent: ALL,
    profile: userProfile(),
    requests: [
      { target: { field: { typed: "Email" } }, since: 3 },
      { target: { field: { typed: "Telegram" } }, since: 4 },
      { target: { field: { link: 1 } }, since: 5 },
      { target: { fact: "DocumentChecked" }, since: 6 },
    ],
    reserved: ["reservedname"],
    account: null,
  };
  change(world);
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<AuthorityPage address={ALICE} wallet={wallet} />, root!));
  await settle();
  return root;
}

const section = (name: string) => root!.querySelector(`section[aria-label="${name}"]`)!;
const byLabel = <T extends Element = HTMLButtonElement>(label: string, within: ParentNode = root!): T | null => within.querySelector<T>(`[aria-label="${label}"]`);
const buttonNamed = (name: string, within: ParentNode = root!): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((b) => text(b) === name || b.getAttribute("aria-label") === name);
const click = async (b: Element | null | undefined) => {
  if (!b) throw new Error("no such button");
  await act(() => (b as HTMLElement).click());
  await settle();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  el!.value = value;
  await act(() => void el!.dispatchEvent(new Event("input", { bubbles: true })));
};
const choose = async (el: HTMLSelectElement | null, value: string) => {
  el!.value = value;
  await act(() => void el!.dispatchEvent(new Event("change", { bubbles: true })));
};
const rows = (list: string) => [...root!.querySelectorAll(`ul[aria-label="${list}"] > li`)];
/** The requests waiting, every person's together, in the order shown. */
const waiting = () => [...root!.querySelectorAll("ul.inbox > li")];
const SHORT = `${USER.slice(0, 8)}…${USER.slice(-8)}`;
/** The requester as the buttons of the inbox name them: the name and the short address. */
const WHO = `Fixture User (${SHORT})`;
/** The line under a row that tells the result of an action on that row. */
const rowLine = (li: Element) => li.querySelector(":scope > .ask-note:not(.panel)")!;

let user: ReturnType<Keyring["addFromUri"]>;
let stranger: ReturnType<Keyring["addFromUri"]>;
beforeAll(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
  user = keyring.addFromUri("//F2User");
  stranger = keyring.addFromUri("//F2Eve");
  expect(user.address).toBe(USER);
});
const packetOf = async (pair = user, overrides: Partial<Parameters<typeof makePacket>[0]> = {}) =>
  JSON.stringify(
    await makePacket(
      { chain: GENESIS, address: pair.address, ref: { typed: "Telegram" }, value: stringToU8a(SECRET_VALUE), salt: SALT, ...overrides },
      async (data) => u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data)))),
    ),
  );

beforeEach(() => {
  for (const mock of [readAgent, readInbox, readReserved, readAccount, commitmentNow, profileNow, genesisHash, readNamingTimes, nameStatus, send, signerFor, ...Object.values(calls)]) mock.mockReset();
  readAgent.mockImplementation(async () => world.agent);
  readInbox.mockImplementation(async () => inbox());
  readReserved.mockImplementation(async () => [...world.reserved]);
  readAccount.mockImplementation(async () => structuredClone(world.account));
  commitmentNow.mockImplementation(async (_who: string, ref: any) => commitmentIn(world.profile, ref));
  profileNow.mockImplementation(async () => world.profile);
  genesisHash.mockResolvedValue(GENESIS);
  readNamingTimes.mockResolvedValue({ clock: { block: 1000, blockSeconds: 6 }, cooldownBlocks: 14400, quarantineBlocks: 432000, lastRelease: null });
  nameStatus.mockImplementation(async (): Promise<NameStatus> => ({ state: "available" }));
  signerFor.mockImplementation(async (address: string) => ({ address, signer: {} }));
  send.mockImplementation(async (call: any) => {
    apply(call);
    return OK;
  });
  for (const [name, mock] of Object.entries(calls)) mock.mockImplementation(async (...args: unknown[]) => ({ call: name, args }));
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

describe("who sees the page", () => {
  it("is Page not found for an account that is not an active agent, and nothing else is read", async () => {
    await open((w) => (w.agent = null));
    expect(text(root!.querySelector(".note"))).toBe("Page not found.");
    expect(readAgent).toHaveBeenCalledWith(ALICE);
    expect(readInbox).not.toHaveBeenCalled();
    expect(readReserved).not.toHaveBeenCalled();
  });

  it("shows an agent with every capability its three sections, under the authority's name", async () => {
    await open();
    expect(root!.querySelector(".card")!.getAttribute("aria-label")).toBe("Authority");
    expect(text(root!.querySelector(".name"))).toBe("identitee");
    expect(text(root!.querySelector(".head .addr"))).toBe("Agent, verifies fields, records facts and manages names");
    expect([...root!.querySelectorAll("section.block")].map((s) => s.getAttribute("aria-label"))).toEqual(["Requests", "Accounts", "Reserved names"]);
    expect(readInbox).toHaveBeenCalledWith(0);
  });

  it("shows an agent that only manages names no request and no fact", async () => {
    await open((w) => {
      w.agent = { ...ALL, attest: false, facts: false };
      w.account = { address: USER, profile: w.profile, facts: { DocumentChecked: null, Fraud: null } };
    });
    expect([...root!.querySelectorAll("section.block")].map((s) => s.getAttribute("aria-label"))).toEqual(["Accounts", "Reserved names"]);
    expect(readInbox).not.toHaveBeenCalled();
    await type(byLabel<HTMLInputElement>("Account address"), USER);
    await click(buttonNamed("Look up"));
    expect(root!.querySelector('ul[aria-label="Facts"]')).toBeNull();
    expect(root!.querySelector('ul[aria-label="Verifications"]')).toBeNull();
    expect(byLabel("Take the username fixtureuser away")).not.toBeNull();
  });

  it("shows an agent that only records facts the fact requests, and no Reserved names", async () => {
    await open((w) => (w.agent = { ...ALL, attest: false, names: false }));
    expect([...root!.querySelectorAll("section.block")].map((s) => s.getAttribute("aria-label"))).toEqual(["Requests", "Accounts"]);
    expect(waiting().map((li) => text(li.querySelector(".ask-label")))).toEqual(["Identity document"]);
  });
});

describe("requests", () => {
  it("lists them oldest first, with the requester and the public value", async () => {
    await open();
    const list = waiting();
    expect(list.map((li) => text(li.querySelector(".ask-label")))).toEqual(["Email", "Telegram", "Code", "Identity document"]);
    expect([...list[0]!.querySelectorAll(".ask-value")].map((e) => text(e))).toEqual(["user@example.org"]);
    // the requester heads their group: the name, the short address (two people can share a name), the count
    expect(text(section("Requests").querySelector(":scope > .hint"))).toBe("4 requests from 1 person");
    const who = root!.querySelector("h3.inbox-who")!;
    expect([text(who.querySelector("a")), ...[...who.querySelectorAll(".addr")].map((e) => text(e))]).toEqual(["Fixture User", SHORT, "4 requests"]);
    expect(who.querySelector("a")!.getAttribute("href")).toBe("/fixtureuser");
    expect(root!.querySelector(`ul[aria-label="Requests from ${WHO}"]`)).not.toBeNull();
    expect(text(list[1]!.querySelector(".ask-value.private"))).toBe("Private");
    expect(text(list[2]!.querySelector(".ask-value"))).toBe("https://git.example/user");
  });

  it("groups them per person, in the order of their oldest request, and counts them", async () => {
    await open((w) => (w.requests = [{ target: { fact: "DocumentChecked" }, since: 2, who: ALICE }, ...w.requests]));
    const alice = `${ALICE.slice(0, 8)}…${ALICE.slice(-8)}`;
    expect(text(section("Requests").querySelector(":scope > .hint"))).toBe("5 requests from 2 people");
    // a person without identity is named by the short address alone
    expect([...root!.querySelectorAll("h3.inbox-who")].map((h) => text(h.querySelector("a")))).toEqual([alice, "Fixture User"]);
    expect([...root!.querySelectorAll("h3.inbox-who")].map((h) => text(h.querySelector(".addr:last-child")))).toEqual(["1 request", "4 requests"]);
    expect(rows(`Requests from ${alice}`).map((li) => text(li.querySelector(".ask-label")))).toEqual(["Identity document"]);
    expect(byLabel(`Record the identity document of ${alice}`)).not.toBeNull();
  });

  it("offers a way to each section from the top", async () => {
    await open();
    expect([...root!.querySelectorAll('nav[aria-label="Sections"] a')].map((a) => a.getAttribute("href"))).toEqual(["#requests", "#accounts", "#reserved"]);
    expect(["requests", "accounts", "reserved"].map((id) => root!.querySelector(`#${id}`)?.getAttribute("aria-label"))).toEqual(["Requests", "Accounts", "Reserved names"]);
  });

  it("closes the panel of a row with Escape", async () => {
    await open();
    await click(byLabel(`Dismiss the request for Email of ${WHO}`));
    const panel = () => root!.querySelector('[role="group"][aria-label="Dismiss the request for Email"]');
    expect(panel()).not.toBeNull();
    await act(() => void byLabel<HTMLInputElement>("Note")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel()).toBeNull();
    expect(byLabel(`Verify Email of ${WHO}`)).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("dismisses with Enter in the note, and says the note is not shown to the person", async () => {
    await open();
    await click(byLabel(`Dismiss the request for Email of ${WHO}`));
    const note = byLabel<HTMLInputElement>("Note")!;
    expect(note.placeholder).toBe("Note (optional)");
    expect(text(root!.querySelector('[aria-label="Dismiss the request for Email"] .hint'))).toBe(
      "Dismissing records nothing on the identity, and the person can ask again. The reason and the note stay in the chain's history; this site does not show them to the person.",
    );
    await type(note, "duplicate");
    await act(() => void note.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await settle();
    expect(calls.rejectRequestCall).toHaveBeenCalledWith(USER, { field: { typed: "Email" } }, "Unspecified", "duplicate");
  });

  it("verifies a public field against the commitment read from the chain at that moment", async () => {
    await open();
    await click(byLabel(`Verify Email of ${WHO}`));
    expect(commitmentNow).toHaveBeenCalledWith(USER, { typed: "Email" });
    expect(calls.provideJudgementCall).toHaveBeenCalledWith(USER, { typed: "Email" }, commitmentIn(world.profile, { typed: "Email" })!.commitment, "Verified");
    expect(text(section("Requests").querySelector(".status"))).toBe("Email verified.");
    expect(waiting().map((li) => text(li.querySelector(".ask-label")))).toEqual(["Telegram", "Code", "Identity document"]);
  });

  it("verifies a link against its title and address", async () => {
    await open();
    await click(byLabel(`Verify Code of ${WHO}`));
    expect(calls.provideJudgementCall).toHaveBeenCalledWith(USER, { link: 1 }, commitmentIn(world.profile, { link: 1 })!.commitment, "Verified");
  });

  it("signs nothing when the field changed since the page was read", async () => {
    await open();
    world.profile = userProfile((raw) => (raw.identity.typed.Email = { public: u8aToHex(stringToU8a("other@example.org")) }));
    await click(byLabel(`Verify Email of ${WHO}`));
    expect(calls.provideJudgementCall).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(text(section("Requests").querySelector(".problem"))).toBe("The field changed since the page was read. Look at it again.");
    // the page read again: the row now shows the new value
    expect(text(waiting()[0]!.querySelector(".ask-value"))).toBe("other@example.org");
  });

  it("rejects the value of a field after a question, against the commitment read at that moment", async () => {
    await open();
    await click(byLabel(`Reject the value of Email of ${WHO}`));
    expect(calls.provideJudgementCall).not.toHaveBeenCalled();
    expect(text(root!.querySelector('[aria-label="Reject the value of Email"] .hint'))).toBe(
      "Record on the identity that this Email was checked and refused? It counts as not verified while the person keeps this value.",
    );
    await click(buttonNamed("Reject the value", root!.querySelector('[role="group"][aria-label="Reject the value of Email"]')!));
    expect(commitmentNow).toHaveBeenCalledWith(USER, { typed: "Email" });
    expect(calls.provideJudgementCall).toHaveBeenCalledWith(USER, { typed: "Email" }, commitmentIn(world.profile, { typed: "Email" })!.commitment, "Rejected");
    expect(text(section("Requests").querySelector(".status"))).toBe("Email rejected.");
  });

  it("verifies with the Verified verdict", async () => {
    await open();
    await click(byLabel(`Verify Code of ${WHO}`));
    expect(calls.provideJudgementCall.mock.calls[0]![3]).toBe("Verified");
  });

  it("dismisses a request with the reason and the note chosen, recording nothing on the identity", async () => {
    await open();
    await click(byLabel(`Dismiss the request for Email of ${WHO}`));
    await choose(byLabel<HTMLSelectElement>("Reason"), "Disposable");
    await type(byLabel<HTMLInputElement>("Note"), "temporary inbox");
    expect(text(root!.querySelector('[aria-label="Dismiss the request for Email"] .hint'))).toContain("Dismissing records nothing on the identity");
    await click(buttonNamed("Dismiss request", root!.querySelector('[role="group"][aria-label="Dismiss the request for Email"]')!));
    expect(calls.rejectRequestCall).toHaveBeenCalledWith(USER, { field: { typed: "Email" } }, "Disposable", "temporary inbox");
    expect(text(section("Requests").querySelector(".status"))).toBe("Request dismissed.");
  });

  it("records an identity document asked for", async () => {
    await open();
    await click(byLabel(`Record the identity document of ${WHO}`));
    expect(calls.grantFactCall).toHaveBeenCalledWith(USER, "DocumentChecked", "Unspecified", "");
    expect(text(section("Requests").querySelector(".status"))).toBe("Identity document recorded.");
  });

  it("says the chain's refusal in words for the agent", async () => {
    await open();
    send.mockResolvedValueOnce({ ok: false, events: [], error: "That request does not exist anymore.", errorName: "UnknownRequest" });
    await click(byLabel(`Verify Email of ${WHO}`));
    expect(text(section("Requests").querySelector(".problem"))).toBe("That request is no longer waiting.");
  });
});

describe("a private field", () => {
  async function paste(packet: string) {
    await click(byLabel(`Check the packet for Telegram of ${WHO}`));
    await type(root!.querySelector<HTMLTextAreaElement>("textarea"), packet);
    await click(buttonNamed("Check"));
    await settle(30);
  }

  it("is verified once a packet from the requester checks out against the chain, and the packet is dropped", async () => {
    await open();
    expect(byLabel(`Verify Telegram of ${WHO}`)).toBeNull();
    await paste(await packetOf());
    // the pasted text is gone; what is left is the value, for the agent to check
    expect(root!.querySelector("textarea")).toBeNull();
    expect(text(root!.querySelector(".packet-value"))).toBe(SECRET_VALUE);
    await click(buttonNamed("Verify", root!.querySelector('[aria-label="Packet for Telegram"]')!));
    const commitment = privateCommitment(SALT, SECRET_VALUE);
    expect(calls.provideJudgementCall).toHaveBeenCalledWith(USER, { typed: "Telegram" }, commitment, "Verified");
    expect(text(section("Requests").querySelector(".status"))).toBe("Telegram verified.");
    expect(root!.innerHTML).not.toContain(SECRET_VALUE);
  });

  it("refuses a packet signed by another account, and lets another one be pasted", async () => {
    await open();
    await paste(await packetOf(stranger, { address: stranger.address }));
    expect(text(section("Requests").querySelector('[role="alert"]'))).toBe("This packet is signed by another account than the one that asked.");
    expect(root!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(buttonNamed("Verify", root!.querySelector('[aria-label="Packet for Telegram"]')!)).toBeUndefined();
  });

  it("rejects the value of a checked private field after a question", async () => {
    await open();
    await paste(await packetOf());
    const panel = root!.querySelector('[aria-label="Packet for Telegram"]')!;
    await click(byLabel("Reject the value of Telegram", panel));
    expect(calls.provideJudgementCall).not.toHaveBeenCalled();
    // the same question as for a field or a link
    expect(text(panel.querySelector('[role="group"][aria-label="Reject the value of Telegram"] .hint'))).toBe(
      "Record on the identity that this Telegram was checked and refused? It counts as not verified while the person keeps this value.",
    );
    await click(buttonNamed("Reject the value", panel.querySelector('[role="group"][aria-label="Reject the value of Telegram"]')!));
    expect(calls.provideJudgementCall).toHaveBeenCalledWith(USER, { typed: "Telegram" }, privateCommitment(SALT, SECRET_VALUE), "Rejected");
    expect(text(section("Requests").querySelector(".status"))).toBe("Telegram rejected.");
  });

  it("asks for the packet again when the wallet does not sign, since it was dropped", async () => {
    await open();
    await paste(await packetOf());
    send.mockResolvedValueOnce({ ok: false, events: [], error: "Signing was cancelled.", errorName: "Cancelled" });
    await click(buttonNamed("Verify", root!.querySelector('[aria-label="Packet for Telegram"]')!));
    // said in the row, which stays: the request is still waiting
    expect(text(rowLine(waiting()[1]!).querySelector(".problem"))).toBe("Signing was cancelled.");
    expect(section("Requests").querySelector(":scope > .problem")).toBeNull();
    expect(text(root!.querySelector('[aria-label="Packet for Telegram"] [role="alert"]'))).toBe("Nothing was recorded. Paste the packet again to give a verdict.");
    expect(root!.querySelector<HTMLTextAreaElement>('[aria-label="Packet for Telegram"] textarea')!.value).toBe("");
    expect(root!.innerHTML).not.toContain(SECRET_VALUE);
  });

  it("refuses a packet whose field changed on chain since it was made", async () => {
    await open();
    world.profile = userProfile((raw) => (raw.identity.typed.Telegram = { private: `0x${"77".repeat(32)}` }));
    await paste(await packetOf());
    expect(text(section("Requests").querySelector('[role="alert"]'))).toBe("The packet does not match the field on chain. The person may have changed it since.");
  });

  it("signs nothing if the field changes between the check and the verdict", async () => {
    await open();
    await paste(await packetOf());
    world.profile = userProfile((raw) => (raw.identity.typed.Telegram = { private: `0x${"77".repeat(32)}` }));
    await click(buttonNamed("Verify", root!.querySelector('[aria-label="Packet for Telegram"]')!));
    expect(send).not.toHaveBeenCalled();
    expect(text(rowLine(waiting()[1]!).querySelector(".problem"))).toBe("The field changed since the packet was checked.");
  });

  it("sends the value and the salt nowhere: not in the call, not to storage, the console, the network or the URL", async () => {
    const out: string[] = [];
    const record = (channel: string) => (...args: unknown[]) => void out.push(`${channel} ${JSON.stringify(args, (_, v) => (v instanceof Uint8Array ? u8aToHex(v) : v))}`);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(record(`console.${m}`));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(record("storage"));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => (record("fetch")(...args), new Response()));
    vi.spyOn(history, "pushState").mockImplementation(record("pushState"));
    vi.spyOn(history, "replaceState").mockImplementation(record("replaceState"));
    await open();
    await paste(await packetOf());
    await click(buttonNamed("Verify", root!.querySelector('[aria-label="Packet for Telegram"]')!));
    for (const [, mock] of Object.entries(calls)) for (const args of mock.mock.calls) out.push(JSON.stringify(args));
    for (const args of send.mock.calls) out.push(JSON.stringify(args));
    const needles = [SECRET_VALUE, u8aToHex(stringToU8a(SECRET_VALUE)).slice(2), u8aToHex(SALT).slice(2)];
    expect(out.length).toBeGreaterThan(0);
    for (const needle of needles) expect(out.filter((line) => line.includes(needle))).toEqual([]);
  });
});

describe("accounts", () => {
  const lookUp = async (account: Account) => {
    world.account = account;
    await type(byLabel<HTMLInputElement>("Account address"), USER);
    await click(buttonNamed("Look up"));
  };
  const withEmailVerified = () =>
    userProfile((raw) => {
      raw.attestations = [[{ typed: "Email" }, 0, { ...fixture.attestations[0][2] }, true]];
      raw.name = null;
    });

  it("says so when an account cannot be read", async () => {
    await open();
    readAccount.mockRejectedValueOnce(new Error("disconnected"));
    await type(byLabel<HTMLInputElement>("Account address"), USER);
    await click(buttonNamed("Look up"));
    expect(text(section("Accounts").querySelector('[role="alert"]'))).toBe("Could not read that account. Check the connection and look it up again.");
    await click(buttonNamed("Look up"));
    expect(section("Accounts").querySelector('[role="alert"]')).toBeNull();
  });

  it("names a verified field by its label even once it left the identity", async () => {
    await open();
    world.account = {
      address: USER,
      profile: userProfile((raw) => {
        delete raw.identity.typed.Email;
        raw.attestations = [[{ typed: "Email" }, 0, { ...fixture.attestations[0][2] }, false]];
      }),
      facts: { DocumentChecked: null, Fraud: null },
    };
    await type(byLabel<HTMLInputElement>("Account address"), USER);
    await click(buttonNamed("Look up"));
    expect(text(rows("Verifications")[0]!.querySelector(".ask-value"))).toBe("Verified by identitee, no longer valid");
    world.account.profile!.attestations[0]!.ref = { typed: "GitHub" };
    await click(buttonNamed("Look up"));
    expect(text(rows("Verifications")[0]!.querySelector(".ask-label"))).toBe("GitHub");
  });

  it("refuses an address that does not decode, before reading anything", async () => {
    await open();
    await type(byLabel<HTMLInputElement>("Account address"), "nonsense");
    expect(text(section("Accounts").querySelector(".problem"))).toBe("That is not a valid account address.");
    expect(buttonNamed("Look up")!.disabled).toBe(true);
  });

  it("shows the facts, records an identity document, and asks before recording fraud", async () => {
    await open();
    await lookUp({ address: USER, profile: withEmailVerified(), facts: { DocumentChecked: null, Fraud: null } });
    expect(readAccount).toHaveBeenLastCalledWith(USER, 0);
    expect(rows("Facts").map((li) => text(li.querySelector(".ask-value")))).toEqual(["Not recorded", "Not recorded"]);
    await type(byLabel<HTMLInputElement>("Note", section("Accounts")), "passport seen");
    await click(byLabel("Record the identity document of Fixture User", section("Accounts")));
    expect(calls.grantFactCall).toHaveBeenLastCalledWith(USER, "DocumentChecked", "Unspecified", "passport seen");
    expect(rows("Facts").map((li) => text(li.querySelector(".ask-value")))).toEqual(["Recorded", "Not recorded"]);

    await click(byLabel("Record fraud for Fixture User"));
    expect(calls.grantFactCall).toHaveBeenCalledTimes(1);
    expect(text(section("Accounts").querySelector(".confirm .hint"))).toBe(
      "Record a fraud finding about Fixture User? Their level becomes Fraudulent, and they cannot claim a username while it stands.",
    );
    await choose(byLabel<HTMLSelectElement>("Reason", section("Accounts")), "Impersonation");
    await click(section("Accounts").querySelector(".confirm .button.primary"));
    expect(calls.grantFactCall).toHaveBeenLastCalledWith(USER, "Fraud", "Impersonation", "passport seen");
    await click(byLabel("Revoke Fraud of Fixture User"));
    expect(calls.revokeFactCall).not.toHaveBeenCalled();
    await click(section("Accounts").querySelector(".confirm .button.primary"));
    expect(calls.revokeFactCall).toHaveBeenLastCalledWith(USER, "Fraud", "Impersonation");
    expect(rows("Facts").map((li) => text(li.querySelector(".ask-value")))).toEqual(["Recorded", "Revoked"]);
  });

  it("keeps facts readable and revocable for an account with no identity, but records none", async () => {
    await open();
    await lookUp({ address: USER, profile: null, facts: { DocumentChecked: null, Fraud: { state: "active", issuedAt: 3 } } });
    expect(text(section("Accounts").querySelector(".member"))).toContain(": no identity.");
    expect(byLabel("Record the identity document of " + `${USER.slice(0, 8)}…${USER.slice(-8)}`)!.disabled).toBe(true);
    expect(byLabel(`Revoke Fraud of ${USER.slice(0, 8)}…${USER.slice(-8)}`)!.disabled).toBe(false);
  });

  it("lists the verifications the authority gave, and revokes one with the reason chosen", async () => {
    await open();
    await lookUp({ address: USER, profile: withEmailVerified(), facts: { DocumentChecked: null, Fraud: null } });
    expect(rows("Verifications").map((li) => text(li))).toEqual(["EmailVerified by identiteeRevoke"]);
    await choose(byLabel<HTMLSelectElement>("Reason", section("Accounts")), "UserRequest");
    await click(byLabel("Revoke the verification of Email"));
    expect(calls.revokeAttestationCall).not.toHaveBeenCalled();
    expect(text(section("Accounts").querySelector(".confirm .hint"))).toBe("Revoke the verification of Email? It stops counting, and only a new verdict restores it.");
    await click(section("Accounts").querySelector(".confirm .button.primary"));
    expect(calls.revokeAttestationCall).toHaveBeenCalledWith(USER, { typed: "Email" }, "UserRequest");
  });

  it("shows the account panel only for the address in the box: retyping it hides the panel until Look up", async () => {
    await open();
    await lookUp({ address: USER, profile: withEmailVerified(), facts: { DocumentChecked: null, Fraud: null } });
    expect(rows("Facts")).toHaveLength(2);
    await type(byLabel<HTMLInputElement>("Account address"), ALICE);
    expect(root!.querySelector('ul[aria-label="Facts"]')).toBeNull();
    expect(text(section("Accounts").querySelector(".hint"))).toBe("Press Look up to see this account.");
    // the same account again, as typed: the panel is back without reading anything
    await type(byLabel<HTMLInputElement>("Account address"), USER);
    expect(rows("Facts")).toHaveLength(2);
    expect(readAccount).toHaveBeenCalledTimes(1);
  });

  it("revokes a rejection as a rejection", async () => {
    await open();
    await lookUp({
      address: USER,
      profile: userProfile((raw) => {
        raw.attestations = [[{ typed: "Email" }, 0, { ...fixture.attestations[0][2], verdict: "Rejected" }, true]];
      }),
      facts: { DocumentChecked: null, Fraud: null },
    });
    await click(byLabel("Revoke the rejection of Email"));
    expect(text(section("Accounts").querySelector(".confirm .hint"))).toBe("Revoke the rejection of Email? It stops counting, and only a new verdict restores it.");
    await click(section("Accounts").querySelector(".confirm .button.primary"));
    expect(calls.revokeAttestationCall).toHaveBeenCalledWith(USER, { typed: "Email" }, "Unspecified");
    expect(text(section("Accounts").querySelector(".status"))).toBe("Rejection revoked.");
  });

  it("gives a username, a reserved one too, but not the name of a page", async () => {
    await open();
    await lookUp({ address: USER, profile: withEmailVerified(), facts: { DocumentChecked: null, Fraud: null } });
    const give = byLabel<HTMLInputElement>("Username to give")!;
    await type(give, "requests");
    await settle(350);
    expect(text(section("Accounts").querySelector(".problem"))).toBe("That name belongs to a page of this site and cannot be taken.");
    expect(buttonNamed("Give")!.disabled).toBe(true);
    nameStatus.mockResolvedValue({ state: "reserved" });
    await type(give, "reservedname");
    await settle(350);
    expect(text(section("Accounts").querySelector('[aria-live="polite"]'))).toBe("reservedname is reserved: you can give it.");
    await click(buttonNamed("Give"));
    expect(calls.setUsernameForCall).toHaveBeenCalledWith(USER, "reservedname");
    expect(text(section("Accounts").querySelector(".status[role=status]"))).toBe("reservedname given.");
  });

  it("takes a username away after a question", async () => {
    await open();
    await lookUp({ address: USER, profile: userProfile(), facts: { DocumentChecked: null, Fraud: null } });
    await click(byLabel("Take the username fixtureuser away"));
    expect(calls.unbindUsernameCall).not.toHaveBeenCalled();
    await click(section("Accounts").querySelector(".confirm .button.primary"));
    expect(calls.unbindUsernameCall).toHaveBeenCalledWith(USER, "Unspecified");
  });

  it("says a refusal about the other account in words for the agent", async () => {
    await open();
    await lookUp({ address: USER, profile: withEmailVerified(), facts: { DocumentChecked: null, Fraud: null } });
    send.mockResolvedValueOnce({ ok: false, events: [], error: "You already have a name. Release it first.", errorName: "AlreadyHasName" });
    await type(byLabel<HTMLInputElement>("Username to give"), "alice");
    await settle(350);
    await click(buttonNamed("Give"));
    expect(text(section("Accounts").querySelector(".problem"))).toBe("That account already has a username.");
  });
});

describe("reserved names", () => {
  it("lists them, reserves a name of the app's pages, and lifts a reservation", async () => {
    await open();
    expect(rows("Reserved").map((li) => text(li))).toEqual(["reservedname"]);
    expect(byLabel("Lift the reservation of reservedname")!.getAttribute("title")).toBe("Lift the reservation of reservedname");
    await type(byLabel<HTMLInputElement>("Name to reserve"), "requests");
    await settle(350);
    expect(nameStatus).toHaveBeenCalledWith("requests");
    await click(buttonNamed("Reserve"));
    expect(calls.reserveUsernameCall).toHaveBeenCalledWith("requests");
    expect(rows("Reserved").map((li) => text(li.querySelector(".ask-label")))).toEqual(["requests", "reservedname"]);
    await click(byLabel("Lift the reservation of reservedname"));
    expect(calls.unreserveUsernameCall).toHaveBeenCalledWith("reservedname");
    expect(rows("Reserved").map((li) => text(li.querySelector(".ask-label")))).toEqual(["requests"]);
  });

  it("refuses what the runtime would refuse, and a name that is taken", async () => {
    await open();
    await type(byLabel<HTMLInputElement>("Name to reserve"), "a.b");
    expect(text(section("Reserved names").querySelector(".problem"))).toBe("Names use only a to z, 0 to 9, hyphens and underscores.");
    nameStatus.mockResolvedValue({ state: "taken", owner: USER });
    await type(byLabel<HTMLInputElement>("Name to reserve"), "fixtureuser");
    await settle(350);
    expect(buttonNamed("Reserve")!.disabled).toBe(true);
  });
});

describe("no fee", () => {
  it("is never estimated or shown", () => {
    for (const file of ["authority-page.tsx", "authority-inbox.tsx", "authority-account.tsx", "authority-names.tsx"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", "pages", file), "utf8");
      expect(source).not.toMatch(/paymentInfo|queryInfo|partialFee|getBalance|freeBalance/);
    }
  });
});
