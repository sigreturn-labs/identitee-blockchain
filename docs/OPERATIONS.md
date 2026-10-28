# Operations

How to build, deploy and run an identitee network node with its migration, verification and explorer
services, as the public testnet is run: a single validator on a Debian 13 host, its RPC published by
nginx over TLS. Commands run on the server as a user with `sudo`, unless they say otherwise. The
templates live in `deploy/`.

## Layout

```
client --wss/https--> nginx :443 --> identitee-node 127.0.0.1:9944   (--rpc-methods safe)
                        |               p2p 0.0.0.0:30333, Prometheus 127.0.0.1:9615
                        |               /var/lib/identitee (archive node)
                        |
                        +--https--> identitee-verifier 127.0.0.1:8787
                        |           /var/lib/identitee-verifier
                        |
                        +--https--> identitee-explorer 127.0.0.1:8788  --ws 127.0.0.1:9944--> node
                                    /var/lib/identitee-explorer

identitee-migrator --ws 127.0.0.1:9944-- node;  --wss--> People Chain public endpoints
```

The explorer's static front is not on this server: it is deployed to Cloudflare Pages and reads the
explorer API from the browser (see "The explorer").

| Item | Location |
|---|---|
| Binary | `/usr/local/bin/identitee-node` |
| Node data | `/var/lib/identitee` (chain database, keystore, network key), owner `identitee` |
| Configuration | `/etc/identitee/`: raw chain spec, `public-keys.json`, and for the explorer the optional `explorer.env` and `explorer-labels.json` |
| Secrets | `/etc/identitee/secrets/` (root, 700; files 600) |
| Tools (migrator, verifier, explorer) | `/opt/identitee/tools` (root, read-only), Node.js in `/opt/identitee/node` |
| Verifier state | `/var/lib/identitee-verifier` (systemd `StateDirectory`, 700) |
| Explorer state | `/var/lib/identitee-explorer` (systemd `StateDirectory`, 700): derived data, not backed up |
| Backups | `/var/backups/identitee/` (root, 700) |
| Units | `identitee-node`, `identitee-migrator`, `identitee-verifier`, `identitee-explorer`, `identitee-backup.{service,timer}`, `identitee-backup-failed` |
| Firewall | SSH, 80 (certbot HTTP challenge and redirect), 443 |

Every service listens on localhost; only nginx is exposed. The node is an archive node
(`--state-pruning archive --blocks-pruning archive`): the whole history stays queryable, which the
explorer needs to decode old blocks. Aura produces a block every 6 s and GRANDPA finalizes, both with
the keys of the validator set, which `pallet_session` hands them every 10 minutes (see "Validators").

## Building the release binary

The node must be built against the glibc of the target system. `deploy/build-release.sh` builds in a
Debian trixie container with the toolchain pinned in `rust-toolchain.toml`:

```bash
deploy/build-release.sh      # on a build machine with Docker
# -> target-trixie/release/identitee-node
```

The script:

- refuses a dirty tree (a modified tracked file, or an untracked file among the build inputs), because
  `identitee-node --version` carries the commit hash, which says nothing of uncommitted changes;
- builds the image `identitee-build:<toolchain>-trixie` (Rust, `protobuf-compiler`, `clang`,
  `libclang-dev`, `rust-src`, the `wasm32v1-none` target);
- runs `cargo build --locked --release -p identitee-node` as the calling user, with the cargo cache in
  `$CARGO_CACHE` (default `~/.cache/identitee-cargo-trixie`);
- checks the result in a bare `debian:trixie-slim` (`ldd` and `--version`).

A cold build takes about 20 minutes and needs about 8 GB of disk for `target-trixie/` and the cache.
The same commands work natively on a Debian 13 host with Rust installed.

## Deploying a binary

```bash
scp target-trixie/release/identitee-node <server>:/tmp/identitee-node
# on the server
sudo install -m755 /tmp/identitee-node /usr/local/bin/identitee-node
sudo systemctl restart identitee-node
```

Replacing the binary does not change the chain's runtime. The runtime is Wasm stored in state
(`:code`), fixed at genesis and changed only by `sudo(system.setCode)`. To upgrade it, increment
`spec_version` in `runtime/src/lib.rs`, build, and submit `setCode` from the sudo account with
`target-trixie/release/wbuild/identitee-runtime/identitee_runtime.compact.compressed.wasm`.

## Keys and secrets

Generate every key on the server with the shipped binary (`identitee-node key generate`), never in the
repository:

