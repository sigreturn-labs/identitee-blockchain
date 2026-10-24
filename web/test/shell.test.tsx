// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../src/chain/identity.ts";

// The whole app in a DOM: header, wallet button, home page and routes, with the chain replaced by
// answers captured from a dev node and the wallet by a fake `window.injectedWeb3`. Modules are
// reset for each test: the wallet state is module-level, as in a fresh page load.
const { readProfile, resolveName, readAgent, pendingRequestsOf, AT } = vi.hoisted(() => ({
  readProfile: vi.fn(),
  resolveName: vi.fn(),
  readAgent: vi.fn(),
  pendingRequestsOf: vi.fn(),
  AT: { block: "the block a profile and its requests are read at" },
}));
// a profile and the requests waiting on it are read at one block: no connection is made
vi.mock("../src/chain/reader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/reader.ts")>()),
  snapshot: () => Promise.resolve(AT),
}));
vi.mock("../src/chain/requests.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/requests.ts")>()),
  pendingRequestsOf,
}));
vi.mock("../src/chain/agent.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/agent.ts")>()), readAgent }));
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/identity.ts")>()),
  readProfile,
  resolveName,
}));

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const EVE = "idnnuZEwh4Dv3QfxF6oS2zMD881G1KvXWXaWgYeBUAusWkd64";
const SHORT_USER = `${USER.slice(0, 8)}…${USER.slice(-8)}`;

// The first visit to a page loads the chain libraries (a second of transform in a loaded machine).
vi.setConfig({ testTimeout: 30_000 });
const waitFor = <T,>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 15_000, interval: 25 });

const enable = vi.fn();
function inject(...accounts: { address: string; name: string }[]): void {
  (window as unknown as { injectedWeb3: object }).injectedWeb3 = {
    "polkadot-js": {
      version: "1.0.0",
      enable: async () => {
        enable();
        return {
          accounts: {
            get: async () => accounts.map((a) => ({ ...a, type: "sr25519" })),
            subscribe: (cb: (list: unknown[]) => void) => {
              cb(accounts);
              return () => undefined;
            },
          },
          signer: {},
        };
      },
    },
  };
}

let cleanup: (() => void) | undefined;

/** The app, in a page that has just loaded. */
async function open(path = "/") {
  vi.resetModules();
  history.replaceState(null, "", path);
  const { render } = await import("preact");
  const { act } = await import("preact/test-utils");
  const { App } = await import("../src/app.tsx");
  const root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<App />, root));
  cleanup = () => {
    render(null, root);
    root.remove();
  };
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  const click = async (el: Element | null | undefined) => {
    await act(() => (el as HTMLElement).click());
    await settle();
  };
  await settle();
  // the page of the route is a lazy chunk: wait until its card is there
  await waitFor(() => expect(root.querySelector(".stage section")).not.toBeNull());
  return { root, act, settle, click };
}

const button = (root: HTMLElement) => root.querySelector<HTMLButtonElement>("header button.connect")!;
/** The Connect wallet button of the card, on the pages that have one. */
const cardButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>(".card button.primary")!;
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const NO_WALLET = "No wallet found. Install Talisman, SubWallet or polkadot.js, then try again.";
/** The card's last note: the wallet's answer comes after the page's own purpose line. */
const lastNote = (root: HTMLElement) => root.querySelector(".card .note:last-of-type");

const user = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as object);

beforeEach(async () => {
  enable.mockReset();
  localStorage.clear();
  readProfile.mockReset().mockImplementation(async (address: string) => {
    const { decodeProfile } = await import("../src/chain/identity.ts");
    return address === USER ? (decodeProfile(USER, user) as Profile) : null;
  });
  resolveName.mockReset().mockResolvedValue(null);
  pendingRequestsOf.mockReset().mockResolvedValue([]);
  readAgent.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  // extension-dapp sets this to `{}` when it is loaded and expects it to stay: no extension is an empty one
  (window as unknown as { injectedWeb3: object }).injectedWeb3 = {};
});

