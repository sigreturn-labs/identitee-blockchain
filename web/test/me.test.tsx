// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeProfile, type Profile } from "../src/chain/identity.ts";
import { Refusal } from "../src/chain/refusal.ts";
import type { SendResult } from "../src/chain/tx.ts";
import type { WalletModule } from "../src/ui/lazy-wallet.ts";
import { stringToHex, u8aToHex } from "@polkadot/util";
import { avatarChange } from "../src/chain/calls.ts";

// The editor, with the chain replaced by a fake: the real calls module builds every call against a
// stand-in `api.tx.identitee` that records what it is given (what would have gone over the
// network), and the wallet is a signer. What is under test is what the editor decides to send,
// when, and what it tells the person.
const { readProfile, identitySecret, send, chain } = vi.hoisted(() => {
  const sent: { method: string; args: unknown[] }[] = [];
  const broken: { error: Error | null } = { error: null };
  const tx = new Proxy(
    {},
    {
      // not a thenable: `await` would take it for a promise
      get: (_, method: string) =>
        method === "then"
          ? undefined
          : (...args: unknown[]) => {
              if (broken.error) {
                const error = broken.error;
                broken.error = null;
                throw error;
              }
              const call = { method, args };
              sent.push(call);
              return call;
            },
    },
  );
  return { readProfile: vi.fn(), identitySecret: vi.fn(), send: vi.fn(), chain: { sent, tx, broken } };
});
vi.mock("../src/chain/identity.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/identity.ts")>()), readProfile, identitySecret }));
vi.mock("../src/chain/tx.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain/tx.ts")>()), send }));
vi.mock("../src/chain/api.ts", () => ({ connect: async () => ({ tx: { identitee: chain.tx } }) }));
vi.mock("../src/media/webp.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/media/webp.ts")>()),
  openPicture: vi.fn(async () => ({ width: 200, height: 200 })),
  encodeAvatar: vi.fn(),
}));

import { MyIdentity } from "../src/pages/me-editor.tsx";
import { encodeAvatar } from "../src/media/webp.ts";

const USER = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "profile-user.json"), "utf8")) as object;
const LOSSY = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "..", "pallets", "identitee", "tests", "fixtures", "avatar-64-lossy.webp")));
const existing = (): Profile => decodeProfile(USER, fixture);
const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? "";
const OK: SendResult = { ok: true, events: [], blockHash: "0x01" };

const signerFor = vi.fn();
const wallet = { signerFor } as unknown as WalletModule;

let root: HTMLElement | undefined;
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function open(profile: Profile | null) {
  readProfile.mockResolvedValue(profile);
  root = document.createElement("div");
  document.body.append(root);
  await act(() => render(<MyIdentity address={USER} wallet={wallet} />, root!));
  await settle();
  return root;
}

/** The text of a label without the state it may carry (a verified field says Verified there). */
const labelText = (l: Element | null): string => {
  if (!l) return "";
  const copy = l.cloneNode(true) as Element;
  copy.querySelectorAll(".state").forEach((s) => s.remove());
  return text(copy);
};
const byLabel = (label: string) => {
  const target = [...root!.querySelectorAll("label")].find((l) => labelText(l) === label);
  return root!.querySelector<HTMLInputElement>(`#${target!.getAttribute("for")}`)!;
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  await act(() => void el.dispatchEvent(new Event("input", { bubbles: true })));
};
/** A button by its words, or by its accessible name: an icon button (Remove, Undo, Edit...) is
 * found by its whole aria-label, or by the verb it starts with inside a row ("Remove" in the row of
 * Telegram is "Remove Telegram"). */
const button = (label: string, within: ParentNode = root!): HTMLButtonElement | undefined => {
  const all = [...within.querySelectorAll("button")];
  return (
    all.find((b) => text(b) === label || b.getAttribute("aria-label") === label) ??
    all.find((b) => text(b) === "" && b.getAttribute("aria-label")?.startsWith(`${label} `))
  );
};
const click = async (b: HTMLButtonElement | undefined) => {
  await act(() => b!.click());
  await settle();
};
const section = (name: string) => root!.querySelector(`section[aria-label="${name}"]`)!;
/** The one Save of the form: the bar at the bottom of the card, there only while something changed
 * or a save is being reported. */
const bar = () => root!.querySelector(".savebar");
const save = () => (bar() ? button("Save", bar()!) : undefined);
const cancel = () => (bar() ? button("Cancel", bar()!) : undefined);
const barStatus = () => text(bar()?.querySelector(".status"));
const barProblem = () => text(bar()?.querySelector(".problem"));
const hex = (s: string) => stringToHex(s);
/** The one `update_profile` that went, checked to be the only call sent and signed. */
const sentUpdate = () => {
  expect(chain.sent.map((c) => c.method)).toEqual(["updateProfile"]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe(chain.sent[0]);
  return chain.sent[0]!.args[0] as Record<string, unknown>;
};
const KEEP = { bio: null, avatar: null, fields: [], links: null, secret: null };

/** Choose an image in the avatar editor and use it: it is staged for the next Save. */
async function chooseAvatar() {
  vi.mocked(encodeAvatar).mockResolvedValue({ bytes: LOSSY, quality: 0.9 });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  await click(button("Change avatar") ?? button("Add an avatar"));
  const input = root!.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [new File([new Uint8Array(4)], "me.png")], configurable: true });
  await act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect(root!.querySelector(".crop-result img")).not.toBeNull(), { timeout: 2000 });
  await click(button("Use this image"));
}