| File in `/etc/identitee/secrets/` | Content | Used by |
|---|---|---|
| `session.phrase` | Secret phrase of the session keys | Aura (sr25519) and GRANDPA (ed25519), same phrase |
| `migrator.phrase` | Phrase of the migrator agent (sr25519) | source of `migrator.env` |
| `migrator.env` | `IDENTITEE_MIGRATOR_SURI="<phrase>"` | `identitee-migrator.service` |
| `verifier.phrase` | Phrase of the verifier agent (sr25519) | source of `verifier.env` |
| `verifier.env` | `IDENTITEE_VERIFIER_SURI` and the provider credentials | `identitee-verifier.service` |
| `node-key` | libp2p network key (ed25519) | copied to `/var/lib/identitee/node-key` (600, `identitee`) |
| `peer-id.txt` | Corresponding PeerId | reference |

The `.env` files are read by systemd as root through `EnvironmentFile=`; the service users cannot read
the secrets directory. Both services strip their keys from every log line.

The public keys go into `/etc/identitee/public-keys.json` and into the genesis preset
(`runtime/src/genesis_config_presets.rs`: `TESTNET_AURA`, `TESTNET_GRANDPA`, `TESTNET_MIGRATOR`,
`TESTNET_VERIFIER`, `TESTNET_OWNER`). They are written in hexadecimal because prefix 2426 is not a
registered SS58 format and `AccountId32` deserialization would reject it. The sudo account holds no
secret on the server: its key stays in the operator's wallet.

Insert the session keys into the node's keystore:

```bash
B=/usr/local/bin/identitee-node; S=/etc/identitee/secrets; C=/etc/identitee/identitee-testnet-raw.json
sudo $B key insert --base-path /var/lib/identitee --chain $C --key-type aura --scheme sr25519 --suri $S/session.phrase
sudo $B key insert --base-path /var/lib/identitee --chain $C --key-type gran --scheme ed25519 --suri $S/session.phrase
sudo chown -R identitee:identitee /var/lib/identitee
```

`--suri` accepts a file path, so the phrase appears neither in `ps` nor in the shell history.

Pitfalls:

- `--suri <path>` reads the file only if the path exists. A missing path is taken as a SURI and derives
  a key from the public development phrase, without any error. Always compare the resulting public key
  with `public-keys.json`.
- `key inspect` prints the secret phrase along with the public key. Filter it:

  ```bash
  sudo $B key inspect --scheme Sr25519 $S/session.phrase | grep "Public key (hex)"   # aura
  sudo $B key inspect --scheme Ed25519 $S/session.phrase | grep "Public key (hex)"   # grandpa
  sudo $B key inspect --scheme Sr25519 $S/migrator.phrase | grep "Public key (hex)"
  sudo $B key inspect --scheme Sr25519 $S/verifier.phrase | grep "Public key (hex)"
  sudo ls /var/lib/identitee/chains/identitee_testnet/keystore/   # 61757261<aura> and 6772616e<grandpa>
  ```

- A validator needs a persisted network key: the node refuses `--validator` without one, hence
  `--node-key-file`.

Build an `.env` file from a phrase without displaying it:

```bash
sudo bash -c 'umask 077; printf "IDENTITEE_MIGRATOR_SURI=\"%s\"\n" "$(cat /etc/identitee/secrets/migrator.phrase)" \
  > /etc/identitee/secrets/migrator.env'
```

### Encrypted copy of the secrets

Losing `/etc/identitee/secrets/` means losing the validator and the agent accounts. The nightly archive
contains it; keep an encrypted copy off the server as well:

```bash
set -o pipefail
ssh <server> 'sudo -n tar -C /etc/identitee -czf - secrets public-keys.json' | gpg -c > identitee-secrets-$(date +%F).tar.gz.gpg
gpg -d identitee-secrets-*.tar.gz.gpg | tar -tzf -     # must list secrets/session.phrase, node-key, ...
```

Without `pipefail`, a failing `ssh` or `sudo` leaves an empty encrypted file with exit code 0: only the
listing proves the archive holds something.

## The node

