// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The card reads the profiles of the sub-accounts to link them by name: never the chain here.
const { readProfile } = vi.hoisted(() => ({ readProfile: vi.fn() }));
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/identity.ts")>()),
  readProfile,
}));

import { decodeProfile, type Profile, type ProfileField } from "../src/chain/identity.ts";
import { type PendingRequest, verifyItems } from "../src/chain/requests.ts";
import {
  describeUrl,
  displayNameOf,
  displayValue,
  fieldRows,
  headline,
  ONE_COLUMN_MAX,
  ProfileView,
  websiteOf,
} from "../src/pages/profile.tsx";

// The real answers of a dev node (see test/fixtures/README.txt), drawn by the real component.
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const PARENT = "idnLHSmv5dsrPchjHig4iKyALqy5nLX46MbvkgTKPvLFc5QQz";

const user = (): Profile => decodeProfile(USER, fixture("profile-user.json"));
const parent = (): Profile => decodeProfile(PARENT, fixture("profile-parent.json"));

let root: HTMLElement | undefined;
function draw(profile: Profile, parentLink: { title: string; path: string } | null = null, pending: PendingRequest[] = [], own = false): HTMLElement {
  root = document.createElement("div");
  document.body.append(root);
  render(<ProfileView profile={profile} parent={parentLink} pending={pending} own={own} />, root);
  return root;
}
/** A judgement request waiting at authority 0, for the field or link with this id. */
function asked(...ids: string[]): PendingRequest[] {
  return ids.map((id, i) => {
    const [kind, key] = id.split(":") as ["typed" | "custom" | "link", string];
    const field = kind === "link" ? { link: Number(key) } : kind === "typed" ? { typed: key as never } : { custom: key };
    return { authority: 0, target: { field }, since: i + 1 };
  });
}
beforeEach(() => {
  readProfile.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
});

const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const rows = (el: HTMLElement) =>
  [...el.querySelectorAll(".row")].map((row) => ({
    label: text(row.querySelector("dt")),
    value: text(row.querySelector("dd:not(.state)")),
    state: text(row.querySelector("dd.state")), // "" when the row has no state
    private: row.querySelector("dd.private") !== null,
  }));

function field(id: string, over: Partial<ProfileField> = {}): ProfileField {
  const name = id.replace(/^.*:/, "");
  return {
    ref: { custom: name },
    id,
    label: name,
    privacy: "public",
    value: `value of ${name}`,
    bytes: null,
    commitment: `0x${"00".repeat(32)}`,
    verified: false,
    rejected: false,
    ...over,
  };
}
const withFields = (count: number): Profile => ({
  ...parent(),
  subs: [],
  fields: Array.from({ length: count }, (_, i) => field(`custom:field${i + 1}`)),
});

