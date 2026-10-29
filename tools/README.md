# identitee tools

TypeScript tooling for the identitee chain:

| Path | What it is |
|---|---|
| `src/e2e.ts` | End-to-end scenario against a node (full, or read-only) |
| `src/people.ts` | Reads an identity from a People Chain (Polkadot, Kusama) as a migration payload |
| `src/migrator.ts` | Migration service: serves `request_migration` requests |
| `src/verifier/` | Verification service: attests fields whose owner proves control of them |
| `src/explorer/` | Block explorer: indexes the finalized blocks into SQLite and serves a read-only JSON API |
| `src/migrator-selftest.ts`, `src/verifier-selftest.ts`, `src/explorer-selftest.ts` | Self-tests of the three services on a throwaway dev node |
| `src/check-testnet.ts` | Read-only smoke check of a public node |
| `src/make-fixtures.ts` | Builds the synthetic People Chain test fixtures |

Deploying and operating the services is covered in [docs/OPERATIONS.md](../docs/OPERATIONS.md).

## Install

Requires Node 24. The self-tests and the full scenario also need a built `identitee-node`
(`cargo build --release` at the repository root). Everything runs through `tsx`: there is no build
step, and `tsx` is a runtime dependency, so `npm ci --omit=dev` is enough to run the services.

```bash
cd tools
npm ci
npm run verify:native   # required for the verifier's Matrix channel, see below
```

## Tests and checks

```bash
npm test             # node --test, no network, a few seconds
npm run typecheck    # tsc --noEmit
```

The People Chain tests read `identityOf` responses from `test/fixtures/people-*.json`: for each
account, the raw SCALE value as a node stores it, its storage key, the JSON polkadot.js decodes it to,
and a block it is said to be read at. The identities are synthetic (fictional values on development
accounts), one per property the migration has to handle: every field with a PGP fingerprint, dotID
judgements `KnownGood`/`FeePaid`/`OutOfDate`, both Kusama dotID registrars, hashed values, no
identity. Other cases (invalid UTF-8, a 257-byte value, `additional`) are built in the tests.
Rebuild the files with `npx tsx src/make-fixtures.ts` (no network).

`test/fixtures/tls-test.{crt,key}` is a self-signed certificate for `site.test`, `www.site.test`,
`other.test` and `keys.openpgp.org`, with a throwaway key made for the tests. It is only trusted by
the local HTTPS servers of the website and PGP tests, through an explicit `ca` option.

## End-to-end scenario

```bash
./target/release/identitee-node --dev --tmp     # terminal 1, repository root
npm run e2e -- --ws ws://127.0.0.1:9944         # terminal 2, tools/
```

`--ws` defaults to `ws://127.0.0.1:9944`. Each step prints `OK <step>` or `FAIL <step>: <reason>`;
a failure skips the rest of its group of dependent steps (`ABORT`); the exit code is 0 only if every
step passed. It takes about two minutes on a dev chain (6 s blocks, each step waits for inclusion).

It uses the dev keys of the `development` preset: `//Alice` (agent of authority 0 with every
capability) and `//Bob` (agent with `MIGRATE` only). Every account is a fresh key and every name
random, so it can be rerun on the same chain, but not concurrently: two runs share Alice's and Bob's
nonces and the pool rejects the second transaction (`1014: Priority is too low`).

What it covers, all from never-funded accounts whose calls must be fee-free (checked by balance and
by `skipFeelessPayment.FeeSkipped`):

- profile writes: bio, a public Email, a private Telegram (commitment
  `blake2_256("identitee:field:private:v1" ++ salt ++ value)` computed client-side), links, a WebP avatar
  from `pallets/identitee/tests/fixtures/`;
- attestations and facts: Email and Telegram attested by Alice, `DocumentChecked`, then `Fraud`, with
  the trust level checked at each stage, and an attestation voided by a changed value;