Install `deploy/identitee-node.service` as `/etc/systemd/system/identitee-node.service`, the raw chain
spec as `/etc/identitee/identitee-testnet-raw.json`, then:

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin identitee
sudo install -d -m 750 -o identitee -g identitee /var/lib/identitee
sudo install -m 600 -o identitee -g identitee /etc/identitee/secrets/node-key /var/lib/identitee/node-key
sudo systemctl daemon-reload && sudo systemctl enable --now identitee-node
sudo journalctl -u identitee-node -f       # "Imported #n", "finalized #n" advancing
```

- `--rpc-methods safe` is mandatory behind a local proxy. nginx connects from `127.0.0.1`, and the
  default `auto` treats localhost as trusted, which would serve `author_insertKey`, `author_rotateKeys`
  and other unsafe methods to the world.
- The unit is hardened (`ProtectSystem=strict` with only `/var/lib/identitee` writable, no
  capabilities, `@system-service` syscall filter, kernel and namespace protections). It omits
  `MemoryDenyWriteExecute`, because wasmtime compiles the runtime to native code, and `ProcSubset=pid`,
  which hides `/proc/meminfo` and makes the node start silently without its shared trie cache.
  After any hardening change, compare the startup log with a known-good one, not only block production.
- Try hardening options on a throwaway node first:

  ```bash
  sudo systemd-run --unit=hardening-probe -p User=identitee -p <option>... \
    /usr/local/bin/identitee-node --dev --tmp --rpc-port 9966 \
    --listen-addr /ip4/127.0.0.1/tcp/30666 --no-prometheus --no-mdns --no-telemetry
  ```

- `--port` and `--listen-addr` are mutually exclusive.
- P2P is public: `sudo ufw allow 30333/tcp`. The node is the testnet bootnode, at
  `/dns/rpc.identit.ee/tcp/30333/p2p/<PeerId>`; print the PeerId with
  `identitee-node key inspect-node-key --file /var/lib/identitee/node-key`.

### Running a full node

Anyone can sync the testnet. Build `identitee-node` from the commit deployed on the testnet, then:

```bash
identitee-node --chain deploy/chainspec/identitee-testnet-raw.json \
  --base-path ./identitee-data --name <your-node-name> \
  --bootnodes /dns/rpc.identit.ee/tcp/30333/p2p/12D3KooWDdpoKG1W5B8da4DSwTQ1WpbSBLG67V1czucqRwFnqbpz
```

A full node does not produce or finalize blocks. To make it a validator, see "Validators".

### Validators

The validator set is a list of accounts kept by the validators pallet and managed by root. Each
validator has session keys: an Aura key (sr25519) and a GRANDPA key (ed25519), held in its node's
keystore. Sessions last 10 minutes (100 blocks); a change to the set takes effect at the start of
the session after next, so within 20 minutes.

To add a validator:

1. The validator runs a full node with `--validator`, connected to the testnet, and generates its
   keys with `author_rotateKeys` on its own RPC (or inserts them with `key insert`, key types `aura`
   and `gran`). It sends the operator its account address and the two public keys.
2. The operator submits, from the sudo account:
   `sudo(validators.addValidator(<account>, { aura: <0x aura key>, grandpa: <0x grandpa key> }))`.
   The account needs no balance and no proof of ownership: root vouches for the keys.
3. Two sessions later the node produces blocks in turn and votes in GRANDPA. `session.validators`
   lists the active set and `grandpa.currentSetId` increases by one.

`sudo(validators.removeValidator(<account>))` removes one; the last cannot be removed. A validator
rotates its own keys with `session.setKeys` (with the ownership proof its node produces) and clears
them with `session.purgeKeys`.

GRANDPA finalizes with more than two thirds of the voters: with two validators, both must be online,
or finality stops until the missing one returns, then catches up. Three validators tolerate one
offline. With several validators, Aura also stops producing on a node left without any peer, unless
it runs with `--force-authoring`: the operator's node does (`deploy/identitee-node.service`), so blocks
keep coming in its slots while the other validators are away.

Rewards: the author of each block earns 10 IDT, minted for it, and the transaction fees and tips of
the block. A validator earns in proportion to the blocks it produces; one that is down earns nothing.

Runtime 9 introduced sessions on a chain started without them: its migration made the sudo account
the validator owning the genesis keys, so no authority changed during the upgrade.

## nginx and TLS

```bash
sudo install -m644 deploy/nginx-rpc.conf /etc/nginx/sites-available/<rpc host>
sudo ln -sf /etc/nginx/sites-available/<rpc host> /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <rpc host> --non-interactive --agree-tos -m <operator email> --redirect
```

Set `server_name` to your host first. The templates are the configuration before certbot, which adds
the 443 listener, the certificate paths and the HTTP to HTTPS redirect to the installed copy.
`certbot.timer` renews certificates; check with `sudo certbot renew --dry-run` and
`sudo certbot certificates`. Without an e-mail address registered at Let's Encrypt, no expiry warning
is sent.

The RPC proxy forwards the WebSocket upgrade and sets `proxy_read_timeout 1h`, without which nginx
closes an idle subscription after 60 s.

Check from outside:

```bash
cd tools
npx tsx src/check-testnet.ts                   # blocks and finality advance, SS58 2426, IDT, 12 decimals
npm run e2e -- --ws wss://<rpc host> --readonly
curl -s -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"author_rotateKeys","params":[]}' https://<rpc host>
# -> "RPC call is unsafe to be called externally"
```

`rpc_methods` still lists the unsafe methods: the list does not say what is allowed, only a call does.

## Node.js and the tools

The migrator, the verifier and the explorer run from one shared copy of `tools/`:

1. Install the official Node.js 24 tarball in `/opt/identitee/node-v24.x.y-linux-x64`, checked against
   its `SHASUMS256.txt`, with a link `/opt/identitee/node`.
2. Install the code (run from a checkout, piping to the server):

```bash
cd tools && tar -czf - package.json package-lock.json tsconfig.json matrix-crypto.sha256 src | ssh <server> '
  set -euo pipefail; D=$(mktemp -d); tar -C $D -xzf -
  sudo rm -rf /opt/identitee/tools.new && sudo mkdir /opt/identitee/tools.new && sudo cp -r $D/. /opt/identitee/tools.new/
  cd /opt/identitee/tools.new && R="sudo env PATH=/opt/identitee/node/bin:/usr/bin:/bin HOME=/root"
  $R npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  $R node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js
  $R npm run verify:native
  sudo rm -rf /opt/identitee/tools && sudo mv /opt/identitee/tools.new /opt/identitee/tools
  sudo chown -R root:root /opt/identitee && rm -rf $D
  sudo systemctl try-restart identitee-migrator identitee-verifier identitee-explorer'
