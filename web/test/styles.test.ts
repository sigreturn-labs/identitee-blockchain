import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The stylesheet is not applied in the DOM tests (no browser), so what it must guarantee is read
// from the file itself: each check below fails if its rule is removed or changed back.
const css = readFileSync(join(import.meta.dirname, "../src/ui/ui.css"), "utf8");

/** The text between the braces that follow `header`, nested blocks included. */
function block(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`no ${header} in the stylesheet`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
  }
  throw new Error(`unbalanced braces after ${header}`);
}

/** The declarations of a rule at the top level of `source`. */
const declarations = (source: string, selector: string): string => {
  const found = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "m").exec(source);
  if (!found) throw new Error(`no rule for ${selector}`);
  return found[1]!;
};

describe("the account menu", () => {
  it("is opaque, so that the card behind it does not show through its words", () => {
    const background = /background:\s*([^;]+);/.exec(declarations(css, ".menu"))![1]!.trim();
    const alpha = /^rgba?\([^)]*,\s*([\d.]+)\)$/.exec(background)?.[1];
    expect(alpha === undefined ? 1 : Number(alpha)).toBeGreaterThanOrEqual(0.98);
    expect(background).not.toBe("transparent");
  });
});

describe("a private value", () => {
  it("is set apart by a quieter ink, not by italic (one face of Inter throughout)", () => {
    const rule = declarations(css, ".private");
    expect(rule).toMatch(/color:\s*var\(--ink-2\)/);
    expect(rule).not.toMatch(/italic/);
  });
});

describe("grids", () => {
  it("never use a bare 1fr: a long unbreakable word would widen the column (minmax(0, 1fr) does not)", () => {
    const values = [...css.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(8);
    for (const value of values) expect(value.replace(/minmax\([^)]*\)/g, ""), value).not.toMatch(/\bfr\b/);
  });

  it("keeps the two-column field list on minmax(0, 1fr) once it is a single column", () => {
    const small = block(css, "@media (max-width: 760px)");
    expect(declarations(small, ".fields.two")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe("the editor's field rows", () => {
  const tracks = (value: string): string[] => value.replace(/minmax\([^)]*\)/g, "M").trim().split(/\s+/);

  it("have the same two tracks on every row, none sized by its content, so that no input is wider than another", () => {
    const value = /grid-template-columns:\s*([^;]+);/.exec(declarations(css, ".field"))![1]!;
    expect(tracks(value)).toHaveLength(2);
    expect(value).not.toMatch(/\b(auto|max-content|min-content|fit-content)\b/);
  });

  it("carry their buttons inside the input's cell, with room for them in the input, not in a third column", () => {
    const actions = declarations(css, ".field > .row-actions");
    expect(actions).toMatch(/grid-column:\s*2;/);
    expect(actions).toMatch(/grid-row:\s*1;/);
    expect(actions).toMatch(/justify-self:\s*end/);
    const room = (selector: string) => Number(/padding-right:\s*(\d+)px/.exec(declarations(css, selector))![1]);
    // one icon button (40 px), then two side by side (Make private and Remove)
    expect(room(".field > .has-action > .input")).toBeGreaterThanOrEqual(42);
    expect(room(".field > .has-actions > .input")).toBeGreaterThanOrEqual(82);
  });

  it("give the input its whole width back under 600 px, where the button moves up beside the label", () => {
    const small = block(css, "@media (max-width: 600px)");
    expect(Number(/padding-right:\s*(\d+)px/.exec(declarations(small, ".field > .has-action > .input, .field > .has-actions > .input"))![1])).toBeLessThanOrEqual(16);
    expect(declarations(small, ".field > .row-actions")).toMatch(/grid-row:\s*1;/);
    expect(declarations(small, ".field > .control")).toMatch(/grid-row:\s*2;/);
  });
});

describe("the state dot", () => {
  it("draws a mark's own icon, not the dot of a plain state", () => {
    expect(declarations(css, ".state.standing::before")).toMatch(/content:\s*none/);
  });

  it("keeps only the icon of a field's or a link's mark under 480 px, the word left for screen readers", () => {
    const small = block(css, "@media (max-width: 480px)");
    const word = declarations(small, ".row .mark-word,\n  .link .mark-word");
    expect(word).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(word).not.toMatch(/display:\s*none/);
  });
});

describe("house style", () => {
  it("styles the wordmark in one rule only: a class shared with another piece would reshape it", () => {
    expect(css.match(/(^|[\s,}])\.mark\s*\{/gm)).toHaveLength(1);
  });

  it("uses Inter through the font token only, no monospace and no other family", () => {
    expect(css).not.toMatch(/monospace|font-family/i);
  });
});

describe("the authority page", () => {
  it("puts the reason and the note on one column on a phone, and on two tracks that content cannot widen otherwise", () => {
    expect(declarations(css, ".reason-row")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.4fr\)/);
    const phone = block(css, "@media (max-width: 600px)");
    expect(/\.add,\s*\.add\.propose,\s*\.reason-row\s*\{([^}]*)\}/.exec(phone)![1]).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe("the requests page", () => {
  it("keeps the proposal form on one column on a phone: `.add.propose` is more specific than `.add`", () => {
    const phone = block(css, "@media (max-width: 600px)");
    expect(phone).toMatch(/\.add\.propose/);
    const value = /\.add,\s*\.add\.propose(?:,\s*[.\w-]+)*\s*\{([^}]*)\}/.exec(phone)![1]!;
    expect(value).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("sets its rows on two tracks that cannot be widened by their content", () => {
    expect(declarations(css, ".ask")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(declarations(css, ".claim")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  });

  it("stacks the state and Cancel under the text of a row on a small phone, so that an email does not break in a word", () => {
    const small = block(css, "@media (max-width: 480px)");
    expect(declarations(small, ".ask:has(.state, .standing)")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe("icon buttons", () => {
  it("are a square finger-sized target, 40 px and 44 px on a phone, grey until pointed at", () => {
    const rule = declarations(css, ".icon-button");
    expect(rule).toMatch(/width:\s*40px/);
    expect(rule).toMatch(/height:\s*40px/);
    expect(rule).toMatch(/color:\s*var\(--ink-2\)/);
    expect(declarations(css, ".icon-button:hover:not(:disabled),\n.icon-button:focus-visible")).toMatch(/color:\s*var\(--ink\)/);
    const phone = declarations(block(css, "@media (max-width: 600px)"), ".icon-button");
    expect(phone).toMatch(/width:\s*44px/);
    expect(phone).toMatch(/height:\s*44px/);
  });
});