- usernames, `resolve_name`, a sub-account proposed and accepted;
- exact errors: a PNG avatar (`InvalidAvatar`), a reveal with a wrong salt (`RevealMismatch`);
- a migration from Polkadot executed by Bob with a dotID `KnownGood` judgement: `Certified`, with
  provenance, attestations and fact.

Calls use polkadot.js without custom types: runtime API calls go through `api.call.identiteeApi.*` and
errors are decoded from the metadata.

`--readonly` writes nothing and needs no key: it checks the runtime name, the system properties
(SS58 `2426`, `IDT`, 12 decimals), block production, that `identiteeApi` answers for an unknown
account, and that each limit constant in the metadata matches the expected value. Use it against any
node whose agent keys you do not hold.

`npx tsx src/check-testnet.ts [ws-url]` is a shorter read-only check (blocks advance and finalize,
properties, runtime API) that ends with one line `RESULT OK|FAIL best=<n> finalized=<n> [reason=...]`.

## Reading an identity from a People Chain

```bash
npx tsx src/people.ts <address> [polkadot|kusama]            # both chains by default
npx tsx src/people.ts <address> polkadot --at <block hash>   # at a pinned block
```

Prints the block read, the payload `fulfil_migration` would send and what was discarded. The address
may use any SS58 prefix: only the key matters.

Field mapping: `display` to `DisplayName`, `legal` to `LegalName`, `web` to `Web`, `email` to `Email`,
`matrix` to `Matrix`, `twitter` to `X`, `discord` to `Discord`, `github` to `GitHub`, `pgpFingerprint`
to `Pgp` (raw bytes), `additional` to custom fields. `image` is ignored. Only `Data::Raw` is imported: a
hashed value is discarded and reported; an empty field counts as never set.

The runtime refuses the whole call at the first invalid value, so the payload is cleaned first: each
invalid entry is discarded with a reason (`hashed`, `invalid-utf8`, `too-long`, `bad-pgp-length`,
`duplicate`, `too-many`, `empty`) and the rest is imported. Judgements are sent as read; the runtime
keeps only those of the dotID registrars (Polkadot `5`; Kusama `7`, then `6`). These indices are
`DOTID_REGISTRARS` in `src/people.ts`, and a test checks they match the runtime's `migration.rs`.

### Pinned block

The migration source can be pinned to one block per chain, for example the last block before
`pallet-identity` is removed from the People Chains. That block, not the latest finalized one, is then
recorded on chain as provenance.

| | Polkadot | Kusama |
|---|---|---|
| Environment (migrator and `people.ts`) | `PEOPLE_AT_BLOCK_POLKADOT` | `PEOPLE_AT_BLOCK_KUSAMA` |
| `people.ts` option | `--at <hash>` (chain argument required) | same |

The hash must be a finalized block of the canonical chain; anything else is refused. Reading old state
needs an archive endpoint: a pruned node answers `State already discarded` and the next endpoint is
tried. Check that the endpoints still serve the block with `people.ts --at` before relying on it.

Endpoints, tried in order (the next one after 20 s without an answer, or at once on a read error):
Polkadot `wss://polkadot-people-rpc.polkadot.io`, `wss://rpc-people-polkadot.luckyfriday.io`;
Kusama `wss://kusama-people-rpc.polkadot.io`, `wss://rpc-people-kusama.luckyfriday.io`.

## Migration service

```bash
IDENTITEE_MIGRATOR_SURI='//Bob' npx tsx src/migrator.ts                         # reads the People Chains
IDENTITEE_MIGRATOR_SURI='//Bob' npx tsx src/migrator.ts --snapshot polkadot.json  # reads a file
```

| Variable | Meaning |
|---|---|
| `IDENTITEE_MIGRATOR_SURI` | secret URI of an agent with the `MIGRATE` capability (required, never logged) |
| `IDENTITEE_WS` | node RPC endpoint (default `ws://127.0.0.1:9944`) |
| `PEOPLE_AT_BLOCK_POLKADOT`, `PEOPLE_AT_BLOCK_KUSAMA` | pinned source blocks (see above); ignored with `--snapshot` |

