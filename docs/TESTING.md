# Manual testing

Every user-facing operation (set an identity, request an attestation, receive it, claim a name, link
sub-accounts, migrate from the People Chain, verify a field automatically), done by hand against a
local development chain, with the expected result. `tools/src/e2e.ts` runs most of the same scenario
automatically (`npm run e2e`, see [tools/README.md](../tools/README.md)).

## Setup

Start a throwaway chain:

```bash
cargo build --release
./target/release/identitee-node --dev --tmp
```

Open polkadot.js/apps on it: <https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944>. The block
number advances every 6 s.

| Screen | Path in apps | Used for |
|---|---|---|
| Extrinsics | Developer > Extrinsics, module `identitee` | Writes (each call is signed) |
| Runtime calls | Developer > Runtime calls, API `identiteeApi` | Reading a profile, a trust level, a name |
| Chain state | Developer > Chain state, module `identitee` | Reading raw storage (pending requests, agents) |

Read call results in Network > Explorer (block events) or in the notification after signing.

Accounts:

| Account | Role in the development preset |
|---|---|
| A = `//Alice` | Sudo, and agent of authority 0 with capabilities 15 (all): attests and records facts |
| `//Bob` | Agent of authority 0 with capability 8 (migrate): used by the migration service |
| P | A fresh account created in the wallet extension, never funded: "the person" |
| S | A second fresh account, for sub-accounts |

Notes:

- apps or the browser console shows "Unknown signed extensions AuthorizeCall found, treating them as
  no-effect". `AuthorizeCall` is an upstream `frame_system` extension with no data; the notice is
  cosmetic and transactions go through.
- With a wallet extension (polkadot{.js}, Talisman, SubWallet), update its metadata for the chain once
  (Settings > Metadata), otherwise it cannot decode what it signs.
- P's balance stays 0 throughout. User calls are free (`skipFeelessPayment.FeeSkipped` on each) within
  50 calls per window of 14,400 blocks, opened by the account's first free call.
- `Bytes` fields accept text, which apps converts. For raw bytes (avatar, PGP fingerprint), paste
  hexadecimal starting with `0x`.

Start: Runtime calls > `identiteeApi.profile(P)` returns `None`.

## 1. Setting an identity (signed by P)

| # | Call | Expected |
|---|---|---|
| 1.1 | `setBio("Hello, testing identitee.")` | `identitee.BioSet`, `FeeSkipped`, balance still 0 |
| 1.2 | `setField(Typed / Email, Public("alice@example.org"))` | `identitee.FieldSet` |
| 1.3 | `setField(Typed / Telegram, Private(<commitment>))`, see 1.a | `identitee.FieldSet`; the value appears nowhere in clear |
| 1.4 | `setField(Custom("pronouns"), Public("she/her"))` | `identitee.FieldSet` |
| 1.5 | `addLink(title = "Site", url = "https://example.org")`, then a second link | `identitee.LinkAdded` twice, ids 0 and 1 |
| 1.6 | `reorderLinks([1, 0])` | `identitee.LinksReordered`, order reversed in the profile |
| 1.7 | `setAvatar(<avatar hex>)`, see 1.b | `identitee.AvatarSet` |
| 1.8 | `setAvatar(<hex of a PNG>)` | `identitee.InvalidAvatar` (WebP only, at most 8192 bytes, exactly 64x64) |
| 1.9 | `setIdentity(changes)`: add one `(key, value)` item per change, for example `(Typed / DisplayName, Public("Alice"))`, `(Custom("city"), Public("Paris"))`, and `(Custom("pronouns"), None)` to clear a field | `FieldSet` or `FieldCleared` per change, in one transaction counted once against the quota; one invalid change and nothing is written. Up to 32 changes, a key at most once, no `Link` keys |

Read `identiteeApi.profile(P)`: `identity.bio`, `identity.typed` with `Email: { Public: 0x...}` and
`Telegram: { Private: 0xf5c4... }`, `identity.custom`, the links, the avatar;
`trustLevel: Declared`; `attestations: []`.

Limits: value 256 bytes, bio 560, 16 custom fields (key 32), 16 links (title 64), avatar 8192 bytes.

### 1.a Commitment of a private field

A private field publishes only `blake2_256("identitee:field:private:v1" ‖ salt ‖ value)`, computed by
the client with a random 32-byte salt that the person keeps for a later reveal. In apps: Developer >
Utilities > Hash (blake2, 256 bits), hexadecimal input:

```
0x6964656e74697465653a6669656c643a707269766174653a7631   ("identitee:field:private:v1")
  <salt: 64 hex characters>
  <value in hex>
```

Worked example (a real salt is random, never `11...11`): salt `0x1111...11` (32 bytes), value `@alice`
(`40616c696365`), input