```

- `--ignore-scripts` keeps package install scripts from running as root, so the Matrix native crypto
  module is downloaded explicitly. Its download can fail silently: `npm run verify:native` checks it
  against `matrix-crypto.sha256`, prints `ok matrix-sdk-crypto.linux-x64-gnu.node <sha256>`, and stops
  the recipe before the running code is replaced. Without the module the verifier runs without Matrix
  and logs `matrix-crypto-missing`.
- The tarball's `npm` needs Node's `bin/` in `PATH` (`#!/usr/bin/env node`).
- `tsx` is a runtime dependency: the tools have no build step, and Node's type stripping does not cover
  constructor parameter properties. The services run `node --import tsx <entry>`.
- `try-restart` of a unit that is not installed yet (`identitee-explorer`, before "The explorer" is set
  up) fails with `Unit ... not found`. That is harmless: the new code is already in place.

### Runtime upgrades and the services

After a `setCode`, polkadot.js reloads the metadata at version 14, which lists no runtime API: calls
such as `identiteeApi.profile` and `identiteeApi.trustLevel` would fail until a new connection. So the
migrator, the verifier and the explorer watch the runtime version: when it changes they log `stopping`
with `"reason":"runtime_upgraded"` and the new `specVersion`, stop cleanly and exit 1, and systemd
starts them again 15 s later (`Restart=on-failure`) on the new runtime. Nothing to do by hand; check
after an upgrade that the three are `active` again.

## The migration service

Executes `request_migration`: it follows the node's finalized blocks, reads the identity on the
requested People Chain (public endpoints, outbound only), and sends `fulfil_migration`, or
`reject_migration` when that chain has no identity for the account. Its key must be an agent with the
`MIGRATE` capability (`8`). Behaviour and options: [tools/README.md](../tools/README.md).

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin identitee-migrator
sudo install -m644 deploy/identitee-migrator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now identitee-migrator
sudo journalctl -u identitee-migrator -f -o cat    # one JSON object per line
```

At startup it logs `connected`, `agent` (with `capabilities`; it stops if the key lacks `MIGRATE`) and
`started`. Per request: `requested`, then `fulfilled` or `rejected` with a cause. `request-failed` is a
transient failure (People Chain unreachable, transaction not included), retried with a delay that
doubles up to one hour. The service survives a node restart: polkadot.js reconnects and resubscribes.

## The verification service

See [VERIFIER.md](VERIFIER.md) for what it does. Its key must be an agent with capabilities `3`
(attest fields, person facts).

1. DNS: an A record for the verify host to the server, not proxied, so certbot can issue a certificate.
2. User: `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin identitee-verifier`.
3. Secrets: build `verifier.env` from the phrase and a file of provider credentials, never printed:

   ```bash
   # provider credentials in /tmp/verify.env, created with umask 077
   sudo bash -c 'umask 077; {
       printf "IDENTITEE_VERIFIER_SURI=\"%s\"\n" "$(cat /etc/identitee/secrets/verifier.phrase)"
       grep -E "^(X|DISCORD|GITHUB|RESEND|MATRIX|TELEGRAM|DIDIT)_[A-Z_]+=" /tmp/verify.env
     } > /etc/identitee/secrets/verifier.env'
   shred -u /tmp/verify.env
   sudo sed -E 's/=.*//' /etc/identitee/secrets/verifier.env     # variable names only
   ```

   If the service does not run at the default public URLs, also set `VERIFIER_PUBLIC_URL` and
   `VERIFIER_FRONT_ORIGIN` there.
4. Code: as in "Node.js and the tools".
5. Unit: `sudo install -m644 deploy/identitee-verifier.service /etc/systemd/system/`, then
   `sudo systemctl daemon-reload && sudo systemctl enable --now identitee-verifier`.
6. nginx and TLS with `deploy/nginx-verify.conf`, as for the RPC host.
7. Check: `curl -s https://<verify host>/api/health` returns `{"ok":true,"genesis":"0x...","channels":[...]}`.

