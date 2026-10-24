// Puts a few identities on a LOCAL dev node, to look at the profile page with real data:
//
//   ../target/release/identitee-node --dev --tmp
//   node scripts/seed-profiles.mjs                  (ws://127.0.0.1:9944, or pass another endpoint)
//
// Makes charlie (4 fields), dave (12 fields, an on-chain avatar, links, a sub-account) and eve (a
// sub-account of dave, certified). Alice, the agent of authority 0, verifies some of their fields.
// It writes to the chain, so it refuses to run unless the node says it is a development chain.
// Run it ONCE per node (--tmp starts empty): a second run adds the links again.
// Node 24 runs the TypeScript formulas of src/chain directly.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { stringToHex, u8aToHex } from "@polkadot/util";
import { cryptoWaitReady, randomAsU8a } from "@polkadot/util-crypto";
import { readFileSync } from "node:fs";
import { privateCommitment, publicCommitment } from "../src/chain/formulas.ts";

const endpoint = process.argv[2] ?? "ws://127.0.0.1:9944";
const hex = stringToHex;
const pub = (value) => ({ Public: hex(value) });

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true });
const chainType = (await api.rpc.system.chainType()).type;
if (chainType !== "Development" && chainType !== "Local") {
  await api.disconnect();
  throw new Error(`Refusing to seed ${endpoint}: it is a ${chainType} chain. Use a node started with --dev.`);
}

const keyring = new Keyring({ type: "sr25519", ss58Format: 2426 });
const alice = keyring.addFromUri("//Alice");
const people = {
  charlie: keyring.addFromUri("//Charlie"),
  dave: keyring.addFromUri("//Dave"),
  eve: keyring.addFromUri("//Eve"),
  ferdie: keyring.addFromUri("//Ferdie"),
};

/** Send and wait until the transaction is in a block; fail loudly otherwise. */
async function ok(call, signer) {
  await new Promise((resolve, reject) => {
    call.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        const e = result.dispatchError;
        reject(new Error(e.isModule ? api.registry.findMetaError(e.asModule).name : e.toString()));
      } else if (result.isError) reject(new Error(result.status.type));
      else if (result.status.isInBlock) resolve();
    }).catch((e) => reject(new Error(`${call.method.section}.${call.method.method}: ${String(e.message).split("\n")[0]}`)));
  });
}
const idt = api.tx.identitee;

// Each person's transactions go one after the other; different people go in parallel.
const salt = randomAsU8a(32);
const pgp = new Uint8Array(20).fill(0x5a);
const avatar = u8aToHex(readFileSync(new URL("../../pallets/identitee/tests/fixtures/avatar-64-lossy.webp", import.meta.url)));
const commitments = {};

async function charlie() {
  const who = people.charlie;
  commitments.charlie = { Email: publicCommitment("charlie@rivers.example"), GitHub: publicCommitment("charlie-rivers") };
  await ok(
    idt.setIdentity([
      [{ Typed: "DisplayName" }, pub("Charlie Rivers")],
      [{ Typed: "Email" }, pub("charlie@rivers.example")],
      [{ Typed: "GitHub" }, pub("charlie-rivers")],
      [{ Typed: "Telegram" }, { Private: privateCommitment(salt, "@charlie_r") }],
      [{ Typed: "Web" }, pub("https://rivers.example")],
    ]),
    who,
  );
  await ok(idt.setBio(hex("Maps, bicycles and small databases. Based in Lyon.")), who);
  await ok(idt.addLink(hex("Portfolio"), hex("https://rivers.example/work")), who);
  await ok(idt.addLink(hex("Notes"), hex("https://notes.rivers.example")), who);
}

