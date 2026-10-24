import { stringToU8a, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import {
  encodeLink,
  linkCommitment,
  privateCommitment,
  publicCommitment,
} from "../src/chain/formulas.ts";

// Every expected value below was printed by the runtime code, not computed here:
//
//   cargo test -p pallet-identitee print_vectors -- --nocapture
//
// (pallets/identitee/src/tests/vectors.rs, which also freezes them on the Rust side). The first
// public vector and the first private one are the worked examples of docs/TESTING.md.

const counting = Uint8Array.from({ length: 32 }, (_, i) => i);
const elevens = new Uint8Array(32).fill(0x11);

const PUBLIC_VECTORS: [string, string][] = [
  ["alice@example.org", "0x887551424c678798e870359494a90539aaa32b2cdc7534dd08c291224af4f1f0"],
  ["https://identit.ee/alice", "0x92b4c07f22ef3a5bfd8b874906dff9ff726337813d0491c46dc9c6ff966514bd"],
  ["Zoë Müller 日本", "0x87fe6fbdde80876b6e2cf067912f030d098a96a4ec54f43ac9ad2ed0cdf3f9ed"],
];

const PRIVATE_VECTORS: [Uint8Array, string, string][] = [
  [elevens, "@alice", "0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0"],
  [counting, "+33 6 12 34 56 78 é", "0x2eb8078820d1e64b133d47b5050457a6a87594a8ce058baa7119cc3c036d7590"],
];

const LINK_VECTORS: [string, string, string, string][] = [
  [
    "Website",
    "https://identit.ee",
    "0x1c576562736974654868747470733a2f2f6964656e7469742e6565",
    "0xdeb54bef5cbf0d79f25252ab40c026a0879ab56f956d3426f7d9d3026d8eb9e0",
  ],
  [
    "Café ☕",
    "https://example.org/ça?x=1&y=2",
    "0x24436166c3a920e298957c68747470733a2f2f6578616d706c652e6f72672fc3a7613f783d3126793d32",
    "0x6e912be3183cf1da26042f1dce060dffd462fcd90622438001eca37588fd0487",
  ],
];

// Links whose title or URL needs the two-byte compact length (64 bytes or more). The Rust side
// builds the same strings from the same pieces (`long_links` in vectors.rs):
//   boundary  title of 64 bytes (the longest allowed) and URL of 64 bytes
//   longest   title of 63 bytes (the longest in one-byte mode) and URL of 256 bytes (the longest allowed)
const LONG_LINK_VECTORS: [string, string, string, number, string, string][] = [
  [
    "boundary",
    "ab".repeat(32),
    `https://example.org/${"p".repeat(44)}`,
    132,
    "0x0101",
    "0xefea5d1599498d4c064fb0dcfff793ead2d1486ba74bf34c980960ac365a5c10",
  ],
  [
    "longest",
    "日".repeat(21),
    `https://example.org/?q=${"z".repeat(233)}`,
    322,
    "0xfce6",
    "0xcb9111f58296e8d3ccf1fa7cdd3a6560f98d72a796bd85084445cd956239f703",
  ],
];

describe("publicCommitment", () => {
  it.each(PUBLIC_VECTORS)("matches the runtime for %j", (value, expected) => {
    expect(publicCommitment(value)).toBe(expected);
  });

  it("hashes bytes and their text the same way", () => {
    expect(publicCommitment(stringToU8a("alice@example.org"))).toBe(PUBLIC_VECTORS[0]![1]);
  });

  it("differs for values that differ by one byte", () => {
    expect(publicCommitment("alice@example.org")).not.toBe(publicCommitment("alice@example.orG"));
  });
});

describe("privateCommitment", () => {
  it.each(PRIVATE_VECTORS)("matches the runtime for salt %#", (salt, value, expected) => {
    expect(privateCommitment(salt, value)).toBe(expected);
  });

  it("depends on the salt and is not the public commitment of the value", () => {
    expect(privateCommitment(counting, "@alice")).not.toBe(privateCommitment(elevens, "@alice"));
    expect(privateCommitment(elevens, "@alice")).not.toBe(publicCommitment("@alice"));
  });

  it("refuses a salt that is not 32 bytes", () => {
    expect(() => privateCommitment(new Uint8Array(31), "x")).toThrow(/32 bytes/);
    expect(() => privateCommitment(new Uint8Array(33), "x")).toThrow(/32 bytes/);
  });
});

describe("linkCommitment", () => {
  it.each(LINK_VECTORS)("matches the runtime for %j", (title, url, scale, expected) => {
    expect(u8aToHex(encodeLink(title, url))).toBe(scale);
    expect(linkCommitment(title, url)).toBe(expected);
  });

  it.each(LONG_LINK_VECTORS)("matches the runtime for the %s link, with two-byte compact lengths", (_, title, url, length, head, expected) => {
    const scale = encodeLink(title, url);
    expect(scale.length).toBe(length);
    expect(u8aToHex(scale.subarray(0, 2))).toBe(head);
    // the URL length starts after the title: 64 bytes need 0x0101, 256 bytes need 0x0104
    const urlLength = u8aToHex(scale.subarray(scale.length - stringToU8a(url).length - 2, scale.length - stringToU8a(url).length));
    expect(urlLength).toBe(stringToU8a(url).length === 64 ? "0x0101" : "0x0104");
    expect(linkCommitment(title, url)).toBe(expected);
  });

  it("changes when the title or the url changes", () => {
    const base = linkCommitment("Website", "https://identit.ee");
    expect(linkCommitment("website", "https://identit.ee")).not.toBe(base);
    expect(linkCommitment("Website", "https://identit.ee/")).not.toBe(base);
  });

  it("does not let a title and a url trade characters", () => {
    expect(linkCommitment("ab", "c")).not.toBe(linkCommitment("a", "bc"));
  });
});

describe("tags keep the kinds apart", () => {
  it("gives one value three different commitments", () => {
    const value = "https://identit.ee";
    const kinds = new Set([publicCommitment(value), privateCommitment(elevens, value), linkCommitment(value, "")]);
    expect(kinds.size).toBe(3);
  });
});