```
0x6964656e74697465653a6669656c643a707269766174653a7631111111111111111111111111111111111111111111111111111111111111111140616c696365
```

gives the commitment `0xf5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0`.

### 1.b Avatar bytes

The repository fixture `pallets/identitee/tests/fixtures/avatar-64-lossy.webp` (458 bytes) is a valid
avatar:

```bash
echo 0x$(xxd -p pallets/identitee/tests/fixtures/avatar-64-lossy.webp | tr -d '\n')
```

Paste the result (918 characters with `0x`) in the `bytes` field of `setAvatar`, or use the file upload
toggle of the `Bytes` input. The profile's `identity.avatar` then equals that hexadecimal.

### 1.c Identity secret

`setIdentitySecret(blob)` stores an opaque blob of 1 to 256 bytes for the account, which the chain
never interprets (the web front keeps the passphrase-encrypted salt secret in it; see
[ARCHITECTURE.md](ARCHITECTURE.md)). In apps only the call can be tested, with arbitrary bytes such as
`0x01020304`.

| Call | Expected |
|---|---|
| `setIdentitySecret(0x01020304)` | `identitee.IdentitySecretSet`, which does not contain the blob; it replaces any previous one and needs no identity |
| `setIdentitySecret(0x)` | `identitee.EmptySecretBlob` |
| `identiteeApi.identitySecret(P)` | `0x01020304`, or `None` when there is none |
| `clearIdentitySecret()` | `identitee.IdentitySecretCleared` |

`clearIdentity()` keeps the secret; `killIdentity` (sudo) deletes it, but only on an account that has
an identity (otherwise `identitee.NoIdentity`).

## 2. Requesting and receiving attestations

| # | Call | Expected |
|---|---|---|
| 2.1 | P: `requestJudgement(authority = 0, target = Field(Typed / Email))` | `identitee.AttestationRequested`; Chain state `identitee.pendingRequests(P, (0, Field(Typed Email)))` holds the request block |
| 2.2 | A: `provideJudgement(who = P, key = Typed / Email, expectedCommitment = <commitment>, verdict = Verified, method = EmailCode, expiresAt = None)` | `identitee.FieldAttested`; free for A; the request disappears |
| 2.3 | `identiteeApi.trustLevel(P)` | `PartiallyVerified` |
| 2.4 | A: `provideJudgement(P, Typed / Telegram, 0xf5c4...7de0, Verified, Manual, None)` | `identitee.FieldAttested`; `trustLevel` = `FullyVerified` (every verifiable typed field present is verified) |
| 2.5 | A: `grantFact(who = P, kind = DocumentChecked, expiresAt = None, reason = Unspecified, note = "ID document checked")` | `identitee.FactGranted`; `trustLevel` = `Certified` |

`DisplayName` and `LegalName` are never verifiable and never block `FullyVerified`.

### The commitment to attest

The agent attests the value it checked, designated by its commitment; if the value changes meanwhile,
the call is refused instead of attesting something else.

1. `identiteeApi.profile(P)` > `identity.typed.<Field>`:
   - `Private: 0x...`: that is the commitment, copy it;
   - `Public: 0x<value>`: the commitment is `blake2_256("identitee:field:public:v1" ‖ value)`. In
     Developer > Utilities > Hash, input `0x6964656e74697465653a6669656c643a7075626c69633a7631`
     followed by the value's hex without `0x`.
2. For `alice@example.org` the input is
   `0x6964656e74697465653a6669656c643a7075626c69633a7631616c696365406578616d706c652e6f7267` and the
   commitment `0x887551424c678798e870359494a90539aaa32b2cdc7534dd08c291224af4f1f0`.
3. Afterwards `profile(P).attestations` contains `[Typed Email, 0, {..., commitment: 0x8875...f1f0}, true]`;
   the last boolean says whether the attestation is valid now.

### The attestation follows the value

| # | Call | Expected |
|---|---|---|
| 2.6 | P: `setField(Typed / Email, Public("other@example.org"))` | `identitee.FieldSet`; the Email attestation turns `false`; `trustLevel` = `PartiallyVerified` (Telegram stays verified) |
| 2.7 | A: `provideJudgement` with the old commitment `0x8875...f1f0` | `identitee.StaleCommitment` |
| 2.8 | P: `revealField(Typed / Telegram, "@alice", <wrong salt>)` | `identitee.RevealMismatch` |
| 2.9 | P: `revealField(Typed / Telegram, "@alice", 0x1111...11)` | `identitee.FieldRevealed`; Telegram becomes `Public` and its attestation stays valid |

Other agent calls: `revokeAttestation(P, key, reason)`, `rejectRequest(P, target, reason, note)`,
`revokeFact(P, kind, reason)`. `grantFact(P, Fraud, ...)` makes the level `Fraudulent` whatever else
holds.

## 3. Claiming a name