The verify proxy must set `X-Forwarded-For $remote_addr` (one value): the service takes the last entry
as the client address for its per-IP limits, and `$proxy_add_x_forwarded_for` would pass along whatever
the client wrote. `/oauth/` is kept out of the access log because its query holds the provider's code
and state. Bodies are capped at 64 KB, 256 KB on `/api/pgp/verify`.

Startup log: `connected` (genesis), `agent` (it stops without capabilities `3`), `channels`,
`listening`. Then `attested` (account, field, method, block), `attest-refused` (`stale`: the field
changed; `gone`: removed; `failed`: the chain refused). Lines to act on:

| Event | Meaning |
|---|---|
| `matrix-crypto-missing` | Native module missing or altered: reinstall the tools |
| `telegram-api-failed`, `telegram-poll-failed` | Bot API errors (method and status only) |
| `telegram-bot-name-mismatch` | `TELEGRAM_BOT_USERNAME` is not the bot of the token |
| `kyc-needs-review` | Approved by Didit without a readable document number or issuing state: check the session in Didit's console, then grant `DocumentChecked` by hand from the authority page if it is right |
| `kyc-duplicate` | The document already certified another address; declined |
| `stop-timeout` | A submission was still in flight at shutdown |

Channel operation:

- OAuth callbacks to register: `<public url>/oauth/x/callback`, `/oauth/discord/callback`,
  `/oauth/github/callback`. Didit webhook: `<public url>/didit/webhook`, signed with
  `DIDIT_WEBHOOK_SECRET`.
- Telegram long-polls and clears any webhook at startup.
- The Matrix bot's device lives in `matrix/` under the state directory; deleting it logs in again as a
  new device.

Self-test, no network, about 45 s: a `--dev --tmp` node, fake Resend and Telegram servers, the email,
Telegram and stale-field flows through the real service:

```bash
cd tools && IDENTITEE_NODE_BIN=<path to identitee-node> npm run verifier:selftest    # PASS <n> steps
```

## The explorer

A block explorer at `explorer.identit.ee`: blocks, extrinsics, events, accounts, authorities,
attestations, migrations, usernames, runtime and network. It has two parts:

- `identitee-explorer`, on the server (`tools/src/explorer/`): one process that indexes the finalized
  blocks of the local node into SQLite and serves them as a read-only JSON API, plus a stream of the
  heads (Server-Sent Events). Endpoints and options: [tools/README.md](../tools/README.md).
- The front (`explorer/`), a static site on Cloudflare Pages that reads the API from the browser
  ([explorer/README.md](../explorer/README.md)).

The explorer holds no key or secret, never writes to the chain, and shows only what the chain shows:
a private field is a commitment there, and a commitment is all the explorer has.

**The node must be an archive node.** Each block is decoded with the metadata of the runtime that was
in force at that block, and the Aura author is read from the validator set at the parent block. A node
with pruned state cannot serve either, so the first catch-up from genesis fails on it.

1. DNS: an A record for the API host (`explorer-api.identit.ee`) to the server, not proxied, so certbot
   can issue a certificate. The front's host (`explorer.identit.ee`) is a CNAME to the Pages project,
   added as a custom domain of that project.
2. User: `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin identitee-explorer`.
3. Code: as in "Node.js and the tools".
4. Unit: `sudo install -m644 deploy/identitee-explorer.service /etc/systemd/system/`, then
   `sudo systemctl daemon-reload && sudo systemctl enable --now identitee-explorer`.
