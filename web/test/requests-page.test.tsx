// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sameAccount, toIdentitee } from "../src/chain/address.ts";
import { decodeProfile, type NameStatus } from "../src/chain/identity.ts";
import type { Overview } from "../src/chain/overview.ts";
import { targetId } from "../src/chain/requests.ts";
import type { SendResult } from "../src/chain/tx.ts";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";

// The requests page, with the chain replaced by a small world that remembers what the page sent and
// answers the next read accordingly, the calls by markers the test can read, and the wallet by a
// signer. What is under test is what the page decides to send, when, and what it tells the person.
const { readOverview, nameStatus, readProfile, readBlock, send, calls } = vi.hoisted(() => ({
  readOverview: vi.fn(),
  readProfile: vi.fn(),
  readBlock: vi.fn(),
  nameStatus: vi.fn(),
  send: vi.fn(),
  calls: {
    requestJudgementCall: vi.fn(),
    cancelRequestCall: vi.fn(),
    claimUsernameCall: vi.fn(),
    releaseUsernameCall: vi.fn(),
    addSubCall: vi.fn(),
    acceptSubCall: vi.fn(),
    declineSubCall: vi.fn(),
    removeSubCall: vi.fn(),
    quitSubCall: vi.fn(),
    renameSubCall: vi.fn(),
    requestMigrationCall: vi.fn(),
    cancelMigrationCall: vi.fn(),
  },
}));
vi.mock("../src/chain/overview.ts", () => ({ readOverview }));
vi.mock("../src/chain/naming.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/naming.ts")>()), readBlock }));
// readProfile: the page reads the profiles of the accounts it names (parent, proposers, sub-accounts)
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/identity.ts")>()), nameStatus, readProfile }));
vi.mock("../src/chain/tx.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/tx.ts")>()), send }));
vi.mock("../src/chain/calls.ts", () => calls);

import { MyRequests, POLL_MS } from "../src/pages/requests-page.tsx";
import { type Acting, useActing } from "../src/pages/requests-acting.tsx";
import { NAME_DEBOUNCE_MS } from "../src/pages/requests-name.tsx";
import { MARKERS_KEY } from "../src/chain/markers.ts";

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
const EVE = "idnnuZEwh4Dv3QfxF6oS2zMD881G1KvXWXaWgYeBUAusWkd64";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as any;
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const OK: SendResult = { ok: true, events: [], blockHash: "0x01" };

/** The fixture's identity with nothing verified yet, no fact, no name, no parent. */
function profileWith(change: (raw: any) => void = () => undefined) {
  const raw = structuredClone(fixture);
  raw.attestations = [];
  raw.facts = [];
  raw.name = null;
  raw.parent = null;
  change(raw);
  return decodeProfile(USER, raw);
}

const emailVerified = (raw: any) => {
  raw.attestations = [[{ typed: "Email" }, 0, { ...fixture.attestations[0][2] }, true]];
};

function freshWorld(): Overview {
  return {
    profile: profileWith(),
    authority: { id: 0, name: "identitee", active: true },
    pending: [],
    parent: null,
    subs: [],
    proposed: [],
    received: [],
    migration: { state: "none" },
    times: { clock: { block: 1000, blockSeconds: 6 }, cooldownBlocks: 14400, quarantineBlocks: 432000, lastRelease: null },
  };
}

let world: Overview;

/** What the chain does with each call once it is in a block. */
function apply({ call, args }: { call: string; args: any[] }) {
  const same = (a: string) => (m: { address: string }) => sameAccount(m.address, a);
  switch (call) {
    case "requestJudgementCall":
      world.pending.push({ authority: args[0], target: args[1], since: 1001 });
      break;
    case "cancelRequestCall":
      world.pending = world.pending.filter((r) => targetId(r.target) !== targetId(args[1]));
      break;
    case "claimUsernameCall":
      world.profile!.name = args[0];
      break;
    case "releaseUsernameCall":
      world.profile!.name = null;
      world.times.lastRelease = world.times.clock.block;
      break;
    case "addSubCall":
      world.proposed.push({ address: toIdentitee(args[0]), label: String(args[1]).trim() });
      break;
    case "acceptSubCall":
      world.parent = world.received.find(same(args[0]))!;
      world.received = world.received.filter((m) => !same(args[0])(m));
      break;
    case "declineSubCall":
      world.received = world.received.filter((m) => !same(args[0])(m));
      break;
    case "removeSubCall":
      world.subs = world.subs.filter((m) => !same(args[0])(m));
      world.proposed = world.proposed.filter((m) => !same(args[0])(m));
      break;
    case "quitSubCall":
      world.parent = null;
      break;
    case "renameSubCall":
      [...world.subs, ...world.proposed].find(same(args[0]))!.label = String(args[1]).trim();
      break;
    case "requestMigrationCall":
      world.migration = { state: "pending", source: args[0], since: 1001 };
      break;
    case "cancelMigrationCall":
      world.migration = { state: "none" };
      break;
  }
}

const signerFor = vi.fn();
const wallet = { signerFor } as unknown as WalletModule;

let root: HTMLElement | undefined;
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function open(change: (w: Overview) => void = () => undefined) {
  world = freshWorld();
  change(world);
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyRequests address={USER} wallet={wallet} />, root!));
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
const type = async (el: HTMLInputElement | null, value: string) => {
  el!.value = value;
  await act(() => void el!.dispatchEvent(new Event("input", { bubbles: true })));
};
/** Type a name and let the pause pass, so that the chain has been asked. */
const typeName = async (name: string) => {
  await type(byLabel<HTMLInputElement>("Username to claim"), name);
  await settle(NAME_DEBOUNCE_MS + 60);
};
const rows = (list: string) => [...root!.querySelectorAll(`ul[aria-label="${list}"] > li`)];
const claimButton = () => buttonNamed("Claim", section("Username"))!;

beforeEach(() => {
  for (const mock of [readOverview, nameStatus, readProfile, readBlock, send, signerFor, ...Object.values(calls)]) mock.mockReset();
  readProfile.mockResolvedValue(null);
  readBlock.mockImplementation(async () => world.times.clock.block);
  localStorage.clear();
  readOverview.mockImplementation(async () => structuredClone(world));
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
  vi.useRealTimers();
});