beforeEach(() => {
  for (const mock of [readProfile, identitySecret, send, signerFor]) mock.mockReset();
  chain.sent.length = 0;
  chain.broken.error = null;
  identitySecret.mockResolvedValue(null);
  signerFor.mockImplementation(async (address: string) => ({ address, signer: {} }));
  send.mockResolvedValue(OK);
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe("an account with no identity at all", () => {
  it("gets the whole form, empty, and nothing to save yet", async () => {
    await open(null);
    expect(root!.querySelector(".card")!.getAttribute("aria-label")).toBe("My identity");
    expect([...root!.querySelectorAll(".field .label")].map((l) => text(l))).toEqual([
      "Display name",
      "Legal name",
      "Website",
      "Email",
      "Matrix",
      "X",
      "Discord",
      "GitHub",
      "Telegram",
      "PGP",
    ]);
    expect([...root!.querySelectorAll<HTMLInputElement>(".field input")].every((i) => i.value === "")).toBe(true);
    expect(root!.querySelector(".quiet-link")).toBeNull(); // no public profile to view yet
    // nothing changed: no Save at all, in any section or at the bottom
    expect(bar()).toBeNull();
    expect(button("Save")).toBeUndefined();
    expect(text(root!.querySelector(".name"))).toBe(`${USER.slice(0, 8)}…${USER.slice(-8)}`);
    expect(button("Add an avatar")).toBeDefined();
    expect(button("Remove avatar")).toBeUndefined();
    expect(text(root!.querySelector(".hint"))).toBe("You have no identity yet. Fill in what you want to show, then save: the first save creates it.");
    // the fields carry no heading of their own: each one is named by its label
    expect(section("Details").querySelector(":scope > .label")).toBeNull();
  });

  it("creates the identity with one update_profile holding every field typed, one signature", async () => {
    await open(null);
    await type(byLabel("Display name"), "Ada Lovelace");
    await type(byLabel("Email"), " ada@example.org ");
    await type(byLabel("PGP"), "ab".repeat(20));
    expect(barStatus()).toBe("3 changes");
    await click(save());

    expect(sentUpdate()).toEqual({
      ...KEEP,
      fields: [
        [{ Typed: "DisplayName" }, { Public: hex("Ada Lovelace") }],
        [{ Typed: "Email" }, { Public: hex("ada@example.org") }],
        [{ Typed: "Pgp" }, { Public: `0x${"ab".repeat(20)}` }],
      ],
    });
    expect(signerFor).toHaveBeenCalledTimes(1);
    expect(signerFor).toHaveBeenCalledWith(USER);
    expect(send.mock.calls[0]![1]).toEqual({ address: USER, signer: {} });
  });

  it("says Saved only after the chain was read again, and shows what it holds", async () => {
    await open(null);
    await type(byLabel("Display name"), "Fixture User");
    readProfile.mockClear();
    readProfile.mockResolvedValue(existing());
    await click(save());
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(barStatus()).toBe("Saved");
    // nothing left to save: the bar only reports
    expect(save()).toBeUndefined();
    expect(text(root!.querySelector(".name"))).toBe("Fixture User");
    expect(root!.querySelector(".quiet-link")!.getAttribute("href")).toBe("/fixtureuser");
  });
});

describe("an account with an identity", () => {
  it("shows its fields, filled, with a private one kept out of reach", async () => {
    await open(existing());
    expect(byLabel("Email").value).toBe("user@example.org");
    expect(byLabel("Display name").value).toBe("Fixture User");
    expect(byLabel("PGP").value).toBe(Array(10).fill("ABAB").join(" "));
    expect(byLabel("Mastodon").value).toBe("@user@m.example");
    expect(text(root!.querySelector("#field-8"))).toBe("Private"); // Telegram
    expect(root!.querySelector("#field-8")!.tagName).toBe("P");
    expect(root!.innerHTML).not.toContain("0x2222");
    expect((root!.querySelector("#bio") as HTMLTextAreaElement).value).toBe("Fixture bio, on chain.");
    expect(root!.querySelector(".card img.avatar")).not.toBeNull();
    expect(bar()).toBeNull();
  });

  it("sends only what changed, and removes a field that was emptied", async () => {
    await open(existing());
    await type(byLabel("Website"), "https://user.example");
    await type(byLabel("Email"), "");
    expect(barStatus()).toBe("2 changes");
    await click(save());
    expect(sentUpdate()).toEqual({
      ...KEEP,
      fields: [
        [{ Typed: "Web" }, { Public: hex("https://user.example") }],
        [{ Typed: "Email" }, null],
      ],
    });
  });

  it("removes a field, a private one included, with its Remove button, and Undo takes it back", async () => {
    await open(existing());
    const telegram = root!.querySelectorAll(".field")[8]!;
    await click(button("Remove", telegram));
    expect(text(telegram.querySelector(".removed"))).toBe("Removed");
    expect(barStatus()).toBe("1 change");
    expect(button("Undo", telegram)).toBeDefined();
    await click(button("Undo", telegram));
    expect(text(telegram.querySelector(".private"))).toBe("Private");
    expect(bar()).toBeNull();

    await click(button("Remove", telegram));
    await click(button("Remove", root!.querySelectorAll(".field")[10]!));
    await click(save());
    expect(sentUpdate()).toEqual({
      ...KEEP,
      fields: [
        [{ Typed: "Telegram" }, null],
        [{ Custom: hex("mastodon") }, null],
      ],
    });
  });

  it("names the field in each of its buttons, for people who hear them one by one", async () => {
    await open(existing());
    const rows = [...root!.querySelectorAll(".field")];
    const labels = rows.map((row) => [labelText(row.querySelector(".label")), ...[...row.querySelectorAll(".row-actions button")].map((b) => b.getAttribute("aria-label"))]);
    expect(labels).toEqual([
      ["Display name", "Make Display name private", "Remove Display name"],
      ["Legal name"],
      ["Website"],
      ["Email", "Make Email private", "Remove Email"],
      ["Matrix"],
      ["X"],
      ["Discord"],
      ["GitHub"],
      ["Telegram", "Reveal Telegram", "Verification packet for Telegram", "Remove Telegram"],
      ["PGP", "Make PGP private", "Remove PGP"],
      ["Mastodon", "Make mastodon private", "Remove mastodon"],
    ]);
    await click(button("Remove", rows[8]!));
    expect([...root!.querySelectorAll(".field")[8]!.querySelectorAll(".row-actions button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Undo Telegram"]);
  });

  it("names every button that shows only an icon, for screen readers and for the pointer alike", async () => {
    await open(existing());
    // a removed field and a removed link show Undo, and a new secret its own Undo: all of them too
    await click(button("Remove", root!.querySelectorAll(".field")[0]!));
    await click(button("Remove", section("Links").querySelector(".item")!));
    const icons = [...root!.querySelectorAll("button")].filter((b) => text(b) === "");
    expect(icons.length).toBeGreaterThan(15);
    for (const b of icons) {
      const name = b.getAttribute("aria-label");
      expect(name, b.outerHTML).toMatch(/^[A-Z]\w* .+/);
      expect(b.getAttribute("title"), name!).toBe(name);
      expect(b.getAttribute("type"), name!).toMatch(/^(button|submit)$/);
      expect(b.querySelector("svg")!.getAttribute("aria-hidden"), name!).toBe("true");
    }
    expect(icons.map((b) => b.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["Copy address", "Undo Display name", "Add field", "Add link"]));
  });

  it("says Verified in the label of a verified field, until it is edited", async () => {
    await open(existing());
    const email = () => root!.querySelectorAll(".field")[3]!;
    expect(text(email().querySelector(".label .state"))).toBe("Verified");
    expect(root!.querySelectorAll(".field .label .state")).toHaveLength(1);
    await type(byLabel("Email"), "other@example.org");
    expect(email().querySelector(".label .state")).toBeNull();
  });

  it("stores a website typed without its scheme with https://", async () => {
    await open(existing());
    await type(byLabel("Website"), "user.example");
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, fields: [[{ Typed: "Web" }, { Public: hex("https://user.example") }]] });
  });

  it("offers Cancel once something changed, which puts back what the chain holds", async () => {
    await open(existing());
    expect(cancel()).toBeUndefined();
    await type(byLabel("Website"), "https://user.example");
    await type(root!.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "pronouns");
    await click(cancel());
    expect(byLabel("Website").value).toBe("");
    expect(root!.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!.value).toBe("");
    expect(bar()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("gives an input room for the buttons inside it: one or two", async () => {
    await open(existing());
    const rows = [...root!.querySelectorAll(".field")];
    const room = (r: Element) => {
      const control = r.querySelector(".control")!.classList;
      return control.contains("has-actions") ? 2 : control.contains("has-action") ? 1 : 0;
    };
    // Telegram is private: no input, its buttons sit beside the word Private
    expect(rows.map(room)).toEqual([2, 0, 0, 2, 0, 0, 0, 0, 1, 2, 2]);
    // an empty row gets its Make private switch, and the room for it, once something is typed
    await type(byLabel("Website"), "https://user.example");
    expect(room(root!.querySelectorAll(".field")[2]!)).toBe(1);
    expect(button("Make Website private", root!.querySelectorAll(".field")[2]!)).toBeDefined();
  });

  it("warns, before it is saved, that changing a verified field ends its verification", async () => {
    await open(existing());
    const email = root!.querySelectorAll(".field")[3]!;
    expect(email.querySelector(".hint")).toBeNull();
    await type(byLabel("Email"), "other@example.org");
    expect(text(email.querySelector(".hint"))).toBe("This field is verified. Changing it removes the verification.");
    await type(byLabel("Email"), "user@example.org");
    expect(email.querySelector(".hint")).toBeNull();
    // a field that was never verified says nothing
    await type(byLabel("Website"), "https://user.example");
    expect(root!.querySelectorAll(".field")[2]!.querySelector(".hint")).toBeNull();
  });

  it("adds a custom field to the same save", async () => {
    await open(existing());
    const add = root!.querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "pronouns");
    await type(add.querySelector<HTMLInputElement>("[aria-label='Value of a new field']")!, "she/her");
    await click(button("Add field", add));
    expect(byLabel("Pronouns").value).toBe("she/her");
    expect(send).not.toHaveBeenCalled();
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(sentUpdate()).toEqual({
      ...KEEP,
      fields: [
        [{ Typed: "Web" }, { Public: hex("https://user.example") }],
        [{ Custom: hex("pronouns") }, { Public: hex("she/her") }],
      ],
    });
  });

  it("adds a custom field with Enter: the add row is a form", async () => {
    await open(existing());
    const add = root!.querySelector<HTMLFormElement>("form.add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "pronouns");
    await type(add.querySelector<HTMLInputElement>("[aria-label='Value of a new field']")!, "she/her");
    await act(() => void add.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(byLabel("Pronouns").value).toBe("she/her");
    expect(send).not.toHaveBeenCalled();
  });

  it("takes a filled add row into Save, rather than leave it behind", async () => {
    await open(existing());
    const add = root!.querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "pronouns");
    await type(add.querySelector<HTMLInputElement>("[aria-label='Value of a new field']")!, "she/her");
    expect(save()!.disabled).toBe(false);
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, fields: [[{ Custom: hex("pronouns") }, { Public: hex("she/her") }]] });
  });

  it("refuses Save with the add row's problem when that row is wrong, and sends nothing", async () => {
    await open(existing());
    const add = root!.querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "pronouns");
    await click(save());
    expect(barProblem()).toBe("Give the field a value.");
    expect(signerFor).not.toHaveBeenCalled();
    expect(chain.sent).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a custom field named like a built-in one", async () => {
    await open(existing());
    const add = root!.querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "email");
    await type(add.querySelector<HTMLInputElement>("[aria-label='Value of a new field']")!, "me@example.org");
    await click(button("Add field", add));
    expect(text(add.querySelector(".problem"))).toBe("That name belongs to a built-in field. Use the built-in field, or another name.");
    expect(root!.querySelectorAll(".field")).toHaveLength(11);
  });

  it("refuses a custom field that is wrong, with a sentence, and adds nothing", async () => {
    await open(existing());
    const add = root!.querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='Name of a new field']")!, "mastodon");
    await type(add.querySelector<HTMLInputElement>("[aria-label='Value of a new field']")!, "x");
    await click(button("Add field", add));
    expect(text(add.querySelector(".problem"))).toBe("You already have a field with that name.");
    expect(root!.querySelectorAll(".field")).toHaveLength(11);
  });

  it("shows a problem next to the field and in the Save bar, and does not let a wrong form be saved", async () => {
    await open(existing());
    await type(byLabel("PGP"), "not hex");
    const row = root!.querySelectorAll(".field")[9]!;
    expect(text(row.querySelector(".problem"))).toBe("A PGP fingerprint has 40 or 64 hexadecimal characters.");
    expect(row.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
    // a problem anywhere blocks the whole save, the parts that are right included
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "A fine bio");
    expect(barProblem()).toBe("PGP: A PGP fingerprint has 40 or 64 hexadecimal characters.");
    expect(save()!.disabled).toBe(true);
    await type(byLabel("Website"), `https://a.b/${"x".repeat(245)}`);
    expect(text(root!.querySelectorAll(".field")[2]!.querySelector(".problem"))).toBe("Too long, 257 of 256 bytes.");
    await type(byLabel("Website"), "not a website");
    expect(text(root!.querySelectorAll(".field")[2]!.querySelector(".problem"))).toBe("That is not a web address.");
    await type(byLabel("Email"), "user at example");
    expect(text(root!.querySelectorAll(".field")[3]!.querySelector(".problem"))).toBe("That is not an email address.");
    expect(chain.sent).toEqual([]);
  });
});