describe("the header of the card", () => {
  it("shows the display name, the username, the short address and the level", () => {
    const el = draw(user());
    expect(text(el.querySelector(".name"))).toBe("Fixture User");
    expect([...el.querySelectorAll(".head .addr")].map((e) => text(e))).toEqual(["fixtureuser", `${USER.slice(0, 8)}…${USER.slice(-8)}`]);
    expect(text(el.querySelector(".level"))).toBe("Partially Verified");
  });

  it("puts the full address in the title of the short one", () => {
    const el = draw(user());
    const short = el.querySelector<HTMLElement>(".head .addr[title]")!;
    expect(short.textContent).toBe(`${USER.slice(0, 8)}…${USER.slice(-8)}`);
    expect(short.title).toBe(USER);
  });

  it("falls back from the display name to the username, then to the short address", () => {
    const noDisplay: Profile = { ...user(), fields: user().fields.filter((f) => f.id !== "typed:DisplayName") };
    expect(headline(noDisplay)).toEqual({ title: "fixtureuser", handle: null, titleIsAddress: false });
    const el = draw(noDisplay);
    expect(text(el.querySelector(".name"))).toBe("fixtureuser");
    render(null, el);

    const bare: Profile = { ...noDisplay, name: null };
    expect(headline(bare)).toEqual({ title: `${USER.slice(0, 8)}…${USER.slice(-8)}`, handle: null, titleIsAddress: true });
    const again = draw(bare);
    expect(text(again.querySelector(".name"))).toBe(`${USER.slice(0, 8)}…${USER.slice(-8)}`);
    expect(again.querySelector(".name")?.getAttribute("title")).toBe(USER);
    // the short address is not shown twice
    expect(again.querySelectorAll(".head .addr")).toHaveLength(0);
  });

  it("offers to copy the full address, with or without the short one shown", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      const el = draw(user());
      const copy = el.querySelector<HTMLButtonElement>(".head button.copy")!;
      expect([text(copy), copy.getAttribute("aria-label"), copy.getAttribute("title")]).toEqual(["", "Copy address", "Copy address"]);
      await act(async () => copy.click());
      expect(writeText).toHaveBeenCalledWith(USER);
      expect(copy.querySelector("svg")!.getAttribute("data-icon")).toBe("check");
      expect(text(el.querySelector('.head [role="status"]'))).toBe("Copied");
      render(null, el);

      const bare = draw({ ...user(), name: null, fields: [] });
      expect(bare.querySelector(".head button.copy")!.getAttribute("aria-label")).toBe("Copy address");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says so when the browser refuses the copy, rather than look like it copied", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    try {
      const el = draw(user());
      const copy = el.querySelector<HTMLButtonElement>(".head button.copy")!;
      await act(async () => {
        copy.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(text(el.querySelector('.head [role="status"]'))).toBe("Copy failed");
      expect(copy.querySelector("svg")!.getAttribute("data-icon")).not.toBe("check");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("links the owner, and only the owner, to the editor", () => {
    const own = draw(user(), null, [], true);
    expect([...own.querySelectorAll("a.button")].map((a) => [text(a), a.getAttribute("href")])).toEqual([["Edit your identity", "/me"]]);
    render(null, own);
    expect(draw(user()).querySelector("a.button")).toBeNull();
  });

  it("does not repeat a username that is the display name", () => {
    expect(headline({ ...user(), name: "FIXTURE USER" }).handle).toBeNull();
  });

  it("ignores a private display name: the person did not want it shown", () => {
    const privateName: Profile = {
      ...user(),
      fields: user().fields.map((f) => (f.id === "typed:DisplayName" ? { ...f, privacy: "private" as const, value: null } : f)),
    };
    expect(displayNameOf(privateName)).toBeNull();
    expect(headline(privateName).title).toBe("fixtureuser");
    // it is still a field of the identity, so it stays in the list, as private
    expect(fieldRows(privateName).map((f) => f.id)).toContain("typed:DisplayName");
  });

  it.each([
    ["Certified", "Certified"],
    ["FullyVerified", "Fully Verified"],
    ["PartiallyVerified", "Partially Verified"],
    ["Declared", "Declared"],
    ["Fraudulent", "Fraudulent"],
  ] as const)("names the level %s", (trust, label) => {
    const el = draw({ ...user(), trust });
    expect(text(el.querySelector(".level"))).toBe(label);
  });

  it.each([
    ["Declared", null],
    ["PartiallyVerified", "Partially Verified"],
    ["FullyVerified", "Fully Verified"],
    ["Certified", "Certified"],
    ["Fraudulent", "Fraudulent"],
  ] as const)("puts the badge of %s beside the name", (trust, badge) => {
    const el = draw({ ...user(), trust });
    expect(el.querySelector(".title-line .badge")?.getAttribute("aria-label") ?? null).toBe(badge);
  });

  it("says plainly, and only then, that an identity was found fraudulent", () => {
    expect(draw({ ...user(), trust: "Fraudulent" }).querySelector(".fraud-note")).not.toBeNull();
    expect(draw({ ...user(), trust: "Fraudulent" }).querySelector(".level.fraud")).not.toBeNull();
    for (const trust of ["Declared", "PartiallyVerified", "FullyVerified", "Certified"] as const) {
      expect(draw({ ...user(), trust }).querySelector(".fraud-note, .level.fraud")).toBeNull();
    }
  });
});

describe("the avatar", () => {
  it("is the WebP stored on chain when there is one", () => {
    const el = draw(user());
    const img = el.querySelector<HTMLImageElement>("img.avatar")!;
    expect(img.getAttribute("src")).toMatch(/^data:image\/webp;base64,UklGR/);
    expect(el.querySelector("canvas.avatar")).toBeNull();
  });

  it("is the generated avatar of the address when there is none", () => {
    const el = draw({ ...user(), avatar: null });
    expect(el.querySelector("canvas.avatar")).not.toBeNull();
    expect(el.querySelector("img.avatar")).toBeNull();
  });

  it("falls back to the generated avatar when the browser cannot show the stored image", () => {
    const el = draw(user());
    el.querySelector("img.avatar")!.dispatchEvent(new Event("error"));
    return vi.waitFor(() => expect(el.querySelector("canvas.avatar")).not.toBeNull());
  });
});

describe("the fields", () => {
  it("lists them with English labels, the display name left to the header", () => {
    const el = draw(user());
    expect(rows(el)).toEqual([
      { label: "Email", value: "user@example.org", state: "Verified", private: false },
      { label: "Telegram", value: "Private", state: "", private: true },
      { label: "PGP", value: Array(10).fill("ABAB").join(" "), state: "", private: false },
      { label: "mastodon", value: "@user@m.example", state: "", private: false },
    ]);
  });

  it("groups a PGP fingerprint by four so that it wraps between groups", () => {
    const pgp = user().fields.find((f) => f.id === "typed:Pgp")!;
    expect(displayValue(pgp)).toBe("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB");
    expect(displayValue({ ...pgp, value: "ABCDEF" })).toBe("ABCD EF");
    expect(displayValue(user().fields.find((f) => f.id === "typed:Email")!)).toBe("user@example.org");
  });

  it("shows a private value as the word Private, never as a value (its look is in the stylesheet, test/styles.test.ts)", () => {
    const el = draw(user());
    const dd = el.querySelector(".row dd.private")!;
    expect(dd.textContent).toBe("Private");
    expect(dd.className).toBe("private");
    expect(el.innerHTML).not.toContain("0x2222");
  });

  it("calls Verified only a field that the chain reads as verified", () => {
    const profile = user();
    const email = profile.fields.find((f) => f.id === "typed:Email")!;
    // the same field, as the runtime reports it once its attestation is no longer valid: no state
    // word at all, since nobody was asked about it
    const lapsed: Profile = { ...profile, fields: profile.fields.map((f) => (f === email ? { ...f, verified: false } : f)) };
    expect(rows(draw(lapsed)).find((r) => r.label === "Email")!.state).toBe("");
  });

  it("says Pending only for a field that an authority was asked to judge", () => {
    const el = draw(user(), null, asked("typed:Telegram", "custom:mastodon"));
    expect(rows(el).map((r) => [r.label, r.state])).toEqual([
      ["Email", "Verified"],
      ["Telegram", "Pending"],
      ["PGP", ""],
      ["mastodon", "Pending"],
    ]);
    // a request for a field this identity does not have changes nothing here
    expect(rows(draw(user(), null, asked("custom:gone", "typed:Matrix"))).map((r) => r.state)).toEqual(["Verified", "", "", ""]);
  });

  it("draws a row without a state with two cells and no dot", () => {
    const el = draw(user());
    const pgp = [...el.querySelectorAll(".row")].find((r) => text(r.querySelector("dt")) === "PGP")!;
    expect(pgp.children).toHaveLength(2);
    expect(pgp.querySelector(".state")).toBeNull();
  });

  it("reads a field the way /requests does: one ranking for the two pages", () => {
    const base = user();
    /** The state word of the PGP field on the profile and on /requests. */
    const stateOf = (flags: { verified: boolean; rejected: boolean }, waiting: boolean) => {
      const profile: Profile = { ...base, fields: base.fields.map((f) => (f.id === "typed:Pgp" ? { ...f, ...flags } : f)) };
      const pending = waiting ? asked("typed:Pgp") : [];
      const onProfile = rows(draw(profile, null, pending)).find((r) => r.label === "PGP")!.state || null;
      render(null, root!);
      return { profile: onProfile, requests: verifyItems(profile, pending).find((i) => i.id === "typed:Pgp")!.standing };
    };
    for (const verified of [false, true]) {
      for (const rejected of [false, true]) {
        for (const waiting of [false, true]) {
          const { profile, requests } = stateOf({ verified, rejected }, waiting);
          expect(profile, JSON.stringify({ verified, rejected, waiting })).toBe(requests);
        }
      }
    }
    // a rejected value asked about again reads Pending, on both, until the new verdict
    expect(stateOf({ verified: false, rejected: true }, true)).toEqual({ profile: "Pending", requests: "Pending" });
    expect(stateOf({ verified: false, rejected: true }, false)).toEqual({ profile: "Rejected", requests: "Rejected" });
  });

  it("draws every state with one component: its mark, the word, and the word again as title", () => {
    const profile = user();
    const email = profile.fields.find((f) => f.id === "typed:Email")!;
    const mixed: Profile = {
      ...profile,
      fields: profile.fields.map((f) => (f === email ? { ...f, verified: false, rejected: true } : f)),
      links: profile.links.map((l, i) => ({ ...l, verified: i === 0 })),
    };
    const el = draw(mixed, null, asked("typed:Telegram", "custom:mastodon"));
    const states = [...el.querySelectorAll(".state")].map((s) => [s.tagName, s.className, s.textContent, s.getAttribute("title")]);
    expect(states).toEqual([
      ["DD", "state standing rejected", "Rejected", "Rejected"],
      ["DD", "state standing pending", "Pending", "Pending"],
      ["DD", "state standing pending", "Pending", "Pending"],
      ["SPAN", "state standing verified", "Verified", "Verified"],
    ]);
    // Verified is the filled check alone; Pending a dashed ring; Rejected a ring struck through
    const icon = (i: number) => el.querySelectorAll(".state")[i]!.querySelector("svg.mark-icon")!;
    expect(el.querySelectorAll(".state")[3]!.querySelector(".visually-hidden")!.textContent).toBe("Verified");
    expect(icon(1).querySelector("circle")!.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(icon(0).querySelector("circle")!.getAttribute("stroke-dasharray")).toBeNull();
    expect(icon(0).querySelector("path")).not.toBeNull();
  });

  it("draws a state, when there is one, in the fixed right column", () => {
    const el = draw(user(), null, asked("typed:Telegram"));
    for (const row of el.querySelectorAll(".row")) {
      const hasState = row.querySelector(".state") !== null;
      expect(row.children).toHaveLength(hasState ? 3 : 2);
      if (hasState) expect(row.children[2]!.classList.contains("state")).toBe(true);
    }
    expect(el.querySelectorAll(".row .state")).toHaveLength(2);
    expect(el.querySelectorAll(".row .state.pending")).toHaveLength(1);
  });

  it.each([
    [4, false],
    [ONE_COLUMN_MAX, false],
    [ONE_COLUMN_MAX + 1, true],
    [12, true],
  ])("with %i fields: two columns and a wide card is %s", (count, two) => {
    const el = draw(withFields(count));
    expect(el.querySelectorAll(".row")).toHaveLength(count);
    expect(el.querySelector(".fields")!.classList.contains("two")).toBe(two);
    expect(el.querySelector(".card")!.classList.contains("wide")).toBe(two);
  });

  it("shows no list at all for an identity without fields", () => {
    const el = draw(withFields(0));
    expect(el.querySelector(".fields")).toBeNull();
  });
});

describe("the bio, the links and the relatives", () => {
  it("shows the bio as text", () => {
    const el = draw({ ...user(), bio: "Line one\n<b>not markup</b>" });
    expect(el.querySelector(".bio")!.textContent).toBe("Line one\n<b>not markup</b>");
    expect(el.querySelector(".bio b")).toBeNull();
  });

  it("omits an empty bio", () => {
    expect(draw({ ...user(), bio: "" }).querySelector(".bio")).toBeNull();
  });

  it("opens links in a new tab, without the opener", () => {
    const el = draw(user());
    const links = [...el.querySelectorAll<HTMLAnchorElement>("a.link")];
    expect(links.map((a) => [text(a.querySelector(".link-title")), text(a.querySelector(".link-url")), a.getAttribute("href")])).toEqual([
      ["Website", "user.example", "https://user.example/"],
      ["Code", "git.example/user", "https://git.example/user"],
    ]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
  });

  it("does not turn a javascript: or data: address into a link", () => {
    const evil: Profile = {
      ...user(),
      links: [
        { id: 0, title: "Click", url: "javascript:alert(1)", verified: false, rejected: false },
        { id: 1, title: "Data", url: "data:text/html,<script>alert(1)</script>", verified: false, rejected: false },
        { id: 2, title: "Plain", url: "not a url", verified: false, rejected: false },
      ],
    };
    const el = draw(evil);
    expect(el.querySelectorAll("a.link")).toHaveLength(0);
    expect(el.querySelectorAll("div.link")).toHaveLength(3);
    expect(el.querySelector("[href^='javascript']")).toBeNull();
  });

  it("marks a link like a field: Verified, Rejected, Pending when a request waits, nothing otherwise", () => {
    const profile = user();
    const marks = (el: HTMLElement) => [...el.querySelectorAll(".link")].map((l) => l.querySelector(".state")?.textContent ?? null);
    expect(marks(draw({ ...profile, links: profile.links.map((l, i) => ({ ...l, verified: i === 0 })) }))).toEqual(["Verified", null]);
    render(null, root!);
    expect(marks(draw({ ...profile, links: profile.links.map((l, i) => ({ ...l, rejected: i === 1 })) }))).toEqual([null, "Rejected"]);
    render(null, root!);
    expect(marks(draw(profile, null, asked("link:0")))).toEqual(["Pending", null]);
    render(null, root!);
    // a rejected link asked about again reads Pending, as a field does
    expect(marks(draw({ ...profile, links: profile.links.map((l, i) => ({ ...l, rejected: i === 1 })) }, null, asked("link:1")))).toEqual([null, "Pending"]);
  });

  it("says whose member a sub-account is, with a link to the parent", () => {
    const el = draw(user(), { title: "The parent", path: "/theparent" });
    const member = el.querySelector(".member")!;
    expect(member.textContent).toBe("Member of The parent");
    expect(member.querySelector("a")!.getAttribute("href")).toBe("/theparent");
  });

  it("says nothing of a parent for an account that has none", () => {
    expect(draw(parent()).querySelector(".member")).toBeNull();
  });

  it("lists the accepted sub-accounts, each linking to its profile", () => {
    const el = draw(parent());
    const subs = [...el.querySelectorAll<HTMLAnchorElement>(".subs a.link")];
    expect(subs.map((a) => [text(a.querySelector(".link-title")), a.getAttribute("href"), a.querySelector(".link-meta")!.getAttribute("title")])).toEqual([
      ["main laptop", `/a/${USER}`, USER],
    ]);
    expect(subs[0]!.target).toBe("");
    expect(text(el.querySelector(".subs h2"))).toBe("Sub-accounts");
  });

  it("links each sub-account to its username page, by name, once its profile is read", async () => {
    readProfile.mockImplementation(async (address: string) => (address === USER ? user() : null));
    let el!: HTMLElement;
    await act(() => void (el = draw(parent())));
    const sub = () => el.querySelector<HTMLAnchorElement>(".subs a.link")!;
    // by address until the profile is read
    expect(sub().getAttribute("href")).toBe(`/a/${USER}`);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(readProfile).toHaveBeenCalledWith(USER);
    // the label the parent gave it stays the title; the name moves where the address was
    expect([text(sub().querySelector(".link-title")), text(sub().querySelector(".link-url")), sub().getAttribute("href")]).toEqual([
      "main laptop",
      "Fixture User",
      "/fixtureuser",
    ]);
  });

  it("shows no section for an account without sub-accounts", () => {
    expect(draw(user()).querySelector(".subs")).toBeNull();
  });
});

describe("the Website field", () => {
  const web = (value: string): Profile => ({
    ...user(),
    fields: [...user().fields, field("typed:Web", { ref: { typed: "Web" }, label: "Website", value })],
  });

  it("is a link, opened in a new tab without the opener", () => {
    const el = draw(web("https://user.example/blog"));
    const link = el.querySelector<HTMLAnchorElement>(".row dd a.value-link")!;
    expect([text(link), link.getAttribute("href"), link.target]).toEqual(["user.example/blog", "https://user.example/blog", "_blank"]);
    expect(link.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("is plain text when it is not a web address", () => {
    const el = draw(web("javascript:alert(1)"));
    expect(el.querySelector(".value-link")).toBeNull();
    expect(rows(el).find((r) => r.label === "Website")!.value).toBe("javascript:alert(1)");
  });
});

describe("websiteOf", () => {
  it.each([
    ["https://user.example", "user.example", "https://user.example/"],
    ["user.example/me", "user.example/me", "https://user.example/me"],
    ["http://example.org:8080", "example.org:8080", "http://example.org:8080/"],
  ])("follows %s, shown as %s", (value, shown, href) => {
    expect(websiteOf(value)).toEqual({ text: shown, href });
  });

  it.each(["javascript:alert(1)", "mailto:a@b.c", "not a website", "localhost"])("does not follow %j", (value) => {
    expect(websiteOf(value)).toEqual({ text: value, href: null });
  });
});

describe("house style", () => {
  it("has none of the forbidden punctuation or fonts", () => {
    const full: Profile = { ...user(), subs: parent().subs };
    const el = draw(full, { title: "The parent", path: "/theparent" });
    expect(el.textContent).not.toMatch(/[·—]/);
    expect(el.innerHTML).not.toMatch(/monospace|font-family/i);
  });

  it("shows no fee, price or amount", () => {
    expect(draw(user()).textContent).not.toMatch(/\bfees?\b|\bIDT\b|\bcost/i);
  });
});

describe("describeUrl", () => {
  it.each([
    ["https://sigreturn.dev", "sigreturn.dev", "https://sigreturn.dev/"],
    ["https://sigreturn.dev/", "sigreturn.dev", "https://sigreturn.dev/"],
    ["https://youtube.com/@sigreturn", "youtube.com/@sigreturn", "https://youtube.com/@sigreturn"],
    ["http://example.org:8080/a/b/?q=1#x", "example.org:8080/a/b", "http://example.org:8080/a/b/?q=1#x"],
  ])("shows %s as %s", (url, shown, href) => {
    expect(describeUrl(url)).toEqual({ text: shown, href });
  });

  it.each(["javascript:alert(1)", "data:text/plain,hi", "mailto:a@b.c", "ftp://example.org", "//example.org", "plain text", ""])(
    "does not follow %j",
    (url) => {
      expect(describeUrl(url)).toEqual({ text: url, href: null });
    },
  );
});