describe("loading", () => {
  it("reads everything once, then draws the four sections of the card", async () => {
    await open();
    expect(readOverview).toHaveBeenCalledTimes(1);
    expect(readOverview).toHaveBeenCalledWith(USER);
    expect(root!.querySelector(".card")!.getAttribute("aria-label")).toBe("Requests");
    // no Migration: the account has an identity and no migration to tell about
    expect([...root!.querySelectorAll("section.block")].map((s) => s.getAttribute("aria-label"))).toEqual(["Verification", "Username", "Sub-accounts"]);
    expect(text(root!.querySelector(".name"))).toBe("Fixture User");
  });

  it("says the network cannot be reached, and offers to try again", async () => {
    readOverview.mockRejectedValueOnce(new Error("Cannot reach the identit.ee network."));
    world = freshWorld();
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(<MyRequests address={USER} wallet={wallet} />, root!));
    await settle();
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("Not available");
    expect(text(root.querySelector(".note"))).toBe("Cannot reach the identit.ee network.");
    await click(buttonNamed("Try again"));
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("Requests");
  });

  it("says once that an account with no identity needs one, and shows only what it can use", async () => {
    await open((w) => (w.profile = null));
    expect(text(root!.querySelector(".name"))).toBe(`${USER.slice(0, 8)}…${USER.slice(-8)}`);
    expect([...root!.querySelectorAll("section.block")].map((s) => s.getAttribute("aria-label"))).toEqual(["Sub-accounts", "Migration"]);
    const note = root!.querySelector("fieldset > .block")!;
    expect(text(note)).toBe("Verifications, a username and sub-accounts of your own need an identity.Create your identity");
    expect(note.querySelector("a")!.getAttribute("href")).toBe("/me");
    expect(root!.querySelectorAll(".ask")).toHaveLength(0);
    expect(root!.querySelector(".claim")).toBeNull();
    expect(text(section("Sub-accounts").querySelector(".hint"))).toBe("Nobody has asked this account to join them.");
  });
});