Claiming needs a verified field (otherwise `identitee.NoVerifiedField`): do section 2 first.

| # | Call | Expected |
|---|---|---|
| 3.1 | P: `claimUsername("alice")` (3 to 32 characters of `a-z 0-9 - _`) | `identitee.NameClaimed` |
| 3.2 | `identiteeApi.resolveName("alice")` | P |
| 3.3 | `identiteeApi.nameStatus("alice")` | `Taken(P)`; a free name gives `Available`, a reserved one `Reserved` |
| 3.4 | P: `claimUsername("Alice")` | `identitee.NameInvalidChar` (uppercase; the name is checked first) |
| 3.5 | `profile(P).name` | `alice` |
| 3.6 | P: `releaseUsername()`, then `claimUsername("alice2")` | `identitee.NameReleased`, then `identitee.ClaimCooldown` (one quota window); `nameStatus("alice")` = `Quarantined { until }` |

A sudo account can `reserveUsername(name)`; a claim of a reserved name fails with
`identitee.NameIsReserved`.

## 4. Sub-accounts

| # | Call | Expected |
|---|---|---|
| 4.1 | P: `addSub(sub = S, label = "phone")` | `identitee.SubProposed`; `pendingSubsOf(P)` = `[[S, "phone"]]` |
| 4.2 | S: `acceptSub(parent = P)` | `identitee.SubAccepted`; `subsOf(P)` = `[[S, "phone"]]`, `parentOf(S)` = `[P, "phone"]`, `pendingSubsOf(P)` empty |
| 4.3 | P: `renameSub(S, "office")` | `identitee.SubLabelSet` |
| 4.4 | S: `quitSub()` (or P: `removeSub(S)`) | `identitee.SubLeft` (or `SubRemoved`); `parentOf(S)` = `None` |

`addSub` alone links nothing: the sub must accept.

## 5. Migration from the People Chain

Run the migration service against the development chain, signing as `//Bob`, from `tools/`:

```bash
IDENTITEE_MIGRATOR_SURI='//Bob' npx tsx src/migrator.ts                          # reads the real People Chains
IDENTITEE_MIGRATOR_SURI='//Bob' npx tsx src/migrator.ts --snapshot polkadot.json  # reads a hand-written file
```

A snapshot file lists the identities to import; its format is in [tools/README.md](../tools/README.md).
For 5.2, write one with the address of a fresh account M, a public Email and the judgement
`[[5, "KnownGood"]]`.

| # | Call (fresh accounts with no identity) | Expected |
|---|---|---|
| 5.1 | `requestMigration(Polkadot)` from an account with no People Chain identity (live mode, or absent from the file) | `identitee.MigrationRequested`, then within seconds of finalization `identitee.MigrationRejected { reason: Unspecified }` signed by Bob; `migrationRequests(account)` = `None` |
| 5.2 | `requestMigration(Polkadot)` from M, listed in the snapshot with `KnownGood` | `identitee.MigrationFulfilled`; `profile(M).imported` = `{ source: Polkadot, block, blockHash, judgements: [[5, KnownGood]] }`, the imported fields public, their attestations `MigratedFromPeopleChain { registrar: 5, ... }`, a `DocumentChecked` fact, `trustLevel` = `Certified` |
| 5.3 | `requestMigration(Polkadot)` from P, which has an identity | `identitee.IdentityExists` |
| 5.4 | `requestMigration`, then `cancelMigration()` while the service is stopped | `identitee.MigrationCancelled` |
| 5.5 | M: `clearIdentity()`, then `requestMigration(Polkadot)` again | `identitee.AlreadyMigrated` |

The service logs one JSON object per line: `requested`, then `fulfilled` or `rejected` with a cause.

## 6. Reads

| Read | Where | Expected |
|---|---|---|
| `identiteeApi.trustLevel(P)` | Runtime calls | `None` without identity; otherwise `Fraudulent`, `Declared`, `PartiallyVerified`, `FullyVerified` or `Certified` |
| `identiteeApi.profile(P)` | Runtime calls | Identity, name, level, attestations with validity, facts with activity, parent, subs, migration provenance |
| `identitee.identities(P)` | Chain state | The raw stored identity |
| `identitee.agents(A)` | Chain state | `[0, 15]` (authority 0, all capabilities) |
| `identitee.authorities(0)` | Chain state | `identitee`, active |
| `system.account(P)` | Chain state | `free: 0` throughout |

## 7. Automatic verification

The verification service ([VERIFIER.md](VERIFIER.md)) attests a field once the person proves control
from the profile editor at `/me`. Run it locally next to the development chain:

1. Make a fresh account V an agent with capabilities 3: A signs `sudo(identitee.setAgent(0, V, 3))`.
2. Start the service from `tools/`, with the channel credentials you have (see the configuration table
   in VERIFIER.md; channels without credentials are disabled, web and PGP need none):

   ```bash
   IDENTITEE_VERIFIER_SURI='<V secret URI>' VERIFIER_DEV=1 npm run verifier
   ```