Behaviour:

- At start it refuses to run unless the node is identitee, the key holds `MIGRATE`, the payload limit
  constants are in the metadata, and every signed extension unknown to polkadot.js is on the allowlist
  (see "Notes for client authors"). A malformed `PEOPLE_AT_BLOCK_*` exits with code 2.
- It follows finalized blocks for `identitee.MigrationRequested`, and every 60 s sweeps the pending
  `MigrationRequests`, which serves requests made while it was stopped and retries failed ones.
- Requests are handled one at a time, each re-read before acting, so the agent's nonce is never
  contended and a withdrawn or served request is skipped.
- No identity at the source: `reject_migration(who, Unspecified)`. An account that created an identity
  after asking: `reject_migration(who, Other)`. A request for a chain with no source (no snapshot file
  for it) stays pending and is retried every 5 minutes.
- Permanent failures are not retried: `NoMigrationRequest` and `MigrationSourceMismatch` are ignored;
  `IdentityExists` and payload refusals reject the request with `Other`. Transient failures (source read,
  transaction not included within 90 s, other runtime errors) are retried with a delay doubling from
  30 s to 1 h.
- Logs are one JSON object per line on stdout (`ts`, `level`, `event`, ...). Events: `started`,
  `requested`, `fulfilled`, `rejected`, `skipped`, `not-served`, `request-failed`, `stopping`,
  `stopped`. polkadot.js notices go to stderr.
- `SIGTERM` or `SIGINT` stops taking requests, abandons a source read in progress, waits up to 30 s for
  a submitted transaction, and exits 0; a second signal exits at once.

A `--snapshot` file (repeatable, one per chain) replaces the People Chain. Keys are addresses in any
SS58 prefix, values are hex bytes, judgements are `JudgementLevel` names, and `block`/`blockHash` are
recorded as provenance. An account absent from the file is rejected as having no identity.

```json
{
  "source": "Polkadot",
  "block": 11294320,
  "blockHash": "0x40a22df1a505c1f7256680f67ff83bfb9b45620a487d66ff433a5038c1fc2c21",
  "identities": {
    "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5": {
      "typed": [["DisplayName", "0x44617665"], ["Email", "0x64617665406578616d706c652e6f7267"]],
      "custom": [],
      "judgements": [[5, "KnownGood"]]
    }
  }
}
```

### Self-test

```bash
npm run migrator:selftest            # no network
npm run migrator:selftest -- --live  # also reads the real People Chains
```

Starts `identitee-node --dev --tmp` on a free port (`IDENTITEE_NODE_BIN`, default
`../target/release/identitee-node`), then the real migrator as `//Bob` with a snapshot file, and
drives it with never-funded accounts: a request made before the service starts, one made while it
runs, invalid snapshot entries, an account absent from the snapshot, a real People Chain payload, an
account that creates an identity after asking, and a Kusama request with no Kusama source. It checks
that the key never appears in the logs, that stdout is JSON lines, and that `SIGTERM` exits 0.
`--live` adds real finalized reads of the People Chains, with and without a pinned block.

## Verification service

`src/verifier/` verifies a field when its owner proves control of it and records the attestation
with its own agent key (capabilities `ATTEST_FIELDS | PERSON_FACTS`). The design, including each
channel's threat model, is in [docs/VERIFIER.md](../docs/VERIFIER.md); each channel module's header comment describes its
flow and limits.

```bash
IDENTITEE_VERIFIER_SURI='<secret uri>' VERIFIER_DEV=1 npm run verifier
```