describe("verification", () => {
  it("offers the custom fields and the links, and sends the typed fields and the document to the profile", async () => {
    await open();
    const labels = rows("Verification requests").map((li) => text(li.querySelector(".ask-label")));
    expect(labels).toEqual(["mastodon", "Website", "Code"]);
    expect(rows("Verification requests").every((li) => !li.querySelector(".state"))).toBe(true);
    const hints = [...section("Verification").querySelectorAll(".hint")].map(text);
    expect(hints).toEqual(["Ask identitee to check a custom field or a link by hand.", "Verify your details from your profile."]);
    expect(section("Verification").querySelector(".hint a")!.getAttribute("href")).toBe("/me");
    for (const typed of ["Email", "Telegram", "PGP", "Identity document"]) expect(byLabel(`Request verification of ${typed}`)).toBeNull();
  });

  it("asks authority 0 when Request is pressed, and shows Pending only once the chain holds the request", async () => {
    await open();
    await click(byLabel("Request verification of mastodon"));
    expect(calls.requestJudgementCall).toHaveBeenCalledWith(0, { field: { custom: "mastodon" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ call: "requestJudgementCall", args: [0, { field: { custom: "mastodon" } }] });
    expect(send.mock.calls[0]![1]).toEqual({ address: USER, signer: {} });
    const mastodon = rows("Verification requests")[0]!;
    expect(text(mastodon.querySelector(".state"))).toBe("Pending");
    expect(byLabel("Cancel the request for mastodon")).not.toBeNull();
    expect(byLabel("Request verification of mastodon")).toBeNull();
    expect(text(section("Verification").querySelector(".status"))).toBe("Request sent.");
    // read again after the send
    expect(readOverview).toHaveBeenCalledTimes(2);
  });

  it("does not say Pending for a request the chain did not take", async () => {
    await open();
    send.mockResolvedValueOnce({ ok: false, events: [], error: "You already asked for this check.", errorName: "RequestExists" });
    await click(byLabel("Request verification of mastodon"));
    expect(text(section("Verification").querySelector(".problem"))).toBe("You already asked for this check.");
    expect(rows("Verification requests")[0]!.querySelector(".state")).toBeNull();
    expect(readOverview).toHaveBeenCalledTimes(1); // nothing happened: nothing to read again
  });

  it("keeps a request made before for a typed field or the document, so that it can be taken back", async () => {
    await open(
      (w) =>
        (w.pending = [
          { authority: 0, target: { field: { typed: "Email" } }, since: 5 },
          { authority: 0, target: { fact: "DocumentChecked" }, since: 6 },
        ]),
    );
    expect(rows("Verification requests").map((li) => text(li.querySelector(".ask-label")))).toEqual(["Email", "mastodon", "Website", "Code", "Identity document"]);
    expect(text(rows("Verification requests")[0]!.querySelector(".state"))).toBe("Pending");
    await click(byLabel("Cancel the request for Email"));
    expect(calls.cancelRequestCall).toHaveBeenCalledWith(0, { field: { typed: "Email" } });
    expect(rows("Verification requests").map((li) => text(li.querySelector(".ask-label")))).toEqual(["mastodon", "Website", "Code", "Identity document"]);
    expect(text(section("Verification").querySelector(".status"))).toBe("Request cancelled.");
    // gone with its request: nothing to ask for it here
    expect(byLabel("Request verification of Email")).toBeNull();
  });

  it("asks for a custom field and a link with their own targets", async () => {
    await open();
    await click(byLabel("Request verification of mastodon"));
    await click(byLabel("Request verification of Website"));
    expect(calls.requestJudgementCall.mock.calls).toEqual([
      [0, { field: { custom: "mastodon" } }],
      [0, { field: { link: 0 } }],
    ]);
  });

  it("shows a verified link as Verified, with nothing to ask", async () => {
    await open((w) => (w.profile = profileWith((raw) => (raw.attestations = [[{ link: 0 }, 0, { ...fixture.attestations[0][2] }, true]]))));
    const website = rows("Verification requests").find((li) => text(li.querySelector(".ask-label")) === "Website")!;
    expect(text(website.querySelector(".state"))).toBe("Verified");
    expect(website.querySelector("button")).toBeNull();
  });

  it("shows a rejection and offers to ask again", async () => {
    await open((w) => (w.profile = profileWith((raw) => (raw.attestations = [[{ link: 0 }, 0, { ...fixture.attestations[0][2], verdict: "Rejected" }, true]]))));
    const website = rows("Verification requests").find((li) => text(li.querySelector(".ask-label")) === "Website")!;
    expect(text(website.querySelector(".state"))).toBe("Rejected");
    await click(byLabel("Request again verification of Website"));
    expect(calls.requestJudgementCall).toHaveBeenCalledWith(0, { field: { link: 0 } });
  });

  it("points a private field to its verification packet once a request is waiting", async () => {
    await open((w) => (w.pending = [{ authority: 0, target: { field: { typed: "Telegram" } }, since: 5 }]));
    const telegram = rows("Verification requests")[0]!;
    expect(text(telegram.querySelector(".ask-value"))).toBe("Private");
    const note = telegram.querySelector(".hint.ask-note")!;
    expect(text(note)).toBe("Make its verification packet in My identity and send it to identitee.");
    expect(note.querySelector("a")!.getAttribute("href")).toBe("/me");
    // a public field needs no packet
    await click(byLabel("Request verification of mastodon"));
    expect(rows("Verification requests")[1]!.querySelector(".hint.ask-note")).toBeNull();
  });

  it("shows a row's result in that row, and the section's line only for a row that is gone", async () => {
    await open((w) => (w.pending = [{ authority: 0, target: { field: { custom: "old-handle" } }, since: 3 }]));
    await click(byLabel("Request verification of mastodon"));
    expect(text(rows("Verification requests")[0]!.querySelector(".ask-note .status"))).toBe("Request sent.");
    // said once, next to the button pressed
    expect(section("Verification").querySelectorAll(".status")).toHaveLength(1);
    // the gone field's row leaves with its request: its result has nowhere else to go
    await click(byLabel("Cancel the request for old-handle"));
    const status = section("Verification").querySelectorAll(".status");
    expect([...status].map((el) => [text(el), el.closest("li")])).toEqual([["Request cancelled.", null]]);
  });

  it("never shows the value of a private field", async () => {
    await open((w) => (w.pending = [{ authority: 0, target: { field: { typed: "Telegram" } }, since: 5 }]));
    expect(root!.textContent).not.toContain("0x2222");
  });

  it("keeps a request whose field is gone, so that it can be cancelled", async () => {
    await open((w) => (w.pending = [{ authority: 0, target: { field: { custom: "old-handle" } }, since: 3 }]));
    const gone = rows("Verification requests").find((li) => text(li.querySelector(".ask-label")) === "old-handle")!;
    expect(text(gone.querySelector(".ask-value"))).toBe("This field is no longer on your identity.");
    await click(byLabel("Cancel the request for old-handle"));
    expect(calls.cancelRequestCall).toHaveBeenCalledWith(0, { field: { custom: "old-handle" } });
  });

  it("is closed when the authority is inactive or missing", async () => {
    await open((w) => (w.authority = { id: 0, name: "identitee", active: false }));
    expect(text(section("Verification").querySelector(".hint"))).toBe("identitee is not taking requests right now.");
    expect(byLabel<HTMLButtonElement>("Request verification of mastodon")!.disabled).toBe(true);
    render(null, root!);
    root!.remove();
    await open((w) => (w.authority = null));
    expect(text(section("Verification").querySelector(".hint"))).toBe("No authority takes requests yet.");
    expect(byLabel<HTMLButtonElement>("Request verification of mastodon")!.disabled).toBe(true);
  });

  it("stops at 16 pending requests, and says so", async () => {
    await open((w) => (w.pending = Array.from({ length: 16 }, (_, i) => ({ authority: 0, target: { field: { custom: `f${i}` } }, since: i }))));
    expect(byLabel<HTMLButtonElement>("Request verification of mastodon")!.disabled).toBe(true);
    expect(text(section("Verification"))).toContain("You have reached the limit of 16 pending requests.");
  });

  it("does not count an old typed-field request as something to check by hand", async () => {
    await open((w) => {
      w.profile = profileWith((raw) => {
        raw.identity.custom = {};
        raw.identity.links = [];
      });
      w.pending = [{ authority: 0, target: { field: { typed: "Email" } }, since: 5 }];
    });
    expect(rows("Verification requests").map((li) => text(li.querySelector(".ask-label")))).toEqual(["Email"]);
    expect([...section("Verification").querySelectorAll(".hint")].map(text)).toEqual([
      "Verify your details from your profile.",
      "Custom fields and links are checked by hand: add one to your identity to ask for it here.",
    ]);
    expect(text(section("Verification"))).not.toContain("Ask identitee to check a custom field or a link by hand.");
  });

  it("says what can be asked here when there is nothing to check by hand", async () => {
    await open(
      (w) =>
        (w.profile = profileWith((raw) => {
          raw.identity.custom = {};
          raw.identity.links = [];
        })),
    );
    expect(root!.querySelector('ul[aria-label="Verification requests"]')).toBeNull();
    expect([...section("Verification").querySelectorAll(".hint")].map(text)).toEqual([
      "Verify your details from your profile.",
      "Custom fields and links are checked by hand: add one to your identity to ask for it here.",
    ]);
  });
});

describe("username", () => {
  it("refuses a name that cannot exist without asking the chain, with the reason", async () => {
    await open();
    for (const [typed, message] of [
      ["ab", "Names have at least 3 characters."],
      ["x".repeat(33), "Names have at most 32 characters."],
      ["Ada!", "Names use only a to z, 0 to 9, hyphens and underscores."],
      ["a b c", "Names use only a to z, 0 to 9, hyphens and underscores."],
      ["requests", "That name belongs to a page of this site and cannot be taken."],
      ["authority", "That name belongs to a page of this site and cannot be taken."],
    ] as const) {
      await typeName(typed);
      expect(text(section("Username").querySelector(".problem")), typed).toBe(message);
      expect(claimButton().disabled, typed).toBe(true);
    }
    expect(nameStatus).not.toHaveBeenCalled();
  });

  it("asks once the typing pauses, not at every key", async () => {
    await open();
    await type(byLabel<HTMLInputElement>("Username to claim"), "ada");
    await settle(NAME_DEBOUNCE_MS / 3);
    await type(byLabel<HTMLInputElement>("Username to claim"), "alice");
    await settle(NAME_DEBOUNCE_MS / 3);
    expect(nameStatus).not.toHaveBeenCalled();
    expect(text(section("Username").querySelector(".status"))).toBe("Checking");
    await settle(NAME_DEBOUNCE_MS + 60);
    expect(nameStatus).toHaveBeenCalledTimes(1);
    expect(nameStatus).toHaveBeenCalledWith("alice");
    expect(text(section("Username").querySelector(".status"))).toBe("alice is available.");
  });

  it("never shows the answer for another name while the box holds a new one", async () => {
    await open();
    await typeName("aaa");
    expect(text(section("Username").querySelector(".status"))).toBe("aaa is available.");
    await type(byLabel<HTMLInputElement>("Username to claim"), "aaab");
    expect(text(section("Username").querySelector(".status"))).toBe("Checking");
    expect(claimButton().disabled).toBe(true);
    await settle(NAME_DEBOUNCE_MS + 60);
    expect(text(section("Username").querySelector(".status"))).toBe("aaab is available.");
  });

  it("looks up the name as it will be claimed: trimmed and in lower case", async () => {
    await open();
    await typeName("  Ada-L ");
    expect(nameStatus).toHaveBeenCalledWith("ada-l");
    expect(text(section("Username").querySelector(".status"))).toBe("ada-l is available.");
  });

  it("tells taken, reserved and recently released names, and does not offer to claim them", async () => {
    await open();
    nameStatus.mockResolvedValueOnce({ state: "taken", owner: PARENT });
    await typeName("alice");
    expect(text(section("Username").querySelector(".problem"))).toBe("alice is taken.");
    expect(claimButton().disabled).toBe(true);
    nameStatus.mockResolvedValueOnce({ state: "reserved" });
    await typeName("google");
    expect(text(section("Username").querySelector(".problem"))).toBe("google is reserved.");
    nameStatus.mockResolvedValueOnce({ state: "quarantined", until: 1000 + 14400 + 100 });
    await typeName("evename");
    expect(text(section("Username").querySelector(".problem"))).toBe("That name was released recently. It can be claimed again in about 1 day.");
    expect(claimButton().disabled).toBe(true);
  });

  it("reads again when the name changes, and shows only the answer to the name in the box", async () => {
    await open();
    const answers = new Map<string, (s: NameStatus) => void>();
    nameStatus.mockImplementation((name: string) => new Promise<NameStatus>((resolve) => answers.set(name, resolve)));
    await typeName("aaa");
    await typeName("bbb");
    expect(answers.size).toBe(2);
    await act(() => answers.get("bbb")!({ state: "available" }));
    await act(() => answers.get("aaa")!({ state: "taken", owner: PARENT })); // the late answer for the old name
    expect(text(section("Username").querySelector(".status"))).toBe("bbb is available.");
    expect(section("Username").querySelector(".problem")).toBeNull();
  });

  it("says when the name cannot be checked", async () => {
    await open();
    nameStatus.mockRejectedValueOnce(new Error("offline"));
    await typeName("alice");
    expect(text(section("Username").querySelector(".problem"))).toBe("Could not check that name. Try again in a moment.");
    expect(claimButton().disabled).toBe(true);
  });

  it("claims an available name for an identity with a verified field, and shows it from the chain", async () => {
    await open((w) => (w.profile = profileWith(emailVerified)));
    expect(section("Username").querySelector(".hint")).toBeNull();
    await typeName("alice");
    expect(claimButton().disabled).toBe(false);
    await click(claimButton());
    expect(calls.claimUsernameCall).toHaveBeenCalledWith("alice");
    expect(send).toHaveBeenCalledTimes(1);
    expect(text(section("Username").querySelector(".member"))).toBe("Your username is alice.");
    expect(section("Username").querySelector(".member a")!.getAttribute("href")).toBe("/alice");
    expect(section("Username").querySelector("input")).toBeNull();
    expect(text(section("Username").querySelector(".status"))).toBe("Username claimed.");
  });

  it("drops the result of the claim once the person starts to release the name", async () => {
    await open((w) => (w.profile = profileWith(emailVerified)));
    await typeName("alice");
    await click(claimButton());
    expect(text(section("Username").querySelector(".status"))).toBe("Username claimed.");
    await click(buttonNamed("Release username"));
    expect(section("Username").querySelector(".status")).toBeNull();
    expect(section("Username").querySelector(".confirm")).not.toBeNull();
  });

  it("claims with Enter as well", async () => {
    await open((w) => (w.profile = profileWith(emailVerified)));
    await typeName("alice");
    await act(() => void section("Username").querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })));
    await settle();
    expect(calls.claimUsernameCall).toHaveBeenCalledWith("alice");
  });

  it("will not claim before a field is verified, even a name that is free", async () => {
    await open();
    expect(text(section("Username").querySelector(".hint"))).toBe("Get one field verified first. You can ask for a verification above.");
    await typeName("alice");
    expect(text(section("Username").querySelector(".status"))).toBe("alice is available.");
    expect(claimButton().disabled).toBe(true);
    await click(claimButton());
    expect(calls.claimUsernameCall).not.toHaveBeenCalled();
  });

  it("counts the day after a release in hours, from the chain's last release", async () => {
    await open((w) => {
      w.profile = profileWith(emailVerified);
      w.times.lastRelease = 1000 - 14400 + 600;
    });
    expect(text(section("Username").querySelector(".hint"))).toBe("You released a name recently. You can claim one again in about 1 hour.");
    await typeName("alice");
    expect(claimButton().disabled).toBe(true);
  });

  it("reads the block again when a name is checked, so the wait ends without a reload", async () => {
    await open((w) => {
      w.profile = profileWith(emailVerified);
      w.times.lastRelease = 1000 - 14400 + 600;
    });
    // the page stayed open past the end of the wait: the chain is now 700 blocks further
    readBlock.mockResolvedValue(1700);
    await typeName("alice");
    await settle();
    expect(section("Username").querySelector(".hint")).toBeNull();
    expect(claimButton().disabled).toBe(false);
  });

  it("reads the block again when the window comes back into focus", async () => {
    await open((w) => {
      w.profile = profileWith(emailVerified);
      w.times.lastRelease = 1000 - 14400 + 600;
    });
    readBlock.mockResolvedValue(1700);
    await act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(section("Username").querySelector(".hint")).toBeNull();
  });

  it("surfaces the chain's refusal of a claim in a sentence", async () => {
    await open((w) => (w.profile = profileWith(emailVerified)));
    await typeName("alice");
    send.mockResolvedValueOnce({ ok: false, events: [], error: "That name is already taken.", errorName: "NameTaken" });
    await click(claimButton());
    expect(text(section("Username").querySelector('[role="alert"]'))).toBe("That name is already taken.");
    // the answer for the name is read again after the attempt, and the page now says what the chain says
    nameStatus.mockResolvedValue({ state: "taken", owner: PARENT });
    await settle(NAME_DEBOUNCE_MS + 60);
    expect(nameStatus).toHaveBeenCalledTimes(2);
    expect(text(section("Username").querySelector(".problem"))).toBe("alice is taken.");
  });

  it("releases a name only after a confirmation that says what it costs", async () => {
    await open((w) => (w.profile = profileWith((raw) => (raw.name = "0x616c696365")))); // "alice"
    expect(text(section("Username").querySelector(".member"))).toBe("Your username is alice.");
    await click(buttonNamed("Release username"));
    expect(document.activeElement).toBe(buttonNamed("Release", section("Username"))); // Enter confirms
    expect(text(section("Username").querySelector(".confirm .hint"))).toBe(
      "Release alice? Nobody can claim it for 30 days, and you cannot claim a name for 1 day.",
    );
    expect(calls.releaseUsernameCall).not.toHaveBeenCalled();
    await click(buttonNamed("Keep", section("Username")));
    expect(calls.releaseUsernameCall).not.toHaveBeenCalled();
    expect(buttonNamed("Release username")).toBeDefined();

    await click(buttonNamed("Release username"));
    await click(buttonNamed("Release", section("Username")));
    expect(calls.releaseUsernameCall).toHaveBeenCalledTimes(1);
    expect(text(section("Username").querySelector(".status"))).toBe("Username released.");
    // the form is back, with the wait the chain imposes
    expect(section("Username").querySelector("input")).not.toBeNull();
    expect(text(section("Username").querySelector(".hint"))).toContain("You released a name recently.");
  });
});

