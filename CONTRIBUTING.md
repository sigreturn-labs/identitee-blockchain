# Contributing

Thank you for your interest in identitee. This page explains how changes are proposed and what a
pull request needs before it can be merged.

## Workflow

1. Open an issue first for anything beyond a small fix, and for any change to runtime storage, a
   call signature or a commitment formula: those affect the live testnet.
2. Branch from an up-to-date `master` and keep the pull request about one thing.
3. A maintainer reviews it. Address comments with new commits on the same branch.
4. The maintainer merges once the review is approved and the checks below pass locally.

## Commits

- Every commit is signed (GPG or SSH signing).
- The message is one short line in English that says what changed, for example `Fix sub-account
  quota`.
- Never commit secrets: `.env` files, seed phrases, node keys, API tokens.

## Checks

Chain:

    cargo fmt --all --check
    cargo clippy --workspace --all-targets
    cargo test --workspace

Web front (`web/`) and tools (`tools/`), with Node.js 24:

    npm ci
    npm run typecheck
    npm test

The web front also needs `npm run build` to pass. End-to-end scenarios run against a local `--dev`
node. Never point a test that writes at the public testnet.

## Changes that need extra care

- Runtime: a change to call indices, storage layout or a commitment formula needs a
  `spec_version` bump and a note on how the testnet is migrated or reset. Call indices are pinned
  by `runtime/tests/call_indices.rs`.
- Commitments: the formulas are tested against frozen vectors on both sides,
  `pallets/identitee/src/tests/vectors.rs` and `web/test/formulas.test.ts`. Update both in the same
  pull request.
- Private fields: a private value, its salt or the identity secret must never reach a server, be
  stored in clear or be logged.
- Web front: all interface text is in English.

## Licensing of contributions

identitee is released under the GNU Affero General Public License v3.0. By submitting a
contribution, you agree that it is licensed under the same terms, and you grant Sigreturn Labs SAS
a perpetual, worldwide, non-exclusive, royalty-free and irrevocable license to use, modify and
distribute your contribution under other license terms as well. You confirm that you have the
right to grant this license.

## Security

Do not open a public issue for a vulnerability. Report it through GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability"), or write to
contact@sigreturn.com.