describe("one Save for everything", () => {
  const items = () => [...root!.querySelectorAll(".items .item")];

  it("sends the bio, the avatar, the fields and the links in one update_profile, with one signature", async () => {
    await open(existing());
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "  A new bio ");
    await chooseAvatar();
    await type(byLabel("Website"), "user.example");
    await type(byLabel("Email"), "");
    // Code goes first, Website is retitled, and a new link goes at the end
    await click(items()[1]!.querySelector<HTMLButtonElement>("[aria-label='Move Code up']")!);
    await click(button("Edit", items()[1]));
    await type(items()[1]!.querySelector<HTMLInputElement>("[aria-label='Link title']")!, "Site");
    await click(button("Done", items()[1]));
    const add = section("Links").querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!, "Blog");
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link address']")!, "blog.example");
    await click(button("Add link", add));
    expect(send).not.toHaveBeenCalled();
    // bio, avatar, two fields, the links
    expect(barStatus()).toBe("5 changes");

    await click(save());
    expect(signerFor).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).toEqual({
      bio: hex("A new bio"),
      avatar: avatarChange(LOSSY),
      fields: [
        [{ Typed: "Web" }, { Public: hex("https://user.example") }],
        [{ Typed: "Email" }, null],
      ],
      links: [
        { Keep: 1 },
        { Update: { id: 0, title: hex("Site"), url: hex("https://user.example") } },
        { Add: { title: hex("Blog"), url: hex("https://blog.example") } },
      ],
      secret: null,
    });
  });

  it("puts everything back with Cancel, and sends nothing", async () => {
    await open(existing());
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "Something else");
    await click(button("Remove avatar"));
    await type(byLabel("Website"), "https://user.example");
    await click(button("Remove", items()[0]));
    await click(items()[1]!.querySelector<HTMLButtonElement>("[aria-label='Move Code up']")!);
    const add = section("Links").querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!, "Blog");
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link address']")!, "blog.example");
    await click(button("Add link", add));
    expect(barStatus()).toBe("4 changes");

    await click(cancel());
    expect((root!.querySelector("#bio") as HTMLTextAreaElement).value).toBe("Fixture bio, on chain.");
    expect(root!.querySelector(".head img.avatar")).not.toBeNull();
    expect(button("Change avatar")).toBeDefined();
    expect(button("Undo", section("Avatar"))).toBeUndefined();
    expect(byLabel("Website").value).toBe("");
    expect(items().map((i) => text(i.querySelector(".link-title")))).toEqual(["Website", "Code"]);
    expect(items().map((i) => text(i.querySelector(".link-url")))).toEqual(["user.example", "git.example/user"]);
    expect(bar()).toBeNull();
    expect(signerFor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("counts the changes in the Save bar, one for the links however many of them changed", async () => {
    await open(existing());
    await type(byLabel("Website"), "https://user.example");
    expect(barStatus()).toBe("1 change");
    await click(button("Remove", items()[0]));
    await click(button("Remove", items()[1]));
    expect(barStatus()).toBe("2 changes");
    await type(byLabel("Website"), "");
    expect(barStatus()).toBe("1 change");
  });

  it("waits with Reveal and Packet until the changes are saved or cancelled", async () => {
    await open(existing());
    const reveal = () => button("Reveal", root!.querySelectorAll(".field")[8]!)!;
    const packet = () => button("Packet", root!.querySelectorAll(".field")[8]!)!;
    expect(reveal().disabled).toBe(false);
    expect(packet().disabled).toBe(false);
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "A new bio");
    expect(reveal().disabled).toBe(true);
    expect(packet().disabled).toBe(true);
    expect(text(section("Details"))).toContain("Reveal and Packet wait until your changes are saved or cancelled.");
    await click(cancel());
    expect(reveal().disabled).toBe(false);
    expect(text(section("Details"))).not.toContain("Reveal and Packet wait");
  });
});

