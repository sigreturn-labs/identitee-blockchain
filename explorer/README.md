# identitee explorer

The block explorer of the identitee chain, served at [explorer.identit.ee](https://explorer.identit.ee).
It shows blocks (with the validator that produced each one), extrinsics decoded into named arguments
and results, events, accounts with their identity and roles, authorities and their attestations,
migrations from the People Chain, usernames, the runtime and the network. Search takes a block number
or hash, an extrinsic hash or `<block>-<index>`, an address and a username.

It is read only: no wallet, no transaction, nothing decrypted. It never talks to the node. Everything
comes from the explorer API (`tools/src/explorer/`, see [tools/README.md](../tools/README.md)), which
indexes the chain, and from a stream of the latest heads.

The page design is that of the identit.ee front: the tokens, styles and shared components are
imported from [`web/src`](../web/README.md) under the alias `@web`, not copied. The explorer has its
own plain background instead of the animated one.

## Stack

- Preact with `preact-iso` for routing, TypeScript, Vite.
- Vitest with happy-dom for tests.
- Node 24. Dependency versions are exact.

## Develop, test, build

```sh
npm ci
npm run dev          # Vite dev server on http://localhost:5174
npm test             # Vitest, no API and no network needed
npm run typecheck    # tsc --noEmit
npm run build        # typecheck, then vite build into dist/
```

Without configuration the app reads the public API (`https://explorer-api.identit.ee`). To work against
your own chain, run a dev node and the indexer, which allows the dev server's origin with
`EXPLORER_DEV=1`, then point the app at it:

```sh
../target/release/identitee-node --dev --tmp --state-pruning archive --blocks-pruning archive
cd ../tools && EXPLORER_DB=./explorer.db EXPLORER_DEV=1 npm run explorer      # API on 127.0.0.1:8788
cd ../explorer && VITE_API=http://127.0.0.1:8788 npm run dev
```

The indexer only follows finalized blocks, and a dev chain finalizes as it produces them. The node
must be an archive node, or the first catch-up fails.

## Configuration

Both variables are read at build time by Vite.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API` | `https://explorer-api.identit.ee` | Base URL of the explorer API |
| `VITE_PROFILE_BASE` | `https://identit.ee` | Where links to an account's profile point |

A different API host must allow the site's origin: set `EXPLORER_ORIGIN` on the service
([docs/OPERATIONS.md](../docs/OPERATIONS.md)).

## Tests

The unit suites replace `fetch` and `EventSource` (`test/support/no-network.ts`) and read synthetic API
answers from `test/fixtures/`, built on development accounts. A test fails if the code reaches for the
real network.

## Deployment

`dist/` is a static site, deployed to Cloudflare Pages. Build it without the variables above to use the
public endpoints, then deploy:

```sh
npm run build
npx wrangler pages project create <project>     # once
npx wrangler pages deploy dist --project-name <project>
```

Then add the site's host as a custom domain of the project (`explorer.identit.ee`, a CNAME to the
Pages project). The site is public, so unlike the identit.ee front it has no password middleware. The
single-page fallback is the `_redirects` file copied from `web/public`, and the favicon comes from the
same folder.

The API it reads is a separate deployment on the node's server: see "The explorer" in
[docs/OPERATIONS.md](../docs/OPERATIONS.md).

## Conventions

The rules of the identit.ee front apply here too.

- All copy is in English. No separator dots and no em dashes in rendered text, and no filler copy.
- Inter is the only font, monospace included.
- One dark theme in black, white and greys only; colours are the tokens of `web/src/ui/tokens.css`.
- Every grid uses `minmax(0, 1fr)` so a long hash or address cannot widen the page.
- Mobile (16 px side gutter, no horizontal scroll) and desktop.

## License

AGPL-3.0-only, see `LICENSE` at the repository root.
