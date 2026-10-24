import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { profilePath, RESERVED_PATHS } from "../src/routes.ts";

const ADDRESS = "idqY6TowxB9qMJatSWik52Hi8kLzegx7sK5EVAftPkmFLzJMf";

describe("profilePath", () => {
  it("sends an account with a username to its name, and one without to its address", () => {
    expect(profilePath("alice", ADDRESS)).toBe("/alice");
    expect(profilePath(null, ADDRESS)).toBe(`/a/${ADDRESS}`);
    expect(profilePath("", ADDRESS)).toBe(`/a/${ADDRESS}`);
  });

  it.each(RESERVED_PATHS)("never sends %s to /%s, which is a page of the app", (name) => {
    expect(profilePath(name, ADDRESS)).toBe(`/a/${ADDRESS}`);
  });

  it("escapes a name so it stays one path segment", () => {
    expect(profilePath("a/b", ADDRESS)).toBe("/a%2Fb");
  });
});

describe("RESERVED_PATHS", () => {
  it("lists every fixed path of the router, so that no username shadows a page", () => {
    const app = readFileSync(join(import.meta.dirname, "../src/app.tsx"), "utf8");
    const fixed = [...app.matchAll(/<Route path="\/([a-z]+)[/"]/g)].map((m) => m[1]!).filter((p) => p !== "");
    expect(fixed.length).toBeGreaterThanOrEqual(4);
    expect(fixed.filter((p) => !RESERVED_PATHS.includes(p))).toEqual([]);
  });
});