5. nginx and TLS with `deploy/nginx-explorer-api.conf`, as for the RPC host
   (`certbot --nginx -d explorer-api.identit.ee`).
6. Front: build and deploy as in [explorer/README.md](../explorer/README.md).
7. Check: `curl -s https://<api host>/api/status` returns the heads and `"node":"up"`. While the first
   catch-up runs, `indexed` climbs towards `finalized`; the explorer is complete when they are within
   a few blocks of each other.

Configuration is by environment variables. The unit sets the defaults; to change one, create
`/etc/identitee/explorer.env` (644, owner root; no secret goes in it). systemd reads it as root when it
exists, and its values win over the unit's. `systemctl restart identitee-explorer` applies a change.

| Variable | Default | Meaning |
|---|---|---|
| `EXPLORER_NODE` | `ws://127.0.0.1:9944` | the node's RPC endpoint |
| `EXPLORER_PORT`, `EXPLORER_HOST` | `8788`, `127.0.0.1` | where the API listens; nginx proxies to it |
| `EXPLORER_DB` | `/var/lib/identitee-explorer/explorer.db` | the SQLite file |
| `EXPLORER_ORIGIN` | `https://explorer.identit.ee` | the browser origin allowed by CORS: set it to your front's |
| `EXPLORER_LABELS` | none | a JSON file naming validator keys (below) |

Validator labels: `EXPLORER_LABELS=/etc/identitee/explorer-labels.json` in `explorer.env`, and the file
maps the hexadecimal public keys of the validators (the Aura and GRANDPA keys of `public-keys.json`) to
a display name of 1 to 64 characters. Unlike `explorer.env`, this file is opened by the service itself,
as `identitee-explorer`, so it must be 644 (owner root) and `/etc/identitee` must be traversable by
other users, as it already is for the node's chain spec; only `secrets/` is 700:

```json
{
  "0x<64 hexadecimal digits>": "validator-01"
}
```

Without it blocks show the bare key. The file is read at startup, and a restart applies a change. The
service refuses to start, and says why, if the file is not valid JSON, if a key is not 32 bytes of
hexadecimal, or if a label is empty or too long. Keys and labels are public; keep the file out of the
repository.

The database is derived data, so it is not in the backup (`deploy/backup.sh` archives
`/etc/identitee`, hence the two optional files, and no explorer state). To rebuild it, stop the
service, delete `explorer.db` with its `-wal` and `-shm` files, and start it: the service indexes from
genesis again. The API answers meanwhile with what is indexed so far.

```bash
sudo systemctl stop identitee-explorer
sudo rm -f /var/lib/identitee-explorer/explorer.db*
sudo systemctl start identitee-explorer
```

The service rebuilds its index by itself when the node no longer serves the indexed chain: after a
chain reset (see "Resetting the chain"), or after the node was restored from an archive and built other
blocks than the index holds (see "Restoring"). It checks the chain at startup and each time it
reconnects to the node (block 0, and the hash of the highest block both have), and checks that each new
block's parent is the indexed block before it. On a mismatch it logs `chain_changed`, marks the
database, stops and exits 1; systemd starts it again 15 s later (`Restart=on-failure`), and the new
start moves the old file aside as `explorer.db.<first 8 hex digits of the old genesis>.bak` and indexes
the chain from block 0. The API is down for those 15 s, then serves the new index as it grows. The old
history is not browsable; delete the `.bak` file when it is no longer wanted.

nginx limits each address to 10 requests per second (bursts of 40, then 429) and to 10 open live
streams, and refuses any method other than GET. The streams (`/api/live`) are not buffered, and the
comment line the service sends every 20 s keeps them from idling out; the service also caps all streams
together at 1000. CORS is the service's: it allows `EXPLORER_ORIGIN` only.

Logs are one JSON object per line (`journalctl -u identitee-explorer -o cat`). Startup:
`listening`, `connected` (genesis), `catch_up` (from, to), then `indexed` every 1000 blocks and
`caught_up`. Lines to act on:

