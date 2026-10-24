import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LIMITS,
  bioProblem,
  byteLength,
  chainChange,
  fieldChanges,
  fieldDrafts,
  fieldKey,
  fieldProblem,
  firstProblem,
  linkProblem,
  webAddressProblem,
  mergeOrder,
  moved,
  needsSecret,
  normalizeUrl,
  parsePgp,
  textOf,
  withCustom,
  type FieldDraft,
} from "../src/chain/edit.ts";
import { decodeProfile, type Profile } from "../src/chain/identity.ts";
import { Refusal } from "../src/chain/refusal.ts";

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const profile = (): Profile =>
  decodeProfile(USER, JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")));
const limitsRs = readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "src", "limits.rs"), "utf8");
const rustLimit = (name: string): number => Number(new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(limitsRs)![1]);

const draft = (drafts: FieldDraft[], id: string): FieldDraft => drafts.find((d) => d.id === id)!;
const edited = (drafts: FieldDraft[], id: string, patch: Partial<FieldDraft>): FieldDraft[] =>
  drafts.map((d) => (d.id === id ? { ...d, ...patch } : d));
const hex = (bytes: Uint8Array | null): string | null => (bytes === null ? null : new TextDecoder().decode(bytes));

describe("the limits are those of the runtime", () => {
  it.each([
    ["value", "MAX_VALUE_LEN"],
    ["customKey", "MAX_CUSTOM_KEY_LEN"],
    ["customFields", "MAX_CUSTOM_FIELDS"],
    ["links", "MAX_LINKS"],
    ["linkTitle", "MAX_LINK_TITLE_LEN"],
    ["bio", "MAX_BIO_LEN"],
    ["changes", "MAX_FIELD_CHANGES"],
    ["secretBlob", "MAX_SECRET_BLOB_LEN"],
    ["note", "MAX_NOTE_LEN"],
  ] as const)("%s", (name, constant) => {
    expect(LIMITS[name]).toBe(rustLimit(constant));
  });
});

describe("byteLength", () => {
  it("counts UTF-8 bytes, as the runtime does", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("日本")).toBe(6);
    expect(byteLength("😀")).toBe(4);
    expect(byteLength("")).toBe(0);
  });
});

describe("the bio", () => {
  it("is refused over 560 bytes, not over 560 characters", () => {
    expect(bioProblem("a".repeat(560))).toBeNull();
    expect(bioProblem("a".repeat(561))).toBe("Too long, 561 of 560 bytes.");
    expect(bioProblem("é".repeat(281))).toBe("Too long, 562 of 560 bytes.");
    expect(bioProblem("é".repeat(280))).toBeNull();
  });
});

describe("fieldDrafts", () => {
  it("lists every typed field in the chain's order, then the custom ones, filled from the profile", () => {
    const drafts = fieldDrafts(profile());
    expect(drafts.map((d) => d.id)).toEqual([
      "typed:DisplayName",
      "typed:LegalName",
      "typed:Web",
      "typed:Email",
      "typed:Matrix",
      "typed:X",
      "typed:Discord",
      "typed:GitHub",
      "typed:Telegram",
      "typed:Pgp",
      "custom:mastodon",
    ]);
    expect(draft(drafts, "typed:DisplayName").text).toBe("Fixture User");
    expect(draft(drafts, "typed:Email").text).toBe("user@example.org");
    expect(draft(drafts, "typed:Web").original).toBeNull();
  });

  it("groups a PGP fingerprint by four and never holds a private value", () => {
    const drafts = fieldDrafts(profile());
    expect(draft(drafts, "typed:Pgp").text).toBe(Array(10).fill("ABAB").join(" "));
    expect(draft(drafts, "typed:Telegram").text).toBe("");
    expect(draft(drafts, "typed:Telegram").original!.privacy).toBe("private");
    expect(textOf(draft(drafts, "typed:Telegram").original!)).toBe("");
  });

  it("is the empty form for an account without identity", () => {
    const drafts = fieldDrafts(null);
    expect(drafts).toHaveLength(10);
    expect(drafts.every((d) => d.original === null && d.text === "")).toBe(true);
  });
});