describe("a first visit", () => {
  it("shows a calm landing, with one Connect wallet button, and asks nothing of the wallet", async () => {
    inject({ address: USER, name: "Fixture" });
    const { root } = await open("/");
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("Connect");
    // a way to look someone up first, then "Connect wallet": no remark, and no second button in the header
    const search = root.querySelector<HTMLInputElement>(".card form.lookup input")!;
    expect(search.getAttribute("aria-label")).toBe("Name or address");
    expect([...root.querySelectorAll("button")].map((b) => text(b))).toEqual(["Find", "Connect wallet"]);
    expect(root.querySelector(".card .note")).toBeNull();
    expect(root.querySelector("header button")).toBeNull();
    expect(enable).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("shows the same Connect wallet card on /me, never a blank card", async () => {
    inject({ address: USER, name: "Fixture" });
    const { root } = await open("/me");
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("Connect");
    // what the wallet is for, then the button; no lookup here
    expect(text(root.querySelector(".card .note"))).toBe("Connect your wallet to create or edit your identity.");
    expect(text(cardButton(root))).toBe("Connect wallet");
    expect(root.querySelector(".card form.lookup")).toBeNull();
    expect(root.querySelector("header button")).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });

  it("keeps the header button on the pages that have no card of their own", async () => {
    inject({ address: USER, name: "Fixture" });
    const { root } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
    expect(text(button(root))).toBe("Connect wallet");
  });

  it("shows a public profile without ever loading the wallet", async () => {
    inject({ address: USER, name: "Fixture" });
    const { root } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
    expect(enable).not.toHaveBeenCalled();
    expect(text(button(root))).toBe("Connect wallet");
  });
});

describe("connecting", () => {
  it("with one account: the profile of that account appears, and the button shows the wallet's name for it", async () => {
    inject({ address: USER, name: "Fixture" });
    const { root, click } = await open("/");
    await click(cardButton(root));
    await waitFor(() => expect(text(root.querySelector(".card .name"))).toBe("Fixture User"));
    expect(text(button(root))).toBe("Fixture");
    expect(button(root).title).toBe(USER);
    expect(readProfile).toHaveBeenCalledWith(USER, AT);
    expect(localStorage.getItem("identitee.account")).toBe(USER);
    // the menu stays closed: nothing to choose
    expect(root.querySelector(".menu")).toBeNull();
  });

  it("with several accounts, on the home page: the card asks which one, and shows the profile of the one chosen", async () => {
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    const { root, click } = await open("/");
    await click(cardButton(root));
    await waitFor(() => expect(root.querySelector(".card .accounts")).not.toBeNull());
    expect(root.querySelector(".menu")).toBeNull();
    expect(text(lastNote(root))).toBe("Choose an account.");
    const accounts = [...root.querySelectorAll<HTMLButtonElement>(".card .account")];
    expect(accounts.map((a) => text(a.querySelector(".account-name")))).toEqual(["Eve", "Fixture"]);
    expect(root.querySelector("header button")).toBeNull();

    await click(accounts[1]);
    await waitFor(() => expect(text(root.querySelector(".card .name"))).toBe("Fixture User"));
    expect(text(button(root))).toBe("Fixture");
  });

  it("with several accounts, on another page: the menu asks which one", async () => {
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    const { root, click } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
    await click(button(root));
    await waitFor(() => expect(root.querySelector(".menu")).not.toBeNull());
    expect(text(root.querySelector(".menu .note"))).toBe("Choose an account.");
    const accounts = [...root.querySelectorAll<HTMLButtonElement>(".menu .account")];
    expect(accounts.map((a) => text(a.querySelector(".account-name")))).toEqual(["Eve", "Fixture"]);

    await click(accounts[1]);
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    expect(root.querySelector(".menu")).toBeNull();
    // still on the page it was on
    expect(location.pathname).toBe(`/a/${USER}`);
  });

  it("without a wallet, on the home page or /me: the card says so; on another page, the menu does", async () => {
    const home = await open("/");
    await home.click(cardButton(home.root));
    await waitFor(() => expect(text(lastNote(home.root))).toBe(NO_WALLET));
    // the names of the wallets lead to them, in a new tab
    const wallets = [...home.root.querySelectorAll<HTMLAnchorElement>(".card .note a")];
    expect(wallets.map((a) => text(a))).toEqual(["Talisman", "SubWallet", "polkadot.js"]);
    expect(wallets.every((a) => a.target === "_blank" && a.rel === "noopener noreferrer")).toBe(true);
    expect(home.root.querySelector(".menu")).toBeNull();
    cleanup?.();

    const me = await open("/me");
    await me.click(cardButton(me.root));
    await waitFor(() => expect(text(lastNote(me.root))).toBe(NO_WALLET));
    cleanup?.();

    const other = await open(`/a/${USER}`);
    await other.click(button(other.root));
    await waitFor(() => expect(text(other.root.querySelector(".menu .note"))).toBe(NO_WALLET));
    expect(text(button(other.root))).toBe("Connect wallet");
  });

  it("asks to approve in the wallet while it answers, and says it refused when it gives nothing", async () => {
    // an extension that is installed, and never answers
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = { talisman: { version: "1.0.0", enable: () => new Promise(() => undefined) } };
    const waiting = await open("/");
    await waiting.click(cardButton(waiting.root));
    await waitFor(() => expect(text(lastNote(waiting.root))).toBe("Approve the request in your wallet."));
    cleanup?.();

    // one that is installed and refuses the site: not "No wallet found"
    (window as unknown as { injectedWeb3: object }).injectedWeb3 = { talisman: { version: "1.0.0", enable: async () => Promise.reject(new Error("Rejected")) } };
    const refused = await open("/");
    await refused.click(cardButton(refused.root));
    await waitFor(() => expect(text(lastNote(refused.root))).toBe("Your wallet did not give identit.ee access. Allow it in the wallet, then try again."));
  });

  it("with a wallet that has no account: says so, in the card of /me and in the menu elsewhere", async () => {
    inject();
    const me = await open("/me");
    await me.click(cardButton(me.root));
    await waitFor(() => expect(text(lastNote(me.root))).toBe("No account found in your wallet."));
    cleanup?.();

    const other = await open(`/a/${USER}`);
    await other.click(button(other.root));
    await waitFor(() => expect(text(other.root.querySelector(".menu .note"))).toBe("No account found in your wallet."));
  });

  it("an account without identity is offered to create one", async () => {
    inject({ address: EVE, name: "Eve" });
    const { root, click } = await open("/");
    await click(cardButton(root));
    await waitFor(() => expect(text(root.querySelector(".note"))).toBe("This account has no identity yet."));
    expect(root.querySelector(".stage section")!.getAttribute("aria-label")).toBe("No identity yet");
    const create = root.querySelector("a.button.primary")!;
    expect([text(create), create.getAttribute("href")]).toEqual(["Create your identity", "/me"]);
  });

  it("an account with an identity is offered to edit it, from its own home profile only", async () => {
    inject({ address: USER, name: "Fixture" });
    const home = await open("/");
    await home.click(cardButton(home.root));
    await waitFor(() => expect(text(home.root.querySelector(".card .name"))).toBe("Fixture User"));
    const edit = [...home.root.querySelectorAll<HTMLAnchorElement>(".card a.button")].find((a) => text(a) === "Edit your identity");
    expect(edit?.getAttribute("href")).toBe("/me");
    cleanup?.();

    const other = await open(`/a/${USER}`);
    await waitFor(() => expect(text(other.root.querySelector(".name"))).toBe("Fixture User"));
    expect([...other.root.querySelectorAll(".card a")].some((a) => text(a) === "Edit your identity")).toBe(false);
  });

  it("and that link lands on a working form for the account, not an empty frame", async () => {
    inject({ address: EVE, name: "Eve" });
    const { root, click } = await open("/");
    await click(cardButton(root));
    await waitFor(() => expect(text(root.querySelector(".note"))).toBe("This account has no identity yet."));
    await click(root.querySelector("a.button"));
    expect(location.pathname).toBe("/me");
    await waitFor(() => expect(root.querySelector(".stage section")?.getAttribute("aria-label")).toBe("My identity"));
    // the empty form: ten typed fields, a bio, links, and nothing to save yet
    expect(root.querySelectorAll(".field input")).toHaveLength(10);
    expect(root.querySelector("#bio")).not.toBeNull();
    expect(readProfile).toHaveBeenCalledWith(EVE);
    // nothing changed: no Save bar, so no Save button anywhere
    expect(root.querySelector(".savebar")).toBeNull();
    expect([...root.querySelectorAll("button")].some((b) => text(b) === "Save")).toBe(false);
  });

  it("shows the working form on /me straight away for a remembered account", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: USER, name: "Fixture" });
    const { root } = await open("/me");
    await waitFor(() => expect(root.querySelector(".stage section")?.getAttribute("aria-label")).toBe("My identity"));
    expect((root.querySelector("#bio") as HTMLTextAreaElement).value).toBe("Fixture bio, on chain.");
  });

  it("closes the menu when the keyboard leaves it, and rules its links off the accounts above", async () => {
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    localStorage.setItem("identitee.account", USER);
    const { root, act, click } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    await click(button(root));
    await waitFor(() => expect(root.querySelector(".menu-links")).not.toBeNull());
    expect(root.querySelector(".menu-links")!.classList.contains("ruled")).toBe(true);
    // focus moving inside the menu keeps it open
    const box = root.querySelector(".account-box")!;
    const inside = root.querySelector<HTMLAnchorElement>(".menu-links a")!;
    await act(() => void box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: inside })));
    expect(root.querySelector(".menu")).not.toBeNull();
    await act(() => void box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: root.querySelector(".mark") })));
    await waitFor(() => expect(root.querySelector(".menu")).toBeNull());
  });

  it("shows the short address on the button for an account the wallet gives no name", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: USER, name: "  " });
    const { root } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(button(root))).toBe(SHORT_USER));
    expect(button(root).title).toBe(USER);
  });

  it("closes the menu on Escape and on a click elsewhere", async () => {
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    const { root, click } = await open(`/a/${USER}`);
    await click(button(root));
    await waitFor(() => expect(root.querySelector(".menu")).not.toBeNull());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => expect(root.querySelector(".menu")).toBeNull());
    // the keyboard is back where it was, on the button that opened the menu
    expect(document.activeElement).toBe(button(root));

    await click(button(root));
    expect(root.querySelector(".menu")).not.toBeNull();
    window.dispatchEvent(new Event("pointerdown"));
    await waitFor(() => expect(root.querySelector(".menu")).toBeNull());
  });
});