describe("the bio", () => {
  it("counts bytes, not characters, and refuses more than 560", async () => {
    await open(existing());
    const bio = root!.querySelector("#bio") as HTMLTextAreaElement;
    const count = () => text(section("Bio").querySelector(".count"));
    expect(count()).toBe("22 / 560 bytes");
    await type(bio, "é".repeat(280));
    expect(count()).toBe("560 / 560 bytes");
    expect(save()!.disabled).toBe(false);
    await type(bio, "é".repeat(281));
    expect(count()).toBe("562 / 560 bytes");
    expect(text(section("Bio").querySelector(".meta .problem"))).toBe("Too long, 562 of 560 bytes.");
    expect(save()!.disabled).toBe(true);
  });

  it("offers Cancel once changed, which puts back the bio on chain", async () => {
    await open(existing());
    const bio = root!.querySelector("#bio") as HTMLTextAreaElement;
    expect(cancel()).toBeUndefined();
    await type(bio, "Something else");
    await click(cancel());
    expect((root!.querySelector("#bio") as HTMLTextAreaElement).value).toBe("Fixture bio, on chain.");
    expect(cancel()).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("can be emptied, and only saves when it changed", async () => {
    await open(existing());
    // spaces around the same text are no change
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, " Fixture bio, on chain. ");
    expect(bar()).toBeNull();
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "");
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, bio: "0x" });
  });
});