describe("fieldChanges", () => {
  it("is empty when nothing changed, even though the form holds every field", () => {
    expect(fieldChanges(fieldDrafts(profile()))).toEqual([]);
    expect(fieldChanges(fieldDrafts(null))).toEqual([]);
  });

  it("sends only what changed", () => {
    let drafts = fieldDrafts(profile());
    drafts = edited(drafts, "typed:Email", { text: "new@example.org" });
    drafts = edited(drafts, "typed:Web", { text: "https://user.example" });
    const changes = fieldChanges(drafts);
    expect(changes.map((c) => [c.ref, hex(c.value)])).toEqual([
      [{ typed: "Web" }, "https://user.example"],
      [{ typed: "Email" }, "new@example.org"],
    ]);
  });

  it("ignores spaces around a value, and leaves a field alone that only differs by them", () => {
    let drafts = fieldDrafts(profile());
    drafts = edited(drafts, "typed:Email", { text: "  user@example.org  " });
    drafts = edited(drafts, "typed:Web", { text: "  https://user.example \n" });
    expect(fieldChanges(drafts).map((c) => [c.ref, hex(c.value)])).toEqual([[{ typed: "Web" }, "https://user.example"]]);
  });

  it("stores a website with its scheme, as a link is stored", () => {
    const drafts = edited(fieldDrafts(profile()), "typed:Web", { text: " user.example/me " });
    expect(fieldChanges(drafts).map((c) => [c.ref, hex(c.value)])).toEqual([[{ typed: "Web" }, "https://user.example/me"]]);
  });

  it("removes a field that was emptied or marked, and does not remove one that was never there", () => {
    let drafts = fieldDrafts(profile());
    drafts = edited(drafts, "typed:Email", { text: "" });
    drafts = edited(drafts, "custom:mastodon", { removed: true });
    drafts = edited(drafts, "typed:Web", { removed: true });
    expect(fieldChanges(drafts)).toEqual([
      { ref: { typed: "Email" }, value: null },
      { ref: { custom: "mastodon" }, value: null },
    ]);
  });

  it("leaves a private field alone, and removes it only when asked", () => {
    const drafts = fieldDrafts(profile());
    expect(fieldChanges(drafts).some((c) => "typed" in c.ref && c.ref.typed === "Telegram")).toBe(false);
    expect(fieldChanges(edited(drafts, "typed:Telegram", { removed: true }))).toEqual([{ ref: { typed: "Telegram" }, value: null }]);
  });

  it("sends a PGP fingerprint as bytes, from hexadecimal typed in any case, spaced, with 0x", () => {
    const base = fieldDrafts(null);
    const bytes = (text: string) => fieldChanges(edited(base, "typed:Pgp", { text }))[0]!.value!;
    expect(Array.from(bytes("0x" + "ab".repeat(20)))).toEqual(Array(20).fill(0xab));
    expect(Array.from(bytes("AB AB ".repeat(10)))).toHaveLength(20);
    expect(Array.from(bytes("0F".repeat(32)))).toHaveLength(32);
    // unchanged from the chain (grouped, upper case) is not a change
    expect(fieldChanges(edited(fieldDrafts(profile()), "typed:Pgp", { text: "abab ".repeat(10) }))).toEqual([]);
  });

  it("never rewrites a field the person did not touch, even if it is stored with spaces around it", () => {
    const base = fieldDrafts(profile());
    const spaced = base.map((d) =>
      d.id === "typed:Email" && d.original
        ? { ...d, text: "  user@example.org ", original: { ...d.original, value: "  user@example.org ", bytes: new TextEncoder().encode("  user@example.org ") } }
        : d,
    );
    // the form shows what the chain holds, spaces included: nothing to send, nothing to complain about
    expect(fieldChanges(spaced)).toEqual([]);
    expect(firstProblem(spaced)).toBeNull();
    // typing in it is a change like any other, and is trimmed
    const typed = edited(spaced, "typed:Email", { text: "  other@example.org " });
    expect(fieldChanges(typed).map((c) => [c.ref, hex(c.value)])).toEqual([[{ typed: "Email" }, "other@example.org"]]);
  });

  it("refuses to compute the changes of a form with a problem", () => {
    const drafts = edited(fieldDrafts(null), "typed:Matrix", { text: "x".repeat(257) });
    expect(() => fieldChanges(drafts)).toThrow(/Matrix: Too long, 257 of 256 bytes/);
  });

  it("gives a new custom field to the chain as a change of its own", () => {
    const added = withCustom(fieldDrafts(profile()), "pronouns", "they/them");
    if (added.problem !== null) throw new Error(added.problem);
    expect(fieldChanges(added.drafts).map((c) => [c.ref, hex(c.value)])).toEqual([[{ custom: "pronouns" }, "they/them"]]);
  });
});