describe("a later visit", () => {
  it("takes the remembered account back by itself and shows its profile", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    const { root } = await open("/");
    await waitFor(() => expect(text(root.querySelector(".card .name"))).toBe("Fixture User"));
    expect(text(button(root))).toBe("Fixture");
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("shows the quiet card, not the landing, while the wallet answers", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: USER, name: "Fixture" });
    const { root } = await open("/");
    // whatever the timing, the connect card never flashes up for a returning visitor
    expect(root.querySelector(".card[aria-label=Connect]")).toBeNull();
  });

  it("ignores a remembered value that is not an address: landing, wallet not asked", async () => {
    localStorage.setItem("identitee.account", "garbage");
    inject({ address: USER, name: "Fixture" });
    const { root, settle } = await open("/");
    await settle();
    await waitFor(() => expect(root.querySelector(".card[aria-label=Connect]")).not.toBeNull());
    expect(enable).not.toHaveBeenCalled();
  });

  it("takes the only account the wallet has left when the remembered one is gone", async () => {
    localStorage.setItem("identitee.account", EVE);
    inject({ address: USER, name: "Fixture" });
    const { root } = await open("/");
    // one account left, not the remembered one: it is chosen, since it is the only one
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    expect(localStorage.getItem("identitee.account")).toBe(USER);
  });

  it("forgets the account on Disconnect", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: USER, name: "Fixture" });
    const { root, click } = await open("/");
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    await click(button(root));
    // one account: nothing to choose above the links, so no rule between them
    expect(root.querySelector(".menu-links")!.classList.contains("ruled")).toBe(false);
    const links = [...root.querySelectorAll<HTMLAnchorElement>(".menu-links a")];
    expect(links.map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["My identity", "/me"],
      ["Requests", "/requests"],
    ]);
    // not an authority agent: the chain was asked, and there is no Authority link
    expect(readAgent).toHaveBeenCalledWith(USER);
    await click([...root.querySelectorAll(".menu-links button")].find((b) => text(b) === "Disconnect"));
    // back to the landing: its card carries the one Connect wallet button
    await waitFor(() => expect(root.querySelector(".card[aria-label=Connect]")).not.toBeNull());
    expect(root.querySelector("header button")).toBeNull();
    expect(localStorage.getItem("identitee.account")).toBeNull();
  });

  it("on Disconnect elsewhere, closes the menu and shows Connect wallet again, not a list of accounts", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: EVE, name: "Eve" }, { address: USER, name: "Fixture" });
    const { root, click } = await open(`/a/${USER}`);
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    await click(button(root));
    await click([...root.querySelectorAll(".menu-links button")].find((b) => text(b) === "Disconnect"));
    await waitFor(() => expect(text(button(root))).toBe("Connect wallet"));
    expect(root.querySelector(".menu")).toBeNull();
    expect(root.querySelector(".account")).toBeNull();
  });
});