describe("sub-accounts", () => {
  const sub = (address: string, label: string) => ({ address, label });

  it("checks the proposal before signing: address, itself, a duplicate, the label", async () => {
    await open((w) => (w.proposed = [sub(PARENT, "phone")]));
    const address = () => byLabel<HTMLInputElement>("Account address");
    const propose = () => buttonNamed("Propose", section("Sub-accounts"))!;
    expect(propose().disabled).toBe(true);

    await type(address(), "nonsense");
    expect(text(section("Sub-accounts").querySelector(".problem"))).toBe("That is not a valid account address.");
    expect(propose().disabled).toBe(true);
    await type(address(), USER);
    expect(text(section("Sub-accounts").querySelector(".problem"))).toBe("An account cannot be its own sub-account.");
    await type(address(), PARENT);
    expect(text(section("Sub-accounts").querySelector(".problem"))).toBe("That account is already your sub-account, or has a proposal from you.");
    await type(address(), EVE);
    expect(section("Sub-accounts").querySelector(".problem")).toBeNull();
    expect(propose().disabled).toBe(false);
    await type(byLabel<HTMLInputElement>("Label"), "x".repeat(65));
    expect(text(section("Sub-accounts").querySelector(".problem"))).toBe("A label has at most 64 bytes, this one has 65.");
    expect(propose().disabled).toBe(true);
    expect(calls.addSubCall).not.toHaveBeenCalled();
  });

  it("proposes an account, lists it as waiting, and clears the form", async () => {
    await open();
    await type(byLabel<HTMLInputElement>("Account address"), EVE);
    await type(byLabel<HTMLInputElement>("Label"), "work laptop");
    await click(buttonNamed("Propose", section("Sub-accounts")));
    expect(calls.addSubCall).toHaveBeenCalledWith(EVE, "work laptop");
    const [row] = rows("Your sub-accounts");
    expect(text(row!.querySelector(".link-title"))).toBe("work laptop");
    expect(text(row!.querySelector(".state"))).toBe("Waiting");
    expect(byLabel<HTMLInputElement>("Account address")!.value).toBe("");
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("Proposal sent.");
  });

  it("keeps what was typed when the chain refuses", async () => {
    await open();
    await type(byLabel<HTMLInputElement>("Account address"), EVE);
    send.mockResolvedValueOnce({ ok: false, events: [], error: "A sub-account cannot have sub-accounts.", errorName: "ParentIsSub" });
    await click(buttonNamed("Propose", section("Sub-accounts")));
    expect(text(section("Sub-accounts").querySelector('[role="alert"]'))).toBe("A sub-account cannot have sub-accounts.");
    expect(byLabel<HTMLInputElement>("Account address")!.value).toBe(EVE);
  });

  it("lists accepted and waiting sub-accounts and renames one", async () => {
    await open((w) => {
      w.subs = [sub(PARENT, "phone")];
      w.proposed = [sub(EVE, "")];
    });
    expect(rows("Your sub-accounts").map((li) => [text(li.querySelector(".link-title")), text(li.querySelector(".state"))])).toEqual([
      ["phone", "Accepted"],
      [`${EVE.slice(0, 8)}…${EVE.slice(-8)}`, "Waiting"],
    ]);
    await click(byLabel("Rename phone"));
    const input = byLabel<HTMLInputElement>("Label of phone")!;
    expect(input.value).toBe("phone");
    expect(document.activeElement).toBe(input);
    expect(buttonNamed("Save", section("Sub-accounts"))!.disabled).toBe(true); // unchanged
    await type(input, " tablet ");
    await click(buttonNamed("Save", section("Sub-accounts")));
    expect(calls.renameSubCall).toHaveBeenCalledWith(PARENT, " tablet ");
    expect(text(rows("Your sub-accounts")[0]!.querySelector(".link-title"))).toBe("tablet");
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("Label changed.");
  });

  it("renames a proposal too, and cancels a rename without sending anything", async () => {
    await open((w) => (w.proposed = [sub(EVE, "old")]));
    await click(byLabel("Rename old"));
    await click(buttonNamed("Cancel", section("Sub-accounts")));
    expect(calls.renameSubCall).not.toHaveBeenCalled();
    await click(byLabel("Rename old"));
    await type(byLabel<HTMLInputElement>("Label of old"), "x".repeat(65));
    expect(buttonNamed("Save", section("Sub-accounts"))!.disabled).toBe(true);
  });

  it("removes an accepted sub-account after a question, and withdraws a proposal at once", async () => {
    await open((w) => {
      w.subs = [sub(PARENT, "phone")];
      w.proposed = [sub(EVE, "tablet")];
    });
    await click(byLabel("Remove phone"));
    expect(calls.removeSubCall).not.toHaveBeenCalled();
    expect(text(section("Sub-accounts").querySelector(".confirm .hint"))).toBe(
      "Remove phone? It stops being your sub-account, and joining again needs a new proposal it accepts.",
    );
    await click(buttonNamed("Keep", section("Sub-accounts")));
    expect(calls.removeSubCall).not.toHaveBeenCalled();
    await click(byLabel("Remove phone"));
    await click(section("Sub-accounts").querySelector(".confirm .button.primary"));
    expect(calls.removeSubCall).toHaveBeenLastCalledWith(PARENT);
    expect(rows("Your sub-accounts")).toHaveLength(1);
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("Sub-account removed.");
    await click(byLabel("Withdraw the proposal to tablet"));
    expect(calls.removeSubCall).toHaveBeenLastCalledWith(EVE);
    expect(section("Sub-accounts").querySelector('ul[aria-label="Your sub-accounts"]')).toBeNull();
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("Proposal withdrawn.");
  });

  it("accepts or declines the proposals it received, even without an identity", async () => {
    await open((w) => {
      w.profile = null;
      w.received = [sub(PARENT, "main laptop"), sub(EVE, "")];
    });
    // who proposes, by short address while their profiles are unknown, and the label they would give
    expect(rows("Proposals to you").map((li) => [text(li.querySelector(".link-title")), text(li.querySelector(".link-url"))])).toEqual([
      [`From ${PARENT.slice(0, 8)}…${PARENT.slice(-8)}`, "would list you as main laptop"],
      [`From ${EVE.slice(0, 8)}…${EVE.slice(-8)}`, "a proposal to join as a sub-account"],
    ]);
    expect(rows("Proposals to you")[0]!.querySelector(".link-title a")!.getAttribute("href")).toBe(`/a/${PARENT}`);
    await click(byLabel(`Decline the proposal from ${PARENT.slice(0, 8)}…${PARENT.slice(-8)}`));
    expect(calls.declineSubCall).toHaveBeenCalledWith(PARENT);
    expect(rows("Proposals to you")).toHaveLength(1);
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("Proposal declined.");
    await click(buttonNamed(`Accept the proposal from ${EVE.slice(0, 8)}…${EVE.slice(-8)}`));
    expect(calls.acceptSubCall).toHaveBeenCalledWith(EVE);
    expect(text(section("Sub-accounts").querySelector(".member"))).toContain("Sub-account of");
  });

  it("names the proposer and the parent by their identity once read, and links to their username page", async () => {
    readProfile.mockImplementation(async (address: string) => (address === PARENT ? { ...profileWith(), name: "theparent" } : null));
    await open((w) => {
      w.profile = null;
      w.received = [sub(PARENT, "main laptop")];
    });
    await settle();
    const [proposal] = rows("Proposals to you");
    expect([text(proposal!.querySelector(".link-title")), text(proposal!.querySelector(".link-url"))]).toEqual([
      "From Fixture User",
      `${PARENT.slice(0, 8)}…${PARENT.slice(-8)}, would list you as main laptop`,
    ]);
    expect(proposal!.querySelector(".link-title a")!.getAttribute("href")).toBe("/theparent");
    await click(byLabel("Accept the proposal from Fixture User"));
    await settle();
    const member = section("Sub-accounts").querySelector(".member")!;
    expect(text(member)).toBe("Sub-account of Fixture User, listed as main laptop.");
    expect(member.querySelector("a")!.getAttribute("href")).toBe("/theparent");
  });

  it("puts the focus back on Rename when a rename is closed, by Cancel or by Escape", async () => {
    await open((w) => (w.subs = [sub(PARENT, "phone")]));
    const frame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(undefined)))));
    await click(byLabel("Rename phone"));
    await click(buttonNamed("Cancel", section("Sub-accounts")));
    await frame();
    expect(document.activeElement).toBe(byLabel("Rename phone"));

    await click(byLabel("Rename phone"));
    const input = byLabel<HTMLInputElement>("Label of phone")!;
    await act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await frame();
    expect(byLabel("Label of phone")).toBeNull();
    expect(document.activeElement).toBe(byLabel("Rename phone"));
    expect(calls.renameSubCall).not.toHaveBeenCalled();
  });

  it("shows the parent, lets the account leave after a confirmation, and offers no sub-accounts of its own", async () => {
    await open((w) => (w.parent = sub(PARENT, "main laptop")));
    expect(text(section("Sub-accounts").querySelector(".member"))).toBe(`Sub-account of ${PARENT.slice(0, 8)}…${PARENT.slice(-8)}, listed as main laptop.`);
    expect(section("Sub-accounts").querySelector("form")).toBeNull();
    expect(text(section("Sub-accounts").querySelector(".hint"))).toBe("A sub-account cannot have sub-accounts.");
    await click(byLabel("Leave your parent account"));
    expect(calls.quitSubCall).not.toHaveBeenCalled();
    await click(buttonNamed("Leave", section("Sub-accounts")));
    expect(calls.quitSubCall).toHaveBeenCalledTimes(1);
    expect(text(section("Sub-accounts").querySelector(".status"))).toBe("You left the account.");
    expect(section("Sub-accounts").querySelector("form")).not.toBeNull();
  });

  it("does not offer to accept while the account has a parent or sub-accounts, and says why", async () => {
    await open((w) => {
      w.parent = sub(PARENT, "x");
      w.received = [sub(EVE, "other")];
    });
    const eve = `${EVE.slice(0, 8)}…${EVE.slice(-8)}`;
    expect(byLabel<HTMLButtonElement>(`Accept the proposal from ${eve}`)!.disabled).toBe(true);
    expect(text(section("Sub-accounts").querySelector(".hint"))).toBe("You already belong to a parent. Leave it to accept another proposal.");
    expect(byLabel<HTMLButtonElement>(`Decline the proposal from ${eve}`)!.disabled).toBe(false);
    render(null, root!);
    root!.remove();
    await open((w) => {
      w.subs = [sub(PARENT, "x")];
      w.received = [sub(EVE, "other")];
    });
    expect(byLabel<HTMLButtonElement>(`Accept the proposal from ${eve}`)!.disabled).toBe(true);
    expect(text(section("Sub-accounts").querySelector(".hint"))).toBe("An account with sub-accounts cannot become one.");
  });

  it("offers no proposal form to an account with no identity", async () => {
    await open((w) => (w.profile = null));
    expect(section("Sub-accounts").querySelector("form")).toBeNull();
  });

  it("stops proposing at 100", async () => {
    const many = Array.from({ length: 100 }, (_, i) => sub(toIdentitee(new Uint8Array(32).fill(i + 1)), `s${i}`));
    await open((w) => (w.subs = many));
    expect(section("Sub-accounts").querySelector("form")).toBeNull();
    expect(text(section("Sub-accounts"))).toContain("You have reached the limit of 100 sub-accounts.");
  });
});

