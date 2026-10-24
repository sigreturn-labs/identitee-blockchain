import { describe, expect, it } from "vitest";
import type { ProfileLink } from "../src/chain/identity.ts";
import { type LinkDraft, linkEdits, linkTrouble } from "../src/pages/me-form.ts";

// The links part of the one `update_profile`: what the form sends for the links as the person left
// them, against the links on chain.
const link = (id: number, title: string, url: string): ProfileLink => ({ id, title, url, verified: false, rejected: false });
const ON_CHAIN = [link(0, "Website", "https://user.example"), link(1, "Code", "https://git.example/user"), link(2, "Blog", "https://blog.example")];
const draft = (original: ProfileLink, change: Partial<LinkDraft> = {}): LinkDraft => ({
  key: `link:${original.id}`,
  title: original.title,
  url: original.url,
  removed: false,
  original,
  ...change,
});
const fresh = (title: string, url: string, key = "new:1"): LinkDraft => ({ key, title, url, removed: false, original: null });
const asShown = () => ON_CHAIN.map((l) => draft(l));

describe("linkEdits", () => {
  it("sends nothing for the links as they are on chain, none included", () => {
    expect(linkEdits(asShown(), ON_CHAIN)).toBeUndefined();
    expect(linkEdits([], [])).toBeUndefined();
    // the same text with spaces around, or an address without its scheme, is the same link
    const same = asShown();
    same[0] = { ...same[0]!, title: " Website ", url: "user.example" };
    expect(linkEdits(same, ON_CHAIN)).toBeUndefined();
  });

  it("sends the new order as a list of Keep", () => {
    const [a, b, c] = asShown();
    expect(linkEdits([c!, a!, b!], ON_CHAIN)).toEqual([{ keep: 2 }, { keep: 0 }, { keep: 1 }]);
  });

  it("sends a changed link as Update, in its place, as typed", () => {
    const drafts = asShown();
    drafts[1] = { ...drafts[1]!, title: "Source", url: "git.example/other" };
    expect(linkEdits(drafts, ON_CHAIN)).toEqual([{ keep: 0 }, { update: 1, title: "Source", url: "git.example/other" }, { keep: 2 }]);
  });

  it("sends a new link as Add, after the others", () => {
    expect(linkEdits([...asShown(), fresh("Shop", "https://shop.example")], ON_CHAIN)).toEqual([
      { keep: 0 },
      { keep: 1 },
      { keep: 2 },
      { add: true, title: "Shop", url: "https://shop.example" },
    ]);
    expect(linkEdits([fresh("First", "https://first.example")], [])).toEqual([{ add: true, title: "First", url: "https://first.example" }]);
  });

  it("leaves a removed link out of the list, which is how the chain removes it", () => {
    const drafts = asShown();
    drafts[0] = { ...drafts[0]!, removed: true };
    expect(linkEdits(drafts, ON_CHAIN)).toEqual([{ keep: 1 }, { keep: 2 }]);
    // every link removed: an empty list, not "keep them"
    expect(linkEdits(asShown().map((d) => ({ ...d, removed: true })), ON_CHAIN)).toEqual([]);
  });

  it("puts a mix of all of them in the order shown", () => {
    const [a, b, c] = asShown();
    const drafts = [b!, { ...a!, title: "Site" }, { ...c!, removed: true }, fresh("Shop", "https://shop.example")];
    expect(linkEdits(drafts, ON_CHAIN)).toEqual([
      { keep: 1 },
      { update: 0, title: "Site", url: "https://user.example" },
      { add: true, title: "Shop", url: "https://shop.example" },
    ]);
  });
});

describe("links stored by another client", () => {
  // the chain takes any text: a link written by polkadot.js Apps or a script may not be in the form
  // this page writes, and must still read as unchanged and untroubled until the person edits it
  const odd = [link(0, " Blog ", "example.com"), link(1, "Files", "ipfs://bafy")];

  it("are unchanged and untroubled as read", () => {
    const drafts = odd.map((l) => draft(l));
    expect(linkEdits(drafts, odd)).toBeUndefined();
    expect(linkTrouble(drafts).size).toBe(0);
  });

  it("are kept as they are when another link changes, and checked once edited", () => {
    const drafts = [draft(odd[0]!), draft(odd[1]!, { url: "ipfs://other" })];
    expect(linkEdits(drafts, odd)).toEqual([{ keep: 0 }, { update: 1, title: "Files", url: "ipfs://other" }]);
    expect(linkTrouble(drafts).has("link:1")).toBe(true);
  });
});

describe("linkTrouble", () => {
  it("says what is wrong with a link as typed, by its key, and nothing for one left alone or removed", () => {
    const drafts = asShown();
    drafts[0] = { ...drafts[0]!, title: " " };
    drafts[1] = { ...drafts[1]!, url: "javascript:alert(1)" };
    drafts[2] = { ...drafts[2]!, url: "", removed: true };
    const found = linkTrouble([...drafts, fresh("Shop", "not a site", "new:9")]);
    expect([...found]).toEqual([
      ["link:0", "Give the link a title."],
      ["link:1", "Links start with http:// or https://."],
      ["new:9", "That is not a web address."],
    ]);
    expect(linkTrouble(asShown()).size).toBe(0);
  });
});