describe("private fields", () => {
  it("start as they are on the chain: a private one private, the others public", () => {
    const drafts = fieldDrafts(profile());
    expect(draft(drafts, "typed:Telegram").private).toBe(true);
    expect(draft(drafts, "typed:Email").private).toBe(false);
    expect(fieldDrafts(null).every((d) => !d.private)).toBe(true);
  });

  it("send a new value made private as a private change, with its bytes", () => {
    const drafts = edited(fieldDrafts(null), "typed:Email", { text: " me@example.org ", private: true });
    const changes = fieldChanges(drafts);
    expect(changes.map((c) => [c.ref, hex(c.value), c.private])).toEqual([[{ typed: "Email" }, "me@example.org", true]]);
    expect(needsSecret(changes)).toBe(true);
    expect(needsSecret(fieldChanges(edited(fieldDrafts(null), "typed:Email", { text: "me@example.org" })))).toBe(false);
  });

  it("turn a public field made private into a private change, even with the same value", () => {
    const changes = fieldChanges(edited(fieldDrafts(profile()), "typed:Email", { private: true }));
    expect(changes.map((c) => [c.ref, hex(c.value), c.private])).toEqual([[{ typed: "Email" }, "user@example.org", true]]);
  });

  it("check a private value as a public one, since it must be revealable", () => {
    const long = edited(fieldDrafts(null), "typed:Matrix", { text: "x".repeat(257), private: true });
    expect(firstProblem(long)).toBe("Matrix: Too long, 257 of 256 bytes.");
    const email = edited(fieldDrafts(null), "typed:Email", { text: "not an email", private: true });
    expect(firstProblem(email)).toBe("Email: That is not an email address.");
    const pgp = edited(fieldDrafts(null), "typed:Pgp", { text: "abc", private: true });
    expect(firstProblem(pgp)).toMatch(/PGP fingerprint/);
    const good = edited(fieldDrafts(null), "typed:Pgp", { text: "ab".repeat(20), private: true });
    expect(fieldChanges(good)[0]!.value).toEqual(new Uint8Array(20).fill(0xab));
  });

  it("go to the chain as Private(commitment) under the field's salt, never as the value", () => {
    const salt = new Uint8Array(32).fill(0x11);
    const change = { ref: { typed: "Telegram" as const }, value: new TextEncoder().encode("@alice"), private: true as const };
    const saltOf = vi.fn(() => salt);
    expect(chainChange(change, saltOf)).toEqual([{ Typed: "Telegram" }, { Private: "0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0" }]);
    expect(saltOf).toHaveBeenCalledWith({ typed: "Telegram" });
    expect(() => chainChange(change)).toThrow(/identity secret/);
  });

  it("make the key of reveal_field like the key of set_identity", () => {
    expect(fieldKey({ typed: "Email" })).toEqual({ Typed: "Email" });
    expect(fieldKey({ custom: "mastodon" })).toEqual({ Custom: "0x6d6173746f646f6e" });
  });
});