| Event | Meaning |
|---|---|
| `fatal` | The service could not start (port taken, database not writable) and exited |
| `indexer_failed` | Catch-up was interrupted; retried with a wait that doubles from 1 s to 30 s |
| `ingest_failed` | One block could not be decoded or stored; retried with a growing wait. A block that keeps failing holds the index at that block, and the message says why |
| `chain_changed` | The node serves other blocks than the index (reset or restore): the database is marked and the service exits 1, to be started again by systemd |
| `stopping` with `runtime_upgraded` | The node runs a new runtime: the service exits 1 and systemd starts it again on it (see "Runtime upgrades and the services") |
| `genesis_changed` | At startup, after a `chain_changed` or with a node on another genesis: the old index was moved aside and a new one started |
| `request_failed` | An API request ended in an internal error (the client gets a 500) |
| `live_read_failed` | A read from the node failed while it was reachable (a decoding error, a state the node no longer keeps); the answer leaves that part null. Logged at most once a minute per message |

A node restart does not need an explorer restart: polkadot.js reconnects, and `/api/status` says
`"node": "down"` meanwhile, with `best` and `finalized` null (unknown) and `indexed` as it was, while
the indexed data keeps being served. The routes that need live state
answer 503 `node_down` (authorities, network), or leave balance, identity and roles null (account),
until it is back.

Self-test, no network, on a throwaway `--dev --tmp` node:

```bash
cd tools && IDENTITEE_NODE_BIN=<path to identitee-node> npm run explorer:selftest    # explorer self-test: ok
```

## Backups

`deploy/backup.sh`, installed as `/usr/local/sbin/identitee-backup` (750 root), runs from
`identitee-backup.timer` daily at 04:00 Europe/Paris with no catch-up; set the time zone in the timer to
suit. Each run:

1. fails at once, stopping nothing, if the root filesystem is more than 80 % full: feeless transactions
   can grow the chain, and a full disk stops the node;
2. records the best and finalized blocks (number and hash);
3. stops the verifier, the migrator and the node (a RocksDB database or SQLite file copied while
   written is not a backup; units not installed are skipped);
4. archives `/var/lib/identitee`, `/etc/identitee` (secrets included) and `/var/lib/identitee-verifier`
   with `tar --zstd`;
5. restarts the services, also on failure, about one second of downtime;
6. checks that the archive decompresses and contains the database, keystore, network key, chain spec,
   public keys, secrets and verifier state;
7. writes `identitee-YYYYMMDD.tar.zst` with `.sha256` and `.info` (the blocks of step 2) in
   `/var/backups/identitee/`, files 600, and keeps the 7 newest.

A failed run starts `identitee-backup-failed.service`, which writes the failure time to
`/var/backups/identitee/LAST_FAILURE`; the next successful run removes it. That marker is the alert.

```bash
systemctl list-timers identitee-backup.timer
sudo systemctl start identitee-backup                 # by hand; overwrites the day's archive
sudo cat /var/backups/identitee/LAST_FAILURE 2>/dev/null || echo "no failure pending"
sudo journalctl -u identitee-backup -o cat -n 30
```

The explorer's database is not archived: it is derived from the chain and indexed again when missing.

The archives contain secret phrases in clear: copy them off the server to encrypted storage only, and
check the copy:

```bash
sha256sum -c identitee-YYYYMMDD.tar.zst.sha256 && tar --zstd -tf identitee-YYYYMMDD.tar.zst | grep -x etc/identitee/secrets/session.phrase
```

## Restoring

Restoring an archive loses the blocks produced since it was taken: with one validator, nobody else has
them.

1. Check the archive: `sha256sum -c identitee-YYYYMMDD.tar.zst.sha256`, and read its `.info`.
2. On a new server: create the four system users, install the binary, Node.js and the tools.
3. Stop the services and extract (paths in the archive are relative to `/`):

   ```bash
   sudo systemctl stop identitee-explorer identitee-verifier identitee-migrator identitee-node
   sudo mv /var/lib/identitee /var/lib/identitee.broken-$(date +%F)                     # if present
   sudo mv /var/lib/identitee-verifier /var/lib/identitee-verifier.broken-$(date +%F)   # if present
   sudo rm -f /var/lib/identitee-explorer/explorer.db*                                  # if present
   sudo tar --zstd -xpf /tmp/identitee-YYYYMMDD.tar.zst -C /
   sudo chown -R identitee:identitee /var/lib/identitee && sudo chmod 750 /var/lib/identitee
   [ -d /var/lib/identitee-verifier ] && sudo chown -R identitee-verifier:identitee-verifier /var/lib/identitee-verifier \
     && sudo chmod 700 /var/lib/identitee-verifier
   sudo chown -R root:root /etc/identitee && sudo chmod 700 /etc/identitee/secrets
   sudo shred -u /tmp/identitee-YYYYMMDD.tar.zst
   ```