async function dave() {
  const who = people.dave;
  const email = "dave@okonkwo.example";
  const github = "dokonkwo";
  commitments.dave = { Email: publicCommitment(email), GitHub: publicCommitment(github) };
  await ok(
    idt.setIdentity([
      [{ Typed: "DisplayName" }, pub("Dave Okonkwo")],
      [{ Typed: "LegalName" }, pub("David Chinedu Okonkwo")],
      [{ Typed: "Web" }, pub("https://okonkwo.example")],
      [{ Typed: "Email" }, pub(email)],
      [{ Typed: "Matrix" }, pub("@dave:okonkwo.example")],
      [{ Typed: "X" }, pub("@dokonkwo")],
      [{ Typed: "Discord" }, pub("dave.okonkwo")],
      [{ Typed: "GitHub" }, pub(github)],
      [{ Typed: "Telegram" }, { Private: privateCommitment(salt, "@dave_ok") }],
      [{ Typed: "Pgp" }, { Public: u8aToHex(pgp) }],
      [{ Custom: hex("mastodon") }, pub("@dave@hachyderm.example")],
      [{ Custom: hex("pronouns") }, pub("he/him")],
      [{ Custom: hex("location") }, pub("Lagos and Berlin")],
    ]),
    who,
  );
  await ok(
    idt.setBio(hex("Security engineer. I take apart protocols for a living and put them back together for fun.\nOpen to talks and workshops.")),
    who,
  );
  await ok(idt.addLink(hex("Blog"), hex("https://okonkwo.example/blog")), who);
  await ok(idt.addLink(hex("Talks"), hex("https://video.example/@dokonkwo")), who);
  await ok(idt.addLink(hex("Paper on checking identity claims across several chains"), hex("https://papers.example/identity/claims-across-chains.pdf")), who);
  await ok(idt.setAvatar(avatar), who);
}

async function eve() {
  const who = people.eve;
  commitments.eve = { Email: publicCommitment("eve@okonkwo.example") };
  await ok(idt.setIdentity([[{ Typed: "DisplayName" }, pub("Eve")], [{ Typed: "Email" }, pub("eve@okonkwo.example")]]), who);
  await ok(idt.setBio(hex("Dave's phone.")), who);
}

async function ferdie() {
  await ok(idt.setBio(hex("A laptop.")), people.ferdie);
}

await Promise.all([charlie(), dave(), eve(), ferdie()]);
console.log("identities written");

// Alice, the agent of authority 0, verifies what these people could prove.
for (const [who, key, commitment] of [
  [people.charlie, "Email", commitments.charlie.Email],
  [people.charlie, "GitHub", commitments.charlie.GitHub],
  [people.dave, "Email", commitments.dave.Email],
  [people.dave, "GitHub", commitments.dave.GitHub],
  [people.eve, "Email", commitments.eve.Email],
]) {
  await ok(idt.provideJudgement(who.address, { Typed: key }, commitment, "Verified", "Manual", null), alice);
}
// and refuses one: a rejected field shows as Rejected, not Pending
await ok(idt.provideJudgement(people.charlie.address, { Typed: "Web" }, publicCommitment("https://rivers.example"), "Rejected", "Manual", null), alice);
await ok(idt.grantFact(people.eve.address, "DocumentChecked", null, "Unspecified", hex("passport seen")), alice);
console.log("judgements written");

// A verified field is enough to take a name; then sub-accounts: eve and ferdie join dave.
await Promise.all([
  ok(idt.claimUsername(hex("charlie")), people.charlie),
  ok(idt.claimUsername(hex("dave")), people.dave),
  ok(idt.claimUsername(hex("eve")), people.eve),
]);
await ok(idt.addSub(people.eve.address, hex("phone")), people.dave);
await ok(idt.addSub(people.ferdie.address, hex("old laptop")), people.dave);
await Promise.all([ok(idt.acceptSub(people.dave.address), people.eve), ok(idt.acceptSub(people.dave.address), people.ferdie)]);

console.log("\nProfiles on", endpoint);
for (const [name, pair] of Object.entries(people)) console.log(`  /${name}\n  /a/${pair.address}`);
await api.disconnect();