describe("migration", () => {
  const stored = (): Record<string, string> => JSON.parse(localStorage.getItem(MARKERS_KEY) ?? "{}");

  it("asks for a migration from either chain, and remembers having asked", async () => {
    await open((w) => (w.profile = null));
    expect([...section("Migration").querySelectorAll("button")].map((b) => text(b))).toEqual(["Migrate from Polkadot", "Migrate from Kusama"]);
    await click(buttonNamed("Migrate from Kusama"));
    expect(calls.requestMigrationCall).toHaveBeenCalledWith("Kusama");
    expect(text(section("Migration").querySelector(".member"))).toBe("Waiting for the migration service to read your Kusama identity.");
    expect(text(section("Migration").querySelector(".status"))).toBe("Migration requested.");
    expect(stored()).toEqual({ [USER]: "Kusama" });
  });

  it("withdraws the request, and forgets it", async () => {
    await open((w) => {
      w.profile = null;
      w.migration = { state: "pending", source: "Polkadot", since: 5 };
    });
    await click(buttonNamed("Cancel request", section("Migration")));
    expect(calls.cancelMigrationCall).toHaveBeenCalledTimes(1);
    expect(section("Migration").querySelectorAll("button")).toHaveLength(2);
    expect(stored()).toEqual({});
  });

  it("says a waiting request cannot import over an identity made since, and offers to cancel it", async () => {
    await open((w) => (w.migration = { state: "pending", source: "Kusama", since: 5 }));
    expect(text(section("Migration").querySelector(".problem"))).toBe(
      "This account has an identity here now, so the migration service cannot import the Kusama one over it. Cancel this request.",
    );
    expect(section("Migration").querySelector(".member")).toBeNull();
    expect(buttonNamed("Cancel request", section("Migration"))).toBeDefined();
  });

  it("warns an account without identity that creating one would stop the waiting import, instead of offering it", async () => {
    await open((w) => {
      w.profile = null;
      w.migration = { state: "pending", source: "Polkadot", since: 5 };
    });
    const note = root!.querySelector("fieldset > .block")!;
    expect(note.querySelector('a[href="/me"]')).toBeNull();
    expect(text(note)).toContain("Your migration request is waiting: creating an identity now would stop the import. Wait for it, or cancel it below.");
  });

  it("tells an import, from the chain's history", async () => {
    await open((w) => (w.migration = { state: "imported", source: "Polkadot", block: 7 }));
    expect(text(section("Migration").querySelector(".member"))).toBe("Imported from Polkadot at block 7.");
    expect(section("Migration").querySelector("button")).toBeNull();
  });

  it("tells a request that ended (refused or withdrawn), lets it be dismissed, and offers to ask again", async () => {
    localStorage.setItem(MARKERS_KEY, JSON.stringify({ [USER]: "Polkadot" }));
    await open((w) => {
      w.profile = null;
      w.migration = { state: "ended", source: "Polkadot" };
    });
    expect(text(section("Migration").querySelector(".member"))).toBe(
      "The migration from Polkadot ended without an import: it was refused or withdrawn. You can ask again.",
    );
    expect(buttonNamed("Migrate from Kusama")).toBeDefined();
    // asking again and dismissing sit together; a refusal does not hide the way to ask again
    expect([...section("Migration").querySelectorAll("button")].map((b) => text(b))).toEqual(["Migrate from Polkadot", "Migrate from Kusama", "Dismiss"]);
    world.migration = { state: "none" };
    await click(buttonNamed("Dismiss"));
    expect(stored()).toEqual({});
    expect(section("Migration").querySelector(".member")).toBeNull();
  });

  it("is left out for an account that has an identity and no migration to tell about", async () => {
    await open();
    expect(root!.querySelector('section[aria-label="Migration"]')).toBeNull();
  });

  it("tells an ended request to an account that has an identity now, without offering to ask again", async () => {
    await open((w) => (w.migration = { state: "ended", source: "Kusama" }));
    expect(text(section("Migration").querySelector(".member"))).toBe("The migration from Kusama ended without an import: it was refused or withdrawn.");
    expect([...section("Migration").querySelectorAll("button")].map((b) => text(b))).toEqual(["Dismiss"]);
  });
});

