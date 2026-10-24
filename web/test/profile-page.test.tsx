// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeProfile, DecodeError, type Profile } from "../src/chain/identity.ts";

// The page, with the chain replaced by answers captured from a dev node. The profile and the
// requests waiting on it are read at one block: `AT` stands for it.
const { readProfile, resolveName, pendingRequestsOf, AT } = vi.hoisted(() => ({
  readProfile: vi.fn(),
  resolveName: vi.fn(),
  pendingRequestsOf: vi.fn(),
  AT: { block: "the block both are read at" },
}));
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/identity.ts")>()),
  readProfile,
  resolveName,
}));
vi.mock("../src/chain/requests.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/requests.ts")>()),
  pendingRequestsOf,
}));
vi.mock("../src/chain/reader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/reader.ts")>()),
  snapshot: () => Promise.resolve(AT),
}));

import { ProfilePage } from "../src/pages/profile.tsx";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";
const user: Profile = decodeProfile(USER, fixture("profile-user.json"));
const parentProfile: Profile = decodeProfile(PARENT, fixture("profile-parent.json"));

let root: HTMLElement | undefined;
async function show(vnode: preact.VNode): Promise<HTMLElement> {
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(vnode, root!));
  return root;
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";

beforeEach(() => {
  readProfile.mockReset().mockResolvedValue(null);
  resolveName.mockReset().mockResolvedValue(null);
  pendingRequestsOf.mockReset().mockResolvedValue([]);
  document.title = "identit.ee";
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
});

describe("ProfilePage by address", () => {
  it("shows a quiet card of the same shape while the chain answers, then the profile", async () => {
    let answer: (p: Profile) => void = () => undefined;
    readProfile.mockReturnValue(new Promise<Profile>((resolve) => (answer = resolve)));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    const loading = el.querySelector(".card")!;
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelector(".head")).not.toBeNull();
    expect(loading.textContent).toBe("");

    await act(async () => answer(user));
    await settle();
    expect(el.querySelector(".card")!.getAttribute("aria-busy")).toBeNull();
    expect(text(el.querySelector(".name"))).toBe("Fixture User");
    expect(readProfile).toHaveBeenCalledWith(USER, AT);
  });

  it("reads the same account whatever the prefix of the address in the URL", async () => {
    readProfile.mockResolvedValue(user);
    const hex = `0x${Buffer.from((await import("@polkadot/util-crypto")).decodeAddress(USER)).toString("hex")}`;
    const el = await show(<ProfilePage target={{ by: "address", address: hex }} />);
    await settle();
    expect(readProfile).toHaveBeenCalledWith(USER, AT);
    expect(text(el.querySelector(".name"))).toBe("Fixture User");
  });

  it("says Pending only for what an authority was asked about, read at the block of the profile", async () => {
    readProfile.mockResolvedValue(user);
    const states = (el: HTMLElement) => [...el.querySelectorAll(".row")].map((row) => [text(row.querySelector("dt")), text(row.querySelector(".state"))]);
    let el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(pendingRequestsOf).toHaveBeenCalledWith(USER, AT);
    expect(states(el)).toEqual([["Email", "Verified"], ["Telegram", ""], ["PGP", ""], ["mastodon", ""]]);
    render(null, el);
    el.remove();

    pendingRequestsOf.mockResolvedValue([{ authority: 0, target: { field: { typed: "Pgp" } }, since: 5 }]);
    el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(states(el)).toEqual([["Email", "Verified"], ["Telegram", ""], ["PGP", "Pending"], ["mastodon", ""]]);
  });

  it("does not show a profile whose requests could not be read", async () => {
    readProfile.mockResolvedValue(user);
    pendingRequestsOf.mockRejectedValue(new Error("Cannot reach the identit.ee network."));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("Cannot reach the identit.ee network.");
    expect(el.querySelector(".name")).toBeNull();
  });

  it("says No identity found for an account without identity", async () => {
    readProfile.mockResolvedValue(null);
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("No identity found.");
    expect(el.querySelector(".head")).toBeNull();
  });

  it("does not ask the chain, nor paint an avatar, for text that is not an address, and says it is not one", async () => {
    for (const address of ["", "hello", "5Grwva", `${USER}x`, "0x1234", "0x" + "ab".repeat(33)]) {
      const el = await show(<ProfilePage target={{ by: "address", address }} />);
      await settle();
      expect(text(el.querySelector(".note")), address).toBe("This is not a valid address.");
      expect(el.querySelector("form.lookup"), address).not.toBeNull();
      expect(el.querySelector("canvas"), address).toBeNull();
      render(null, el);
      el.remove();
    }
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("offers the owner of an empty account to create an identity, and nobody else", async () => {
    readProfile.mockResolvedValue(null);
    let el = await show(<ProfilePage target={{ by: "address", address: USER }} own />);
    await settle();
    expect(el.querySelector(".card")!.getAttribute("aria-label")).toBe("No identity yet");
    expect(text(el.querySelector(".note"))).toBe("This account has no identity yet.");
    expect(el.querySelector("a.button.primary")?.getAttribute("href")).toBe("/me");
    expect(text(el.querySelector("a.button"))).toBe("Create your identity");
    expect(el.querySelector("form.lookup")).toBeNull();
    render(null, el);
    el.remove();

    el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(el.querySelector("a.button")).toBeNull();
    // a visitor gets a way to look again instead
    expect(el.querySelector("form.lookup")).not.toBeNull();
  });

  it("offers the owner of an identity to edit it", async () => {
    readProfile.mockResolvedValue(user);
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} own />);
    await settle();
    expect([...el.querySelectorAll("a.button")].map((a) => [text(a), a.getAttribute("href")])).toEqual([["Edit your identity", "/me"]]);
  });
});

