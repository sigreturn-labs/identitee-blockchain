import { Keyring } from "@polkadot/keyring";
import { hexToU8a, stringToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { privateCommitment } from "../src/chain/formulas.ts";
import { Refusal } from "../src/chain/refusal.ts";
import { makePacket, packetMessage, readPacket, type VerificationPacket } from "../src/chain/packet.ts";

// The verification packet of a private field: what the person sends to an authority so that it can
// check the value behind the commitment. It holds the value and the salt, so it is built on demand,
// shown to the person and never sent by the app. The wallet signs it the way extensions sign raw
// bytes (wrapped in <Bytes>...</Bytes>), so the authority knows it comes from the account.

const CHAIN = `0x${"ab".repeat(32)}` as const;
const SALT = new Uint8Array(32).fill(0x11);
let alice: ReturnType<Keyring["addFromUri"]>;
let bob: ReturnType<Keyring["addFromUri"]>;

beforeAll(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
  alice = keyring.addFromUri("//Alice");
  bob = keyring.addFromUri("//Bob");
});

/** What a wallet extension does with `signRaw({ type: "bytes" })`. */
const walletOf = (pair: typeof alice) => async (data: `0x${string}`) => u8aToHex(pair.sign(u8aWrapBytes(hexToU8a(data))));

const make = (overrides: Partial<Parameters<typeof makePacket>[0]> = {}, pair = alice) =>
  makePacket({ chain: CHAIN, address: alice.address, ref: { typed: "Telegram" }, value: stringToU8a("@alice"), salt: SALT, ...overrides }, walletOf(pair));

const tamper = (packet: VerificationPacket, patch: Partial<VerificationPacket>) => JSON.stringify({ ...packet, ...patch });

describe("makePacket", () => {
  it("holds the field, the value, the salt, the commitment, the chain and the account, signed", async () => {
    const packet = await make();
    expect(packet).toMatchObject({
      type: "identitee-verification-packet",
      version: 1,
      chain: CHAIN,
      address: alice.address,
      field: { typed: "Telegram" },
      value: "@alice",
      salt: u8aToHex(SALT),
      commitment: "0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0",
    });
    expect(Object.keys(packet)).toEqual(["type", "version", "chain", "address", "field", "value", "salt", "commitment", "signature"]);
  });

  it("asks the wallet to sign the packet as readable text, without the signature", async () => {
    let asked = "";
    await makePacket({ chain: CHAIN, address: alice.address, ref: { custom: "phone" }, value: stringToU8a("+33 6"), salt: SALT }, async (data) => {
      asked = new TextDecoder().decode(hexToU8a(data));
      return u8aToHex(alice.sign(u8aWrapBytes(hexToU8a(data))));
    });
    expect(JSON.parse(asked)).toEqual({
      type: "identitee-verification-packet",
      version: 1,
      chain: CHAIN,
      address: alice.address,
      field: { custom: "phone" },
      value: "+33 6",
      salt: u8aToHex(SALT),
      commitment: privateCommitment(SALT, "+33 6"),
    });
  });

  it("writes a PGP fingerprint as the hexadecimal of its bytes", async () => {
    const bytes = new Uint8Array(20).fill(0xab);
    const packet = await make({ ref: { typed: "Pgp" }, value: bytes });
    expect(packet.value).toBe(`0x${"ab".repeat(20)}`);
    expect(packet.commitment).toBe(privateCommitment(SALT, bytes));
    expect(await readPacket(JSON.stringify(packet))).toEqual({ packet, value: bytes });
  });

  it("refuses a signature from another account", async () => {
    await expect(make({}, bob)).rejects.toThrow("The wallet signed with another account.");
    // a sentence of the app: a page shows it as it is
    await expect(make({}, bob)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("readPacket", () => {
  it("accepts a packet made here, pretty-printed or not, and gives the value's bytes", async () => {
    const packet = await make();
    expect(await readPacket(JSON.stringify(packet))).toEqual({ packet, value: stringToU8a("@alice") });
    expect(await readPacket(`\n${JSON.stringify(packet, null, 2)}\n`)).toEqual({ packet, value: stringToU8a("@alice") });
  });

  it("refuses anything changed after signing", async () => {
    const packet = await make();
    const other = `0x${"cd".repeat(32)}`;
    for (const patch of [
      { value: "@alicE" },
      { salt: u8aToHex(new Uint8Array(32).fill(0x12)) },
      { field: { typed: "Email" } },
      { chain: other },
      { address: bob.address },
    ] as Partial<VerificationPacket>[]) {
      expect(await readPacket(tamper(packet, patch))).toHaveProperty("problem");
    }
  });

  it("refuses a commitment that the value and salt do not give, even signed", async () => {
    const forged = await make();
    const { signature: _drop, ...content } = { ...forged, commitment: `0x${"00".repeat(32)}` };
    const signature = u8aToHex(alice.sign(u8aWrapBytes(stringToU8a(packetMessage(content as VerificationPacket)))));
    expect(await readPacket(JSON.stringify({ ...content, signature }))).toEqual({ problem: "The value and salt do not give the commitment of the packet." });
  });

  it("refuses a signature over another text, and takes the bare text as signatureVerify does", async () => {
    const packet = await make();
    const { signature: _drop, ...content } = packet;
    const other = u8aToHex(alice.sign(u8aWrapBytes(stringToU8a(packetMessage({ ...content, value: "other" })))));
    expect(await readPacket(tamper(packet, { signature: other }))).toEqual({ problem: "The signature does not match the account." });
    // polkadot.js checks a message with and without the <Bytes> wrapping; a wallet always wraps
    const bare = u8aToHex(alice.sign(stringToU8a(packetMessage(content))));
    expect(await readPacket(tamper(packet, { signature: bare }))).toHaveProperty("packet");
  });

  it("refuses what is not a packet, with a sentence", async () => {
    const packet = await make();
    for (const text of ["", "hello", "[]", "{}", JSON.stringify({ ...packet, version: 2 }), JSON.stringify({ ...packet, extra: 1 }), tamper(packet, { salt: "0x11" }), tamper(packet, { field: { typed: "Nope" } as never })]) {
      const read = await readPacket(text);
      expect(read).toHaveProperty("problem");
      expect((read as { problem: string }).problem).toMatch(/\.$/);
    }
  });
});