describe("one action at a time", () => {
  it("shows the app's own sentence when a call cannot be built, and a plain one for anything else", async () => {
    const { Refusal } = await import("../src/chain/refusal.ts");
    await open((w) => (w.profile = profileWith(emailVerified)));
    calls.claimUsernameCall.mockRejectedValueOnce(new Refusal("That name belongs to a page of this site and cannot be taken."));
    await typeName("alice");
    await click(claimButton());
    expect(text(section("Username").querySelector(".problem"))).toBe("That name belongs to a page of this site and cannot be taken.");
    calls.claimUsernameCall.mockRejectedValueOnce(new Error("createType(Call):: Struct: failed on args: Bytes"));
    await typeName("alices");
    await click(claimButton());
    expect(text(section("Username").querySelector(".problem"))).toBe("The call could not be prepared. Try again.");
    expect(send).not.toHaveBeenCalled();
  });

  it("locks the page while a call is in flight, and says it is working", async () => {
    await open();
    let finish!: (r: SendResult) => void;
    send.mockImplementationOnce(() => new Promise<SendResult>((resolve) => (finish = resolve)));
    await click(byLabel("Request verification of mastodon"));
    expect(root!.querySelector("fieldset")!.hasAttribute("disabled")).toBe(true);
    expect(root!.querySelector(".card")!.getAttribute("aria-busy")).toBe("true");
    expect(text(section("Verification").querySelector(".status"))).toBe("Working. Confirm in your wallet if it asks.");
    // a second click while the first is out sends nothing
    await click(byLabel("Request verification of Website"));
    expect(send).toHaveBeenCalledTimes(1);
    await act(() => finish(OK));
    await settle();
    expect(root!.querySelector("fieldset")!.hasAttribute("disabled")).toBe(false);
  });

  it("ignores a second call made before the page has redrawn (a double click)", async () => {
    let acting!: Acting;
    function Probe() {
      acting = useActing(USER, wallet, async () => true);
      return null;
    }
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(<Probe />, root!));
    let release!: (r: SendResult) => void;
    send.mockImplementationOnce(() => new Promise<SendResult>((resolve) => (release = resolve)));
    const first = acting.run("verify", async () => ({}) as never, "Done.");
    const second = acting.run("verify", async () => ({}) as never, "Done.");
    expect(await second).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      release(OK);
    });
    expect(await first).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says when the wallet cannot be reached, and sends nothing", async () => {
    await open();
    signerFor.mockRejectedValueOnce(new Error("no wallet"));
    await click(byLabel("Request verification of mastodon"));
    expect(text(section("Verification").querySelector('[role="alert"]'))).toBe("The wallet could not be reached. Try again.");
    expect(send).not.toHaveBeenCalled();
  });

  it("says the daily limit in the chain's words", async () => {
    await open();
    send.mockResolvedValueOnce({ ok: false, events: [], error: "Daily limit reached. Try again tomorrow.", errorName: "DailyLimit" });
    await click(byLabel("Request verification of mastodon"));
    expect(text(section("Verification").querySelector('[role="alert"]'))).toBe("Daily limit reached. Try again tomorrow.");
  });

  it("clears an old result when the person goes on typing in that section", async () => {
    await open();
    send.mockResolvedValueOnce({ ok: false, events: [], error: "A sub-account cannot have sub-accounts.", errorName: "ParentIsSub" });
    await type(byLabel<HTMLInputElement>("Account address"), EVE);
    await click(buttonNamed("Propose", section("Sub-accounts")));
    expect(section("Sub-accounts").querySelector('[role="alert"]')).not.toBeNull();
    await type(byLabel<HTMLInputElement>("Label"), "x");
    expect(section("Sub-accounts").querySelector('[role="alert"]')).toBeNull();
  });
});