| Variable | Meaning |
|---|---|
| `IDENTITEE_VERIFIER_SURI` | secret URI of the verifier agent (required, never logged) |
| `IDENTITEE_WS` | node RPC endpoint (default `ws://127.0.0.1:9944`) |
| `VERIFIER_PORT` | HTTP port on 127.0.0.1 (default 8787) |
| `STATE_DIRECTORY` | state directory (required; `./.verifier-state` with `VERIFIER_DEV=1`) |
| `VERIFIER_DEV` | `1`: CORS and the front origin also accept `http://localhost:*` and `http://127.0.0.1:*` |
| `VERIFIER_FRONT_ORIGIN` | the site, where OAuth results go (default `https://identit.ee`) |
| `VERIFIER_PUBLIC_URL` | this service's public base URL, for OAuth callbacks (default `https://verify.identit.ee`) |

Channels are enabled by their variables; a channel with a missing variable is disabled and its routes
answer 503. Website and PGP need none.

| Channel | Variables | Attestation |
|---|---|---|
| Email | `RESEND_API_KEY` | `EmailCode` |
| X, Discord, GitHub (each on its own) | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `DISCORD_CLIENT_*`, `GITHUB_CLIENT_*` | `OAuth` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | `BotChallenge` |
| Matrix | `MATRIX_HOMESERVER` (https URL), `MATRIX_USER` (`@name:server`), `MATRIX_PASSWORD` | `MatrixChallenge` |
| Website | none | `WebFile` or `Dns` |
| PGP | none | `PgpSignature` |
| KYC (Didit) | `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET` | fact `DocumentChecked` |

### HTTP API

JSON in and out; errors are `{ "error": "<one sentence>" }`. `address` is the account; `packet` is only
for a private field (the verification packet signed by the wallet, inline or as the id returned by
`POST /api/packet`).

| Route | Body or query | Answer |
|---|---|---|
| `GET /api/health` | | genesis and enabled channels |
| `GET /api/channels` | | enabled channels, plus `telegramBot` and `matrixBot` |
| `POST /api/packet` | `{address, packet}` | `{ id }` (kept 10 minutes, in memory) |
| `POST /api/email/send` | `{address, packet?}` | `{ sent: true, session }` |
| `POST /api/email/check` | `{address, session, code}` | `{ verified: true }` |
| `GET /oauth/<x\|discord\|github>/start` | `?address=&mode=popup\|redirect[&packet=<id>]` | 302 to the provider |
| `GET /oauth/<x\|discord\|github>/callback` | from the provider | popup page or 302 to `<front>/me?verified=` / `?verify_error=` |
| `POST /api/telegram/start` | `{address, packet?}` | `{ url, session }` (a `t.me` start link) |
| `POST /api/telegram/check` | `{address, session, code}` | `{ verified: true }` |
| `POST /api/matrix/start` | `{address, packet?}` | `{ command, bot, session }` |
| `POST /api/matrix/check` | `{address, session, code}` | `{ verified: true }` |
| `POST /api/web/check` | `{address}` | `{ verified: true, method: "WebFile" \| "Dns" }` |
| `POST /api/pgp/challenge` | `{address, packet?}` | `{ challenge, session }` |
| `POST /api/pgp/verify` | `{address, session, signed, key?, packet?}` | `{ verified: true }` |
| `POST /api/kyc/start` | `{address, signature, message}` | `{ url }` (the Didit page) |
| `GET /api/kyc/status` | `?address=` | `{ status: "none" \| "pending" \| "approved" \| "declined" }` |
| `POST /didit/webhook` | Didit only, `X-Signature` HMAC of the raw body | 200 |

Common rules: the chain is the only source of the value being verified; every attestation carries
the field's commitment from the start of the proof, so a field changed meanwhile is refused by the
runtime (`StaleCommitment`) and the person is asked to start again; challenges expire within 10 to 15
minutes and are single-use; proof starts share a per-IP limit of 30 per hour, and each channel adds
its own limits.

### State