3. Start the web front from `web/` against both:

   ```bash
   VITE_RPC=ws://127.0.0.1:9944 VITE_VERIFIER=http://127.0.0.1:8787 npm run dev
   ```

OAuth and Didit need the service reachable over HTTPS at a URL registered with the provider
(`VERIFIER_PUBLIC_URL`), so test them against a deployment. `curl -s <service>/api/health` lists the
enabled channels; a channel missing from it shows no `Verify` link.

On `/me`, connect P's wallet, give each tested field a real value you control and press Save. `Verify`
appears under a saved field and is disabled ("Save first.") while the form has unsaved changes. One
panel is open at a time.

A success shows "<Field> verified." and a check on the field. In apps,
`profile(P).attestations` contains `[Typed <Field>, 0, {method: ..., commitment: 0x...}, true]`, and the
service logs `attested` (or `attest-refused` with a reason).

| # | What you do | Expected |
|---|---|---|
| 7.1 Email | `Verify` under Email, Send code | A mail "Your identitee code" with 6 digits, valid 10 minutes. Type it, Confirm: verified, method `EmailCode`. A wrong code changes nothing; anything but 6 digits is refused on the page |
| 7.2 X, Discord, GitHub | `Verify`, Continue with the provider, authorize | The pop-up closes by itself (a full-page redirect on a phone): verified, method `OAuth` |
| 7.3 Telegram | `Verify`, click "Open Telegram", tap Start in the bot | The code input is enabled once the link was clicked. The bot answers "Your identitee code is NNNNNN" and names no identity. Type it, Confirm: the bot says "Verified.", method `BotChallenge` |
| 7.4 Matrix | `Verify`: the panel shows `!identitee <token>` and the bot's id. Send the command to the bot in a direct message | The bot answers that it sent the code privately and invites you to a new private encrypted room. Accept: the code arrives there, never in the first room. Type it, Confirm: method `MatrixChallenge` |
| 7.5 Website | `Verify` shows the file `https://<host>/.well-known/identitee.txt` and the record `identitee=<address>`. Press Check before publishing | "Neither the file nor the DNS record was found." Publish one of them, Check again: method `WebFile` or `Dns` |
| 7.6 PGP | The field holds your key's fingerprint. `Verify` shows `echo '<challenge>' \| gpg --clearsign`. Run it, paste the signed block, Verify | Method `PgpSignature`. For a key not on keys.openpgp.org, a "Public key" box opens: paste `gpg --armor --export <fingerprint>`. Never paste a secret key |
| 7.7 Document (Didit) | Under "Identity document", `Verify with Didit`. Sign the `identitee kyc` message (a signature, not a transaction), open Didit, scan a document and take the selfie | Back on `/me`, "Being checked." while the page polls the chain, then "Checked": `profile(P).facts` holds `DocumentChecked` from the verifier. `Certified` needs the verifiable typed fields verified as well |

Private field, levels and changes:

| # | What you do | Expected |
|---|---|---|
| 7.8 Private Email | Make Email private (the identity secret must exist and be unlocked), Save. `Verify`, type the address again, approve the wallet message signature, then send and confirm the code | A wrong value is refused on the page before the wallet is asked. The field stays `Private: 0x...` on chain and the attestation's commitment is that value. A private Web field is not verified ("Make your website public to verify it.") |
| 7.9 Levels | With two verifiable typed fields, verify one, then the other, then 7.7 | `PartiallyVerified`, then `FullyVerified`, then `Certified` |
| 7.10 Value change | Change a verified field and Save | The check disappears, its attestation reads `false`, `Verify` is offered again |

Negative checks:

| # | What you do | Expected |
|---|---|---|
| 7.11 Someone else's handle | Set X to a handle that is not yours, Verify, sign in with your own account | "You signed in to X as @you, but this identity says @other." Nothing attested. Same for Discord, GitHub, Telegram and Matrix |
| 7.12 Forwarded OAuth link | Open the `/oauth/github/start?...` link in another browser, or the provider's authorize link copied from the pop-up | The start link is refused with "Start the verification from your profile on identit.ee."; the authorize link finishes nothing, since the callback does not find the starting browser |
| 7.13 Forwarded Telegram link | Open the `t.me/<bot>?start=...` link from a Telegram account other than the field's | The bot refuses and sends no code |
| 7.14 Changed mid-proof | Send an email code, change the Email on chain, then confirm | "Your Email changed. Verify it again." Nothing attested |

## 8. Cleaning up

P: `clearIdentity()` gives `identitee.IdentityCleared` and `profile(P)` = `None`. Facts, migration
history and the identity secret survive, since they concern the person or the account, not the
profile.