describe("fieldProblem", () => {
  const form = () => fieldDrafts(profile());

  it("counts the bytes of a value, not its characters", () => {
    const drafts = form();
    expect(fieldProblem({ ...draft(drafts, "typed:Matrix"), text: "a".repeat(256) }, drafts)).toBeNull();
    expect(fieldProblem({ ...draft(drafts, "typed:Matrix"), text: "é".repeat(129) }, drafts)).toBe("Too long, 258 of 256 bytes.");
  });

  it.each(["abc", "ABAB", "zz".repeat(20), "ab".repeat(19), "ab".repeat(21), "ab".repeat(31), "ab".repeat(33)])(
    "refuses %j as a PGP fingerprint",
    (text) => {
      const drafts = form();
      expect(fieldProblem({ ...draft(drafts, "typed:Pgp"), text }, drafts)).toBe("A PGP fingerprint has 40 or 64 hexadecimal characters.");
    },
  );

  it("does not judge what will not be sent: an empty field, a removed one, a private one", () => {
    const drafts = form();
    expect(fieldProblem({ ...draft(drafts, "typed:Pgp"), text: "" }, drafts)).toBeNull();
    expect(fieldProblem({ ...draft(drafts, "typed:Pgp"), text: "nonsense", removed: true }, drafts)).toBeNull();
    expect(fieldProblem(draft(drafts, "typed:Telegram"), drafts)).toBeNull();
  });

  it("refuses a custom field without a name, with a long one, or with the name of another", () => {
    const drafts = form();
    const custom = draft(drafts, "custom:mastodon");
    expect(fieldProblem({ ...custom, ref: { custom: " " }, id: "custom: " }, drafts)).toBe("Give the field a name.");
    const long = "k".repeat(33);
    expect(fieldProblem({ ...custom, ref: { custom: long }, id: `custom:${long}` }, drafts)).toBe("The name is too long, 33 of 32 bytes.");
    const twin: FieldDraft = { ...custom, original: null };
    expect(fieldProblem(twin, [...drafts, twin])).toBe("Two fields have that name.");
  });

  it("does not complain about a value the person did not touch, whatever it holds", () => {
    const drafts = form();
    const display = draft(drafts, "typed:DisplayName");
    const long = "x".repeat(300);
    const stored = { ...display, text: long, original: { ...display.original!, value: long, bytes: new TextEncoder().encode(long) } };
    expect(fieldProblem(stored, drafts)).toBeNull();
    expect(fieldProblem({ ...stored, text: `${long}y` }, drafts)).toBe("Too long, 301 of 256 bytes.");
  });

  it("refuses a website that is not a web address, and an email that is not an email", () => {
    const drafts = form();
    const web = draft(drafts, "typed:Web");
    expect(fieldProblem({ ...web, text: "not a url" }, drafts)).toBe("That is not a web address.");
    expect(fieldProblem({ ...web, text: "javascript:alert(1)" }, drafts)).toBe("Links start with http:// or https://.");
    expect(fieldProblem({ ...web, text: "user.example" }, drafts)).toBeNull();
    const email = draft(drafts, "typed:Email");
    expect(fieldProblem({ ...email, text: "user@example" }, drafts)).toBe("That is not an email address.");
    expect(fieldProblem({ ...email, text: "user example.org" }, drafts)).toBe("That is not an email address.");
    expect(fieldProblem({ ...email, text: " other@example.org " }, drafts)).toBeNull();
  });

  it("refuses a new custom field named like a built-in one, whatever its case, but not one already stored", () => {
    const drafts = form();
    const custom = draft(drafts, "custom:mastodon");
    const named: FieldDraft = { ...custom, ref: { custom: "EMAIL" }, id: "custom:EMAIL", label: "EMAIL", original: null };
    expect(fieldProblem(named, [...drafts, named])).toBe("That name belongs to a built-in field. Use the built-in field, or another name.");
    // one that is on the chain already is the person's to keep
    const stored: FieldDraft = { ...named, original: custom.original };
    expect(fieldProblem(stored, [...drafts, stored])).toBeNull();
  });

  it("names the field in the first problem of a form", () => {
    expect(firstProblem(form())).toBeNull();
    const drafts = edited(form(), "typed:Pgp", { text: "nope" });
    expect(firstProblem(drafts)).toBe("PGP: A PGP fingerprint has 40 or 64 hexadecimal characters.");
  });
});