describe("the links", () => {
  const items = () => [...root!.querySelectorAll(".items .item")];
  const titles = () => items().map((i) => text(i.querySelector(".link-title")));

  it("lists them in the chain's order", async () => {
    await open(existing());
    expect(titles()).toEqual(["Website", "Code"]);
    expect(items().map((i) => text(i.querySelector(".link-url")))).toEqual(["user.example", "git.example/user"]);
  });

  it("adds one to the list, sent with Save after the others, with https:// added and not shown as an error", async () => {
    await open(existing());
    const add = section("Links").querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!, "Blog");
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link address']")!, "blog.example");
    await click(button("Add link", add));
    expect(titles()).toEqual(["Website", "Code", "Blog"]);
    expect(add.querySelector(".problem")).toBeNull();
    // the add row is empty again, and nothing went
    expect(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!.value).toBe("");
    expect(send).not.toHaveBeenCalled();
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, links: [{ Keep: 0 }, { Keep: 1 }, { Add: { title: hex("Blog"), url: hex("https://blog.example") } }] });
  });

  it("drops a new link with Remove, rather than mark it removed", async () => {
    await open(existing());
    const add = section("Links").querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!, "Blog");
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link address']")!, "blog.example");
    await click(button("Add link", add));
    await click(button("Remove", items()[2]));
    expect(titles()).toEqual(["Website", "Code"]);
    expect(bar()).toBeNull();
  });

  it.each([
    ["Blog", "javascript:alert(1)", "Links start with http:// or https://."],
    ["", "https://blog.example", "Give the link a title."],
    ["Blog", "", "Give the link an address."],
  ])("refuses %j with %j before anything is signed", async (title, url, problem) => {
    await open(existing());
    const add = section("Links").querySelector(".add")!;
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link title']")!, title);
    await type(add.querySelector<HTMLInputElement>("[aria-label='New link address']")!, url);
    await click(button("Add link", add));
    expect(text(add.querySelector(".problem"))).toBe(problem);
    expect(titles()).toEqual(["Website", "Code"]);
    expect(signerFor).not.toHaveBeenCalled();
    expect(chain.sent).toEqual([]);
  });

  it("edits one in place, sent with Save as an Update", async () => {
    await open(existing());
    await click(button("Edit", items()[1]));
    const edit = items()[1]!;
    await type(edit.querySelector<HTMLInputElement>("[aria-label='Link title']")!, "Source");
    await click(button("Done", edit));
    expect(items()[1]!.querySelector("input")).toBeNull();
    expect(titles()).toEqual(["Website", "Source"]);
    expect(send).not.toHaveBeenCalled();
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, links: [{ Keep: 0 }, { Update: { id: 1, title: hex("Source"), url: hex("https://git.example/user") } }] });
  });

  it("does not let a link that is wrong be saved", async () => {
    await open(existing());
    await click(button("Edit", items()[1]));
    await type(items()[1]!.querySelector<HTMLInputElement>("[aria-label='Link address']")!, "javascript:alert(1)");
    expect(text(items()[1]!.querySelector(".problem"))).toBe("Links start with http:// or https://.");
    await click(button("Done", items()[1]));
    // still said once the inputs are closed
    expect(text(items()[1]!.querySelector(".problem"))).toBe("Links start with http:// or https://.");
    expect(barProblem()).toBe("Links start with http:// or https://.");
    expect(save()!.disabled).toBe(true);
  });

  it("warns that editing a verified link ends its verification", async () => {
    const profile = existing();
    await open({ ...profile, links: profile.links.map((l, i) => ({ ...l, verified: i === 0 })) });
    await click(button("Edit", items()[0]));
    expect(items()[0]!.querySelector(".hint")).toBeNull();
    await type(items()[0]!.querySelector<HTMLInputElement>("[aria-label='Link title']")!, "Site");
    expect(text(items()[0]!.querySelector(".hint"))).toBe("This link is verified. Changing it removes the verification.");
    await click(button("Done", items()[0]));
    await click(button("Edit", items()[1]));
    await type(items()[1]!.querySelector<HTMLInputElement>("[aria-label='Link title']")!, "Source");
    expect(items()[1]!.querySelector(".hint")).toBeNull();
  });

  it("counts a link as changed only once it differs from what is stored", async () => {
    await open(existing());
    await click(button("Edit", items()[1]));
    const title = () => items()[1]!.querySelector<HTMLInputElement>("[aria-label='Link title']")!;
    const address = () => items()[1]!.querySelector<HTMLInputElement>("[aria-label='Link address']")!;
    expect(bar()).toBeNull();
    await type(title(), "Source");
    expect(barStatus()).toBe("1 change");
    await type(title(), "Code");
    expect(bar()).toBeNull();
    // the same address without its scheme is the same address
    await type(address(), "git.example/user");
    expect(bar()).toBeNull();
    await type(address(), "git.example/other");
    expect(barStatus()).toBe("1 change");
  });

  it("marks one removed, with Undo, and leaves it out of the list sent", async () => {
    await open(existing());
    await click(button("Remove", items()[0]));
    expect(text(items()[0]!.querySelector(".link-url"))).toBe("Removed");
    expect(items()[0]!.querySelector(".link-title.gone")).not.toBeNull();
    expect(button("Edit", items()[0])).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await click(button("Undo", items()[0]));
    expect(text(items()[0]!.querySelector(".link-url"))).toBe("user.example");
    expect(bar()).toBeNull();

    await click(button("Remove", items()[0]));
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, links: [{ Keep: 1 }] });
  });

  it("reorders locally, saves the new order in the same call, and can give up", async () => {
    await open(existing());
    expect(items()[0]!.querySelector<HTMLButtonElement>("[aria-label='Move Website up']")!.disabled).toBe(true);
    await click(items()[0]!.querySelector<HTMLButtonElement>("[aria-label='Move Website down']")!);
    expect(titles()).toEqual(["Code", "Website"]);
    expect(send).not.toHaveBeenCalled();

    await click(cancel());
    expect(titles()).toEqual(["Website", "Code"]);
    expect(bar()).toBeNull();

    await click(items()[0]!.querySelector<HTMLButtonElement>("[aria-label='Move Website down']")!);
    readProfile.mockResolvedValue({ ...existing(), links: [...existing().links].reverse() });
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, links: [{ Keep: 1 }, { Keep: 0 }] });
    expect(titles()).toEqual(["Code", "Website"]);
    expect(barStatus()).toBe("Saved");
    expect(save()).toBeUndefined();
  });

  it("steps over a removed link when moving one", async () => {
    const profile = existing();
    await open({ ...profile, links: [...profile.links, { ...profile.links[0]!, id: 2, title: "Blog" }] });
    await click(button("Remove", items()[1]));
    await click(items()[2]!.querySelector<HTMLButtonElement>("[aria-label='Move Blog up']")!);
    expect(titles()).toEqual(["Blog", "Code", "Website"]);
    await click(save());
    expect(sentUpdate().links).toEqual([{ Keep: 2 }, { Keep: 0 }]);
  });

  it("stops offering to add at 16 links", async () => {
    const profile = existing();
    const links = Array.from({ length: 16 }, (_, id) => ({ ...profile.links[0]!, id, title: `Link ${id}` }));
    await open({ ...profile, links });
    expect(section("Links").querySelector(".add")).toBeNull();
    expect(text(section("Links").querySelector(".hint"))).toBe("You have reached the limit of links.");
  });
});