4. Compare the public keys with `public-keys.json` (see "Keys and secrets"). Reinsert the session keys
   only if the keystore is missing.
5. Install the units, the backup script and the timer, then
   `sudo systemctl daemon-reload && sudo systemctl enable --now identitee-node identitee-migrator identitee-verifier identitee-explorer identitee-backup.timer`;
   set up nginx and TLS. The explorer is not in the archive and step 3 removed its old index: it
   indexes the restored chain from genesis. (An index kept by mistake would be detected and rebuilt
   anyway, see "The explorer".)
6. Check that the node resumes from the block in `.info` and finalizes, that both agents log their
   capabilities, and that `check-testnet.ts` returns `RESULT OK`.

To test an archive without touching the running node, start a non-validating node on a copy, with no
peers and other ports, and compare its best and finalized heads with `.info`:

```bash
R=/var/tmp/identitee-restore-test
sudo install -d -m 700 -o identitee -g identitee $R
sudo tar --zstd -xf /var/backups/identitee/identitee-YYYYMMDD.tar.zst -C $R
sudo chown -R identitee:identitee $R/var/lib/identitee
sudo -u identitee /usr/local/bin/identitee-node --chain $R/etc/identitee/identitee-testnet-raw.json \
  --base-path $R/var/lib/identitee --node-key-file $R/var/lib/identitee/node-key \
  --listen-addr /ip4/127.0.0.1/tcp/30555 --reserved-only --no-mdns --no-telemetry --no-prometheus \
  --rpc-port 9955 --rpc-methods safe --state-pruning archive --blocks-pruning archive
# chain_getHeader and chain_getFinalizedHead on 127.0.0.1:9955, then stop it and: sudo rm -rf $R
```

## Monitoring

Nothing is automatic. Check by hand:

- `npx tsx src/check-testnet.ts` from a checkout of `tools/`: best and finalized blocks advance within
  12 s and the chain properties are right; its last line is `RESULT OK|FAIL ...` and its exit code is 0
  only on success;
- `systemctl is-active identitee-node identitee-migrator identitee-verifier identitee-explorer`,
  `curl -s https://<verify host>/api/health` and `curl -s https://<api host>/api/status` (`node` is
  `up`, `indexed` within a few blocks of `finalized`);
- the backup marker `LAST_FAILURE`;
- certificate expiry: `sudo certbot certificates`.

## Resetting the chain

A new genesis is a different chain: every identity and balance disappears, and wallets must forget the
old chain.

1. Edit the preset if needed, build, and regenerate the raw chain spec on the build machine:

   ```bash
   deploy/build-release.sh
   target-trixie/release/identitee-node build-spec --chain identitee_testnet --raw \
     --disable-default-bootnode > deploy/chainspec/identitee-testnet-raw.json
   ```

   Without `--disable-default-bootnode`, `build-spec` adds the localhost bootnode of a throwaway node.
   `bootNodes` is not part of the genesis, so removing it does not change the genesis hash.
2. Deploy the binary and chain spec, then erase the database; the keystore and network key stay:

   ```bash
   sudo systemctl stop identitee-node
   sudo install -m755 /tmp/identitee-node /usr/local/bin/
   sudo install -m644 /tmp/identitee-testnet-raw.json /etc/identitee/
   sudo -u identitee /usr/local/bin/identitee-node purge-chain -y \
     --chain /etc/identitee/identitee-testnet-raw.json --base-path /var/lib/identitee
   sudo systemctl start identitee-node
   ```

3. Restart the migrator and the verifier, or reinstall the tools if they changed with the runtime. Both
   agents must exist in the new genesis: each checks its capabilities at startup and stops otherwise.
4. Commit the new chain spec.

The explorer rebuilds its index by itself after a reset (see "The explorer"): it logs `chain_changed`,
exits 1, and once systemd has started it again it moves the old index aside and indexes the new chain.
Check with `curl -s https://<api host>/api/status` that `genesis` is the new hash and `indexed` climbs.

The verifier's `verifier.db` survives a reset, including the register of KYC documents (one document,
one address). To start afresh, stop the verifier and move `verifier.db` aside; the `.key` files and
`matrix/` can stay.

Changing the session keys of the operator's validator needs no new genesis: insert the new keys in
the keystore, then register them with `session.setKeys` from the sudo account (proof from
`author_rotateKeysWithOwner`) or `sudo(validators.addValidator)` on a fresh account. They take effect
two sessions later; keep the old keys in the keystore until then. `TESTNET_AURA` and `TESTNET_GRANDPA`
only matter for a new genesis.