`STATE_DIRECTORY` holds `verifier.db` (SQLite: challenges in progress and rate-limit hits, never a
private value) and per-channel HMAC keys (`email.key`, `telegram.key`, `matrix.key`, `pgp.key`,
`didit.key`, mode 0600) kept outside the database, so a copy of the database alone reveals neither
codes nor which account a row counts. Losing a key voids the challenges and limits in flight, except
`didit.key`, which also maps each identity document to the address it certified. The Matrix bot keeps
its access token, sync state and crypto store in `matrix/` (deleting it makes the bot log in again as a
new device). Private field values stay in memory only.

### Matrix native module

`@matrix-org/matrix-sdk-crypto-nodejs` downloads `matrix-sdk-crypto.linux-x64-gnu.node` in its
`postinstall`, without a checksum, and a failed download leaves `npm ci` green. Its SHA-256 is pinned
in `matrix-crypto.sha256`. `npm run verify:native` exits 1 when the file is missing or differs; the
channel checks it again before loading and otherwise stays down (log `matrix-crypto-missing`) while the
rest of the service runs. Upgrading the package means updating the pin.

### Self-test

```bash
IDENTITEE_NODE_BIN=../target/release/identitee-node npm run verifier:selftest
```

No network. Starts `identitee-node --dev --tmp` (`IDENTITEE_NODE_BIN`, default `identitee-node` on the
`PATH`), makes a fresh key an agent of authority 0 with capabilities 3, gives `//Charlie` a public
Email and Telegram, and runs the real service as a child with a fake Resend and a fake Telegram Bot
API on the loopback. It drives the email and Telegram flows over HTTP, a stale field (409), a disabled
channel (503), then checks that no secret appears in the output, that stdout is JSON lines, and that
`SIGTERM` exits 0. About 45 s.

## Block explorer

`src/explorer/` indexes the finalized blocks of a node and serves them as a read-only JSON API, for
the explorer front ([explorer/README.md](../explorer/README.md)). It holds no key and never writes to
the chain. Deploying it is covered in [docs/OPERATIONS.md](../docs/OPERATIONS.md) ("The explorer").

```bash
EXPLORER_DB=./explorer.db EXPLORER_DEV=1 npm run explorer
```

| Variable | Meaning |
|---|---|
| `EXPLORER_NODE` | node RPC endpoint (default `ws://127.0.0.1:9944`); an archive node, see below |
| `EXPLORER_DB` | SQLite file of the index (default `/var/lib/identitee-explorer/explorer.db`; its directory is created) |
| `EXPLORER_PORT`, `EXPLORER_HOST` | where the API listens (default `8788`, `127.0.0.1`) |
| `EXPLORER_ORIGIN` | the browser origin allowed by CORS (default `https://explorer.identit.ee`) |
| `EXPLORER_DEV` | `1`: CORS also allows `http://localhost:5174`, the front's dev server |
| `EXPLORER_LABELS` | a JSON file `{ "<0x + 64 hex digits>": "label" }` naming validator keys (optional) |

An invalid value exits with code 2 and a message.

Behaviour:

- It indexes finalized blocks only, from genesis, then follows finality. Blocks above the finalized
  head are never stored, so there is no reorg handling. Balances, identities, roles, authorities and
  validators are read from the node when asked, not indexed.
- It needs an archive node: each block is decoded with the metadata of the runtime in force at that
  block (runtime upgrades are recorded), and the Aura author is read from the validator set at the
  parent block. The identitee events become sentences, and the calls inside `sudo` are decoded too.
- Each block shows who produced it (the Aura author) and the GRANDPA authority set in force at it. The
  exact signers are decoded only from the blocks that carry a stored justification, one every 512.
- The index is tied to the genesis hash. On another chain the old file is moved to
  `<EXPLORER_DB>.<first 8 hex digits of the old genesis>.bak` and the index starts again.
- The API starts listening before the node answers, and keeps serving the index when the node is down;
  `/api/status` says `"node": "down"`. An indexer that fails is retried with a wait that doubles from
  1 s to 30 s.
- Logs are one JSON object per line on stdout. `SIGTERM` or `SIGINT` stops the indexer, then the HTTP
  server, then closes the database, and exits 0.