describe("the avatar", () => {
  it("is chosen in the editor, shown, and sent with the next Save", async () => {
    await open(existing());
    await chooseAvatar();
    // the editor closes, nothing went: the image waits for Save
    expect(root!.querySelector(".avatar-editor")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(barStatus()).toBe("1 change");
    expect(button("Undo", section("Avatar"))).toBeDefined();
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, avatar: avatarChange(LOSSY) });
  });

  it("is removed with the next Save, and Undo takes it back", async () => {
    await open(existing());
    await click(button("Remove avatar"));
    expect(send).not.toHaveBeenCalled();
    // the generated avatar shows instead, as it will once saved
    expect(root!.querySelector(".head img.avatar")).toBeNull();
    expect(root!.querySelector(".head canvas.avatar")).not.toBeNull();
    expect(button("Add an avatar")).toBeDefined();
    expect(barStatus()).toBe("1 change");
    await click(button("Undo", section("Avatar")));
    expect(root!.querySelector(".head img.avatar")).not.toBeNull();
    expect(bar()).toBeNull();

    await click(button("Remove avatar"));
    await click(save());
    expect(sentUpdate()).toEqual({ ...KEEP, avatar: avatarChange(null) });
  });

  it("chosen and then removed on an identity without one, is no change", async () => {
    await open({ ...existing(), avatar: null });
    await chooseAvatar();
    expect(barStatus()).toBe("1 change");
    await click(button("Remove avatar"));
    expect(bar()).toBeNull();
    expect(button("Add an avatar")).toBeDefined();
  });

  it("can be given up before it is used", async () => {
    await open(existing());
    await click(button("Change avatar"));
    await click(button("Cancel", section("Avatar")));
    expect(root!.querySelector(".avatar-editor")).toBeNull();
    expect(bar()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("shows Saving, locks the whole form, and sends nothing else until the answer", async () => {
    await open(existing());
    let answer: (r: SendResult) => void = () => undefined;
    send.mockReturnValue(new Promise<SendResult>((resolve) => (answer = resolve)));
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(barStatus()).toBe("Saving. Confirm in your wallet if it asks.");
    expect(root!.querySelector("fieldset")!.disabled).toBe(true);
    expect(save()!.disabled).toBe(true);
    expect(root!.querySelector(".card")!.getAttribute("aria-busy")).toBe("true");

    await act(async () => answer(OK));
    await settle();
    expect(root!.querySelector("fieldset")!.disabled).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says that the daily limit is reached, in a sentence, and never Saved", async () => {
    await open(existing());
    send.mockResolvedValue({ ok: false, events: [], errorName: "DailyLimit", error: "Daily limit reached. Try again tomorrow." });
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(barProblem()).toBe("Daily limit reached. Try again tomorrow.");
    expect(root!.textContent).not.toContain("Saved");
    // what was typed is still there, and can be sent again
    expect(byLabel("Website").value).toBe("https://user.example");
    expect(save()!.disabled).toBe(false);
  });

  it("says why a pallet error refused the save", async () => {
    await open(existing());
    send.mockResolvedValue({ ok: false, events: [], errorName: "InvalidAvatar", error: "The avatar must be a 64 by 64 WebP image of at most 8 KB." });
    await click(button("Remove avatar"));
    await click(save());
    expect(barProblem()).toBe("The avatar must be a 64 by 64 WebP image of at most 8 KB.");
    // the removal is still staged
    expect(button("Undo", section("Avatar"))).toBeDefined();
  });

  it("says when the wallet cannot be reached, and sends nothing", async () => {
    await open(existing());
    signerFor.mockRejectedValue(new Error("That account is not in the wallet."));
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(barProblem()).toBe("The wallet could not be reached. Try again.");
    expect(send).not.toHaveBeenCalled();
  });

  it("shows the app's own sentence when a call cannot be built, and a plain one for anything else", async () => {
    await open(existing());
    const bio = () => root!.querySelector("#bio") as HTMLTextAreaElement;
    chain.broken.error = new Refusal("Too many changes at once. Save fewer fields.");
    await type(bio(), "New");
    await click(save());
    expect(barProblem()).toBe("Too many changes at once. Save fewer fields.");
    // raw text of a library or of the network never reaches the person
    chain.broken.error = new Error("createType(Call):: Struct: failed on args: Bytes");
    await type(bio(), "Newer");
    await click(save());
    expect(barProblem()).toBe("The call could not be prepared. Try again.");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the editor and its drafts when the identity cannot be read again after a save, and says so", async () => {
    await open(existing());
    readProfile.mockRejectedValue(new Error("Cannot reach the network"));
    await type(byLabel("Website"), "https://user.example");
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "Edited bio");
    await click(save());
    expect(send).toHaveBeenCalledTimes(1);
    expect(root!.querySelector(".card")!.getAttribute("aria-label")).toBe("My identity");
    expect(barStatus()).toBe("Saved, but the identity could not be read again.");
    expect(root!.querySelector(".note")).toBeNull();
    // everything typed is still there
    expect(byLabel("Website").value).toBe("https://user.example");
    expect((root!.querySelector("#bio") as HTMLTextAreaElement).value).toBe("Edited bio");
  });

  it("reads again before sending anything more on top of a state it could not refresh", async () => {
    await open(existing());
    readProfile.mockRejectedValue(new Error("Cannot reach the network"));
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(send).toHaveBeenCalledTimes(1);

    // still cannot read: a second save is refused rather than sent blind
    await type(root!.querySelector("#bio") as HTMLTextAreaElement, "Edited bio");
    await click(save());
    expect(barProblem()).toBe("The identity could not be read. Try again in a moment.");
    expect(send).toHaveBeenCalledTimes(1);

    // once it can be read, the save goes through
    readProfile.mockResolvedValue({ ...existing(), bio: "Edited bio" });
    await click(save());
    expect(send).toHaveBeenCalledTimes(2);
    expect((chain.sent[1]!.args[0] as { bio: string }).bio).toBe(hex("Edited bio"));
    expect(barStatus()).toBe("Saved");
  });

  it("clears an old result as soon as the person types again", async () => {
    await open(existing());
    await type(byLabel("Website"), "https://user.example");
    await click(save());
    expect(barStatus()).toBe("Saved");
    await type(byLabel("Website"), "https://other.example");
    expect(barStatus()).toBe("1 change");
  });
});

describe("reading the identity", () => {
  it("shows a quiet card while it is read, then the form", async () => {
    let answer: (p: Profile | null) => void = () => undefined;
    readProfile.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(<MyIdentity address={USER} wallet={wallet} />, root!));
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("Loading");
    await act(async () => answer(null));
    await settle();
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("My identity");
  });

  it("offers to try again when the network cannot be reached", async () => {
    readProfile.mockRejectedValueOnce(new Error("Cannot reach the network"));
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(<MyIdentity address={USER} wallet={wallet} />, root!));
    await settle();
    expect(text(root.querySelector(".note"))).toBe("Cannot reach the identit.ee network.");
    readProfile.mockResolvedValue(null);
    await click(button("Try again"));
    expect(root.querySelector(".card")!.getAttribute("aria-label")).toBe("My identity");
  });
});

describe("house style", () => {
  it("shows no fee, price or balance, and none of the forbidden marks or fonts", async () => {
    await open(existing());
    await type(byLabel("Website"), "x".repeat(300));
    const html = root!.innerHTML;
    expect(root!.textContent).not.toMatch(/[·—]/);
    expect(root!.textContent).not.toMatch(/\bfees?\b|\bIDT\b|\bcosts?\b|\bbalance\b|\bgas\b/i);
    expect(html).not.toMatch(/monospace|font-family/i);
  });

  it("never reads a balance, a fee or the account's funds", () => {
    for (const file of ["pages/me-editor.tsx", "pages/me-sections.tsx", "pages/me-form.ts", "ui/avatar-editor.tsx", "chain/calls.ts", "chain/edit.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
      expect(source, file).not.toMatch(/paymentInfo|queryInfo|partialFee|system\.account|freeBalance|getBalance/);
    }
  });
});