describe("withCustom", () => {
  const fresh = () => fieldDrafts(null);

  it("adds a field, with its name and value trimmed", () => {
    const added = withCustom(fresh(), "  mastodon ", " @me@example.social ");
    expect(added.problem).toBeNull();
    const last = (added as { drafts: FieldDraft[] }).drafts.at(-1)!;
    expect([last.id, last.label, last.text, last.original]).toEqual(["custom:mastodon", "mastodon", "@me@example.social", null]);
  });

  it.each([
    ["", "x", "Give the field a name."],
    ["name", "", "Give the field a value."],
    ["k".repeat(33), "x", "The name is too long, 33 of 32 bytes."],
    ["name", "v".repeat(257), "Too long, 257 of 256 bytes."],
  ])("refuses %j = %j", (name, value, problem) => {
    expect(withCustom(fresh(), name, value)).toEqual({ problem });
  });

  it("refuses the name of a built-in field, whatever its case", () => {
    const problem = "That name belongs to a built-in field. Use the built-in field, or another name.";
    expect(withCustom(fresh(), "Website", "x")).toEqual({ problem });
    expect(withCustom(fresh(), " display NAME ", "x")).toEqual({ problem });
  });

  it("refuses a name already used, and a 17th custom field", () => {
    expect(withCustom(fieldDrafts(profile()), "mastodon", "x")).toEqual({ problem: "You already have a field with that name." });
    let drafts = fresh();
    for (let i = 0; i < 16; i++) {
      const next = withCustom(drafts, `field${i}`, "x");
      if (next.problem !== null) throw new Error(next.problem);
      drafts = next.drafts;
    }
    expect(withCustom(drafts, "one-more", "x")).toEqual({ problem: "You have reached the limit of custom fields." });
  });
});

describe("parsePgp", () => {
  it("accepts 40 or 64 hexadecimal characters only", () => {
    expect(parsePgp("ab".repeat(20))?.length).toBe(20);
    expect(parsePgp("AB".repeat(32))?.length).toBe(32);
    expect(parsePgp("ab".repeat(24))).toBeNull();
    expect(parsePgp("")).toBeNull();
  });
});