### HTTP API

GET only. Answers are JSON; errors are `{ "error": "<code>" }`: 400 for bad input (`bad_cursor`,
`bad_limit`, `bad_address`, `bad_id`, `bad_query`...), 404 `not_found`, 405 for any other method, 503
`node_down` for a route that needs the node while it is away. A list returns `{ items, next }`: pass
`next` back as `cursor` for the following page, `limit` is 25 by default and 100 at most. Blocks and
extrinsics that are final are sent with `Cache-Control: public, max-age=300`, the rest with `no-store`.

| Route | Query | Answer |
|---|---|---|
| `/api/status` | | best, finalized and indexed heights, `node` (`up` or `down`), spec version, genesis |
| `/api/stats` | | counts: blocks, extrinsics, events, accounts, transfers, attestations, migrations, usernames; authorities |
| `/api/blocks` | `cursor`, `limit` | latest blocks first, with the author and its label |
| `/api/block/<number or hash>` | | the block: author, authority set, justification signers, digest logs, extrinsics, events |
| `/api/extrinsics` | `signer`, `pallet`, `signed=1` | extrinsics, newest first |
| `/api/extrinsic/<hash or block-index>` | | the decoded call, signer, nonce, tip, fee, result and events |
| `/api/events` | `pallet`, `method` | events, newest first, with a sentence for those the explorer explains (every identitee event) |
| `/api/identities` | `a` | display name, username, trust level and avatar hash of up to 50 comma-separated addresses, keyed as given |
| `/api/account/<address or hex key>` | | balance, nonce, identity summary, roles, profile link |
| `/api/account/<address>/history` | | its extrinsics and events |
| `/api/account/<address>/transfers` | | its transfers |
| `/api/avatar/<address>` | | the avatar set on chain, as `image/webp` (`max-age=300`); 404 without one |
| `/api/authorities` | | authorities with their agents and capabilities |
| `/api/authority/<id>` | `cursor`, `limit` | one authority, with its attestations |
| `/api/attestations` | `authority` | requests, attestations, revocations and rejections |
| `/api/migrations`, `/api/usernames` | | the matching event feeds |
| `/api/runtime` | | current spec, version history with the block of each upgrade, pallets from the metadata |
| `/api/network` | | validators (Aura and GRANDPA keys with labels), peer count, block time |
| `/api/search` | `q` | what the term is: `block`, `extrinsic`, `account`, `username` or `none`, with its target |
| `/api/live` | | Server-Sent Events: a `head` event with best, finalized and indexed when one moves |

`/api/live` is capped at 1000 clients (503 `too_many_clients` beyond) and drops a client that does not
read what it is sent.

### Tests and self-test

`npm test` covers the store, decoding, indexer and API without a node. The self-test runs the real
indexer against a throwaway `identitee-node --dev --tmp`, submits calls with the development keys and
checks what is stored:

```bash
IDENTITEE_NODE_BIN=../target/release/identitee-node npm run explorer:selftest
```

It prints `OK <step>` or `FAIL <step>: <reason>`, then `explorer self-test: ok` if every step passed.

## Notes for client authors

- `AuthorizeCall` (`frame_system`, upstream) is a signed extension unknown to polkadot.js 17, which
  prints `Unknown signed extensions AuthorizeCall found, treating them as no-effect`. It carries no
  data, so signatures are unaffected. For an unknown extension polkadot.js encodes nothing, so one that
  did carry data would yield invalid transactions with no client-side error. The scenario and the
  services therefore fail at connection when an unknown extension is not on the
  `UNKNOWN_EXTENSIONS_ALLOWED` allowlist; examine any new one before adding it.
- `RPC methods not decorated: ...` (`chainHead_v1_*`, `transaction_v1_*`) is harmless.
- In runtime API JSON, enum variants with data are camelCase objects (`{ "emailCode": null }`,
  `{ "typed": "Email" }`) while variants without data are PascalCase strings (`"Verified"`).