describe("waiting for someone else", () => {
  it("reads the chain again now and then while something waits, and not otherwise", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open((w) => (w.pending = [{ authority: 0, target: { field: { typed: "Email" } }, since: 5 }]));
    expect(readOverview).toHaveBeenCalledTimes(1);
    await click(byLabel("Request verification of mastodon"));
    expect(text(section("Verification").querySelector(".status"))).toBe("Request sent.");
    expect(readOverview).toHaveBeenCalledTimes(2);
    await act(() => void vi.advanceTimersByTime(POLL_MS));
    await settle();
    expect(readOverview).toHaveBeenCalledTimes(3);

    // what the action said is old news once the page has looked again
    expect(section("Verification").querySelector(".status")).toBeNull();

    // the request is answered: the page shows it, and stops asking
    world.pending = [];
    world.profile = profileWith((raw) => (raw.attestations = [[{ custom: "0x6d6173746f646f6e" }, 0, { ...fixture.attestations[0][2] }, true]]));
    await act(() => void vi.advanceTimersByTime(POLL_MS));
    await settle();
    expect(readOverview).toHaveBeenCalledTimes(4);
    expect(text(rows("Verification requests")[0]!.querySelector(".state"))).toBe("Verified");
    expect(text(rows("Verification requests")[0]!.querySelector(".ask-label"))).toBe("mastodon");
    await act(() => void vi.advanceTimersByTime(POLL_MS * 3));
    await settle();
    expect(readOverview).toHaveBeenCalledTimes(4);
  });

  it("follows a migration request to its end", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open((w) => {
      w.profile = null;
      w.migration = { state: "pending", source: "Polkadot", since: 5 };
    });
    world.migration = { state: "imported", source: "Polkadot", block: 9 };
    await act(() => void vi.advanceTimersByTime(POLL_MS));
    await settle();
    expect(text(section("Migration").querySelector(".member"))).toBe("Imported from Polkadot at block 9.");
  });

  it("does not read while the tab is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open((w) => (w.pending = [{ authority: 0, target: { field: { typed: "Email" } }, since: 5 }]));
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      await act(() => void vi.advanceTimersByTime(POLL_MS * 2));
      await settle();
      expect(readOverview).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });
});