describe("links", () => {
  it("adds https:// to an address without a scheme, and leaves the rest as typed", () => {
    expect(normalizeUrl(" example.org/me ")).toBe("https://example.org/me");
    expect(normalizeUrl("http://example.org")).toBe("http://example.org");
    expect(normalizeUrl("https://Example.org/A")).toBe("https://Example.org/A");
  });

  it("takes a host and a port for an address without a scheme, not for a scheme", () => {
    expect(normalizeUrl("localhost:3000")).toBe("https://localhost:3000");
    expect(normalizeUrl("example.com:8080/path?q=1")).toBe("https://example.com:8080/path?q=1");
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080");
    expect(normalizeUrl("[::1]:3000")).toBe("https://[::1]:3000");
    // these ARE schemes, and stay as typed so that they are refused
    for (const text of ["javascript:alert(1)", "mailto:a@b.c", "data:text/html,hi", "ftp://example.org", "tel:+33123456789", "foo:123abc"]) {
      expect(normalizeUrl(text), text).toBe(text);
    }
  });

  it("accepts web addresses", () => {
    expect(linkProblem("Blog", "localhost:3000")).toBe("That is not a web address.");
    expect(linkProblem("Blog", "example.com:8080/blog")).toBeNull();
    expect(linkProblem("Blog", "example.org/blog")).toBeNull();
    expect(linkProblem("Blog", "http://example.org")).toBeNull();
    expect(linkProblem("日本".repeat(10), "https://example.org")).toBeNull();
  });

  it.each([
    ["", "https://a.b", "Give the link a title."],
    ["  ", "https://a.b", "Give the link a title."],
    ["T", "", "Give the link an address."],
    ["T", "javascript:alert(1)", "Links start with http:// or https://."],
    ["T", "mailto:a@b.c", "Links start with http:// or https://."],
    ["T", "example.com:99999", "That is not a web address."],
    ["T", "data:text/html,hi", "Links start with http:// or https://."],
    ["T", "mailto:a@b.c", "Links start with http:// or https://."],
    ["T", "https://", "That is not a web address."],
    ["T", "not a url", "That is not a web address."],
    ["t".repeat(65), "https://a.b", "The title is too long, 65 of 64 bytes."],
    ["日本".repeat(11), "https://a.b", "The title is too long, 66 of 64 bytes."],
    ["T", `https://a.b/${"x".repeat(250)}`, "Too long, 262 of 256 bytes."],
  ])("refuses %j and %j", (title, url, problem) => {
    expect(linkProblem(title, url)).toBe(problem);
  });

  it("wants a host with a dot or an IP address (no localhost on a public profile), which browsers do not check", () => {
    expect(webAddressProblem("https://not a url")).toBe("That is not a web address.");
    expect(webAddressProblem("https://intranet")).toBe("That is not a web address.");
    expect(webAddressProblem("https://localhost:3000")).toBe("That is not a web address.");
    expect(webAddressProblem("[::1]:3000")).toBeNull();
    expect(webAddressProblem(" example.org ")).toBeNull();
  });

  it("counts the https:// it will add when judging the length", () => {
    // "https://" (8) + "a.b/" (4) + 244 = 256 bytes fits, one more does not
    expect(linkProblem("T", `a.b/${"x".repeat(244)}`)).toBeNull();
    expect(linkProblem("T", `a.b/${"x".repeat(245)}`)).toBe("Too long, 257 of 256 bytes.");
  });

  it("keeps the order the person chose, and puts new links last", () => {
    expect(mergeOrder([3, 1, 2], [1, 2, 3])).toEqual([3, 1, 2]);
    expect(mergeOrder([3, 1, 2], [1, 3])).toEqual([3, 1]);
    expect(mergeOrder([3, 1], [1, 2, 3, 4])).toEqual([3, 1, 2, 4]);
    expect(mergeOrder([], [5, 6])).toEqual([5, 6]);
  });

  it("moves a link one place, and stays put at the ends", () => {
    expect(moved([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moved([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moved([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moved([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(moved([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });
});

describe("what the form refuses", () => {
  it("says it in a Refusal, which a page shows as it is", () => {
    const drafts = fieldDrafts(profile());
    const pgp = drafts.find((d) => d.id === "typed:Pgp")!;
    expect(() => fieldChanges([{ ...pgp, text: "not a fingerprint" }])).toThrow(Refusal);
    expect(() => chainChange({ ref: { typed: "Email" }, value: new Uint8Array([1]), private: true })).toThrow(Refusal);
  });
});

describe("chainChange", () => {
  it("gives set_identity its argument shape, [key, option of value]", () => {
    expect(chainChange({ ref: { typed: "Email" }, value: new TextEncoder().encode("a@b.c") })).toEqual([{ Typed: "Email" }, { Public: "0x6140622e63" }]);
    expect(chainChange({ ref: { custom: "mastodon" }, value: null })).toEqual([{ Custom: "0x6d6173746f646f6e" }, null]);
  });
});