describe("ProfilePage by name", () => {
  it("resolves the name, then reads the profile of its owner", async () => {
    resolveName.mockResolvedValue(USER);
    readProfile.mockResolvedValue(user);
    const el = await show(<ProfilePage target={{ by: "name", name: "fixtureuser" }} />);
    await settle();
    expect(resolveName).toHaveBeenCalledWith("fixtureuser");
    expect(readProfile).toHaveBeenCalledWith(USER, AT);
    expect(text(el.querySelector(".name"))).toBe("Fixture User");
  });

  it("says nobody has a name nobody owns, without reading a profile", async () => {
    resolveName.mockResolvedValue(null);
    const el = await show(<ProfilePage target={{ by: "name", name: "nobody" }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("Nobody has the name nobody.");
    expect(el.querySelector("form.lookup")).not.toBeNull();
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("looks the name up in lower case, and never asks for one that cannot exist", async () => {
    resolveName.mockResolvedValue(null);
    await show(<ProfilePage target={{ by: "name", name: "Alice" }} />);
    await settle();
    expect(resolveName).toHaveBeenCalledWith("alice");
    resolveName.mockClear();
    const el = await show(<ProfilePage target={{ by: "name", name: "x".repeat(33) }} />);
    await settle();
    expect(resolveName).not.toHaveBeenCalled();
    expect(text(el.querySelector(".note"))).toBe("No identity found.");
  });

  it.each(["robots.txt", "favicon.ico", "ab", "a b", "café", "日本語日本語", "é".repeat(17), "..", "wp-login.php", "%2e%2e"])(
    "does not ask the chain about %j, which cannot be a username",
    async (name) => {
      const el = await show(<ProfilePage target={{ by: "name", name }} />);
      await settle();
      expect(resolveName).not.toHaveBeenCalled();
      expect(readProfile).not.toHaveBeenCalled();
      expect(text(el.querySelector(".note"))).toBe("No identity found.");
    },
  );

  it("still asks about the longest and the shortest names that can exist", async () => {
    for (const name of ["abc", "x".repeat(32), "a-b_c"]) await show(<ProfilePage target={{ by: "name", name }} />);
    await settle();
    expect(resolveName.mock.calls.map((c) => c[0])).toEqual(["abc", "x".repeat(32), "a-b_c"]);
  });
});

describe("a page that changes target or fails", () => {
  it("shows loading, not the previous profile, when the target changes", async () => {
    resolveName.mockResolvedValue(USER);
    readProfile.mockResolvedValueOnce(user);
    const el = await show(<ProfilePage target={{ by: "name", name: "fixtureuser" }} />);
    await settle();
    expect(text(el.querySelector(".name"))).toBe("Fixture User");

    let answer: (p: Profile) => void = () => undefined;
    readProfile.mockReturnValueOnce(new Promise<Profile>((resolve) => (answer = resolve)));
    await act(() => render(<ProfilePage target={{ by: "name", name: "other" }} />, el));
    expect(el.querySelector(".card")!.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelector(".name")).toBeNull();
    await act(async () => answer({ ...user, name: "other", fields: [] }));
    await settle();
    expect(text(el.querySelector(".name"))).toBe("other");
  });

  it("ignores an answer that arrives after the target changed", async () => {
    let late: (p: Profile) => void = () => undefined;
    readProfile.mockReturnValueOnce(new Promise<Profile>((resolve) => (late = resolve)));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    readProfile.mockResolvedValueOnce(null);
    await act(() => render(<ProfilePage target={{ by: "address", address: PARENT }} />, el));
    await settle();
    expect(text(el.querySelector(".note"))).toBe("No identity found.");
    await act(async () => late(user));
    expect(text(el.querySelector(".note"))).toBe("No identity found.");
    expect(el.querySelector(".name")).toBeNull();
  });

  it("says the network cannot be reached, and tries again on request", async () => {
    readProfile.mockRejectedValueOnce(new Error("Cannot reach the identit.ee network.")).mockResolvedValue(user);
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("Cannot reach the identit.ee network.");
    await act(() => el.querySelector<HTMLButtonElement>("button.button")!.click());
    await settle();
    expect(text(el.querySelector(".name"))).toBe("Fixture User");
    expect(readProfile.mock.calls.filter(([address]) => address === USER)).toHaveLength(2);
  });

  it("does not show a technical error to the person", async () => {
    readProfile.mockRejectedValue(new Error("RPC-CORE: getStorage(key: StorageKey): StorageData:: -32603: Internal error: TrieError"));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("Cannot read this identity right now.");
  });

  it("explains an answer it cannot decode", async () => {
    readProfile.mockRejectedValue(new DecodeError("profile"));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(text(el.querySelector(".note"))).toBe("Unexpected answer from the chain: profile.");
  });
});

describe("the parent of a sub-account", () => {
  it("shows its short address first, then its name once read", async () => {
    let named: (p: Profile) => void = () => undefined;
    readProfile.mockImplementation((address: string) =>
      address === USER ? Promise.resolve(user) : new Promise<Profile>((resolve) => (named = resolve)),
    );
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    const link = () => el.querySelector<HTMLAnchorElement>(".member a")!;
    expect(link().textContent).toBe(`${PARENT.slice(0, 8)}…${PARENT.slice(-8)}`);
    expect(link().getAttribute("href")).toBe(`/a/${PARENT}`);

    await act(async () => named({ ...parentProfile, name: "theparent" }));
    expect(link().textContent).toBe("theparent");
    expect(link().getAttribute("href")).toBe("/theparent");
  });

  it("links a parent whose username is a fixed path of the app through its address", async () => {
    readProfile.mockImplementation((address: string) =>
      Promise.resolve(address === USER ? user : { ...parentProfile, name: "requests" }),
    );
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(el.querySelector(".member a")!.getAttribute("href")).toBe(`/a/${PARENT}`);
  });

  it("keeps the short address when the parent cannot be read", async () => {
    readProfile.mockImplementation((address: string) => (address === USER ? Promise.resolve(user) : Promise.reject(new Error("offline"))));
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(el.querySelector(".member a")!.textContent).toContain("…");
  });
});

describe("the tab title", () => {
  it("names the profile and goes back when the page goes", async () => {
    readProfile.mockResolvedValue(user);
    const el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(document.title).toBe("Fixture User - identit.ee");
    await act(() => render(null, el));
    expect(document.title).toBe("identit.ee");
  });

  it("says Not found for a profile that is not there, and nothing while it loads or fails", async () => {
    readProfile.mockReturnValueOnce(new Promise(() => undefined));
    let el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(document.title).toBe("identit.ee");
    render(null, el);
    el.remove();

    readProfile.mockRejectedValueOnce(new Error("Cannot reach the identit.ee network."));
    el = await show(<ProfilePage target={{ by: "address", address: USER }} />);
    await settle();
    expect(document.title).toBe("identit.ee");
    render(null, el);
    el.remove();

    el = await show(<ProfilePage target={{ by: "name", name: "nobody" }} />);
    await settle();
    expect(document.title).toBe("Not found - identit.ee");
    await act(() => render(null, el));
    expect(document.title).toBe("identit.ee");
  });
});