describe("the lookup of the home page", () => {
  const find = async (typed: string) => {
    const page = await open("/");
    const input = page.root.querySelector<HTMLInputElement>("form.lookup input")!;
    await page.act(() => {
      input.value = typed;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click(page.root.querySelector("form.lookup button"));
    return page;
  };

  it("goes to the page of a username, typed with an @ or in capitals", async () => {
    resolveName.mockResolvedValue(USER);
    const { root } = await find(" @FixtureUser ");
    await waitFor(() => expect(location.pathname).toBe("/fixtureuser"));
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
  });

  it("goes to the page of an address", async () => {
    await find(USER);
    await waitFor(() => expect(location.pathname).toBe(`/a/${USER}`));
  });

  it("says what is wrong with text that is neither, and stays", async () => {
    const { root } = await find("a b");
    expect(text(root.querySelector("form.lookup .problem"))).toBe("That is neither a name nor an address.");
    expect(location.pathname).toBe("/");
    cleanup?.();
    const empty = await find("  ");
    expect(text(empty.root.querySelector("form.lookup .problem"))).toBe("Type a name or an address.");
  });
});

describe("the Authority link", () => {
  it("is in the menu of an active agent only, and the chain is asked again when the menu opens", async () => {
    localStorage.setItem("identitee.account", USER);
    inject({ address: USER, name: "Fixture" });
    readAgent.mockResolvedValue({ authority: { id: 0, name: "identitee", active: true }, attest: true, facts: true, names: true });
    const { root, click } = await open("/");
    await waitFor(() => expect(text(button(root))).toBe("Fixture"));
    await click(button(root));
    await waitFor(() => expect([...root.querySelectorAll(".menu-links a")].map((a) => text(a))).toEqual(["My identity", "Requests", "Authority"]));
    expect(root.querySelector('.menu-links a[href="/authority"]')).not.toBeNull();
    // the agent is removed meanwhile: the next opening of the menu no longer shows the link
    readAgent.mockResolvedValue(null);
    await click(button(root));
    await click(button(root));
    await waitFor(() => expect([...root.querySelectorAll(".menu-links a")].map((a) => text(a))).toEqual(["My identity", "Requests"]));
  });
});

describe("downloading a page", () => {
  it("shows the skeleton of a profile card, not an empty page, while a profile page downloads", async () => {
    inject({ address: USER, name: "Fixture" });
    vi.resetModules();
    history.replaceState(null, "", `/a/${USER}`);
    const { render } = await import("preact");
    const { act } = await import("preact/test-utils");
    const { App } = await import("../src/app.tsx");
    const root = document.createElement("div");
    document.body.append(root);
    cleanup = () => {
      render(null, root);
      root.remove();
    };
    await act(() => render(<App />, root));
    const first = root.querySelector(".stage section");
    expect(first?.getAttribute("aria-label")).toBe("Loading");
    expect(first?.getAttribute("aria-busy")).toBe("true");
    expect(first?.querySelector(".head")).not.toBeNull();
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
  });

  it("shows a Reload card when the code of a page cannot be fetched (a tab left open across a release)", async () => {
    vi.doMock("../src/pages/name-profile.tsx", () => {
      throw new TypeError("Failed to fetch dynamically imported module: https://identit.ee/assets/name-profile-0a1b2c3d.js");
    });
    try {
      const { root } = await open("/fixtureuser");
      const card = root.querySelector(".stage section")!;
      expect(card.getAttribute("aria-label")).toBe("Not available");
      expect(text(card.querySelector(".note"))).toBe("This page could not be loaded. The site may have been updated.");
      expect(text(card.querySelector("button"))).toBe("Reload");
      // the header still works: the rest of the app is not down with it
      expect(text(button(root))).toBe("Connect wallet");
    } finally {
      vi.doUnmock("../src/pages/name-profile.tsx");
    }
  });
});

describe("routes", () => {
  it.each([
    ["/me", "Connect"],
    ["/requests", "Connect"],
    ["/authority", "Connect"],
  ])("%s shows its page, and does not look for a username of that name", async (path, label) => {
    const { root } = await open(path);
    await waitFor(() => expect(root.querySelector(".stage section")?.getAttribute("aria-label")).toBe(label));
    expect(resolveName).not.toHaveBeenCalled();
  });

  it("/:name looks the username up", async () => {
    resolveName.mockResolvedValue(USER);
    const { root } = await open("/fixtureuser");
    await waitFor(() => expect(text(root.querySelector(".name"))).toBe("Fixture User"));
    expect(resolveName).toHaveBeenCalledWith("fixtureuser");
  });

  it("says nobody has an unknown name, and that a bad address is not one, with a way to look again", async () => {
    const unknown = await open("/nobodyhere");
    await waitFor(() => expect(text(unknown.root.querySelector(".stage .note"))).toBe("Nobody has the name nobodyhere."));
    expect(unknown.root.querySelector(".stage form.lookup")).not.toBeNull();
    await waitFor(() => expect(document.title).toBe("Not found - identit.ee"));
    cleanup?.();
    const bad = await open("/a/not-an-address");
    await waitFor(() => expect(text(bad.root.querySelector(".stage .note"))).toBe("This is not a valid address."));
    expect(bad.root.querySelector(".stage form.lookup")).not.toBeNull();
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("says Page not found for a path that matches nothing", async () => {
    const { root } = await open("/a/b/c");
    await waitFor(() => expect(text(root.querySelector(".stage .note"))).toBe("Page not found."));
    expect(root.querySelector(".stage form.lookup")).not.toBeNull();
    await waitFor(() => expect(document.title).toBe("Not found - identit.ee"));
  });

  it("keeps the mark, the wallet button and a still background on every page", async () => {
    const { root } = await open(`/a/${USER}`);
    expect(root.querySelector("header .mark")?.textContent).toBe("identit.ee");
    expect(text(root.querySelector("header .mark span"))).toBe(".ee");
    expect(text(button(root))).toBe("Connect wallet");
    await waitFor(() => expect(root.querySelector("canvas.backdrop")?.classList.contains("still")).toBe(true));
  });
});
