import { TypeRegistry } from "@polkadot/types";
import { compactAddLength, u8aConcat, u8aToHex } from "@polkadot/util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicKeyHex } from "../src/chain/address.ts";
import { connect } from "../src/chain/api.ts";
import { DecodeError, identitySecret } from "../src/chain/identity.ts";

vi.mock("../src/chain/api.ts", () => ({ connect: vi.fn() }));

// `identitySecret` reads the raw `state_call` answer and decodes the SCALE `Option<Vec<u8>>`
// itself: polkadot.js's `api.call` turns that answer into its text class (see identity.ts). The
// answer arrives as `Bytes`, whose bare bytes are the SCALE of the Option.

const registry = new TypeRegistry();
const ALICE = "idrfveZjd2r16HCn9iKmEPnXTxdxqB3LRWGVXc7oKs9YX3ogk";
const call = vi.fn();

/** What the runtime returns for `Option<Vec<u8>>`, as polkadot.js hands it back from `state_call`. */
const answer = (scale: Uint8Array) => registry.createType("Bytes", u8aToHex(scale));

beforeEach(() => {
  call.mockReset();
  vi.mocked(connect).mockResolvedValue({ rpc: { state: { call } } } as never);
});

describe("identitySecret", () => {
  it("is null when the account stored nothing, and asks the runtime API for that account", async () => {
    call.mockResolvedValue(answer(Uint8Array.of(0)));
    expect(await identitySecret(ALICE)).toBeNull();
    expect(call).toHaveBeenCalledWith("IdentiteeApi_identity_secret", publicKeyHex(ALICE));
  });

  it("gives back the stored bytes, without the Option tag or the length prefix", async () => {
    const blob = Uint8Array.from({ length: 89 }, (_, i) => (i * 7 + 1) & 0xff);
    call.mockResolvedValue(answer(u8aConcat(Uint8Array.of(1), compactAddLength(blob))));
    expect(await identitySecret(ALICE)).toEqual(blob);
  });

  it("is not fooled by a blob that starts like an Option", async () => {
    const blob = Uint8Array.of(0, 1, 0, 1);
    call.mockResolvedValue(answer(u8aConcat(Uint8Array.of(1), compactAddLength(blob))));
    expect(await identitySecret(ALICE)).toEqual(blob);
  });

  it("refuses an answer that is not an Option of bytes", async () => {
    call.mockResolvedValue(answer(Uint8Array.of(1, 0x65, 0x01, 1, 2)));
    await expect(identitySecret(ALICE)).rejects.toBeInstanceOf(DecodeError);
    call.mockResolvedValue(answer(Uint8Array.of(7)));
    await expect(identitySecret(ALICE)).rejects.toBeInstanceOf(DecodeError);
  });
});