describe("house style", () => {
  it("shows no fee, price or balance, and none of the forbidden marks or fonts", async () => {
    await open((w) => {
      w.subs = [{ address: PARENT, label: "phone" }];
      w.received = [{ address: EVE, label: "x" }];
      w.pending = [{ authority: 0, target: { field: { typed: "Email" } }, since: 5 }];
    });
    await typeName("alice");
    expect(root!.textContent).not.toMatch(/[·—]/);
    expect(root!.textContent).not.toMatch(/\bfees?\b|\bIDT\b|\bcosts?\b|\bbalance\b|\bgas\b|\bpay/i);
    expect(root!.innerHTML).not.toMatch(/monospace|font-family/i);
  });

  it("never reads a balance, a fee or the account's funds", () => {
    for (const file of [
      "pages/requests-page.tsx",
      "pages/requests-acting.tsx",
      "pages/requests-verify.tsx",
      "pages/requests-name.tsx",
      "pages/requests-subs.tsx",
      "pages/requests-migration.tsx",
      "chain/requests.ts",
      "chain/naming.ts",
      "chain/migration.ts",
      "chain/subs.ts",
      "chain/overview.ts",
    ]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
      expect(source, file).not.toMatch(/paymentInfo|queryInfo|partialFee|system\.account|freeBalance|getBalance|tokenDecimals/);
    }
  });
});
