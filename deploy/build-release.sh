#!/usr/bin/env bash
# Build the release identitee-node binary for Debian 13 (trixie).
#
# A binary built on a host with a newer glibc than Debian 13 does not start on a Debian 13 server.
# The build therefore runs in a Debian trixie container with the toolchain pinned in
# rust-toolchain.toml, output in target-trixie/ (gitignored).
#
# Usage: deploy/build-release.sh            -> target-trixie/release/identitee-node
# Env:   CARGO_CACHE (default ~/.cache/identitee-cargo-trixie): cargo registry/git cache, reused.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# A release binary must be the build of a commit: its version string (identitee-node --version)
# carries the commit hash, which says nothing about uncommitted changes. Refuse a dirty tree:
# modified tracked files anywhere, or untracked files among the build inputs.
dirty="$(git -C "$REPO" status --porcelain --untracked-files=no)"
untracked="$(git -C "$REPO" status --porcelain --untracked-files=all -- Cargo.toml Cargo.lock rust-toolchain.toml node runtime pallets | grep '^??' || true)"
if [ -n "$dirty$untracked" ]; then
	echo "refusing to build a release from a dirty tree (commit or stash first):" >&2
	printf '%s\n' "$dirty" "$untracked" | sed '/^$/d' >&2
	exit 1
fi
IMAGE="identitee-build:1.93.0-trixie"
CARGO_CACHE="${CARGO_CACHE:-$HOME/.cache/identitee-cargo-trixie}"
mkdir -p "$CARGO_CACHE" "$REPO/target-trixie"

# Builder image: rust 1.93 on trixie + protoc, clang/libclang, rust-src and the wasm target.
docker build -q -t "$IMAGE" - <<'DOCKERFILE'
FROM rust:1.93.0-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler clang libclang-dev \
 && rm -rf /var/lib/apt/lists/*
RUN rustup component add rust-src rustfmt clippy && rustup target add wasm32v1-none \
 && chmod -R a+rwX /usr/local/rustup /usr/local/cargo
DOCKERFILE

# Run as the calling user so that target-trixie/ and the cache stay owned by them.
docker run --rm \
	--user "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e CARGO_HOME=/cargo-cache -e PATH=/usr/local/cargo/bin:/usr/bin:/bin \
	-e CARGO_TARGET_DIR=/src/target-trixie \
	-v "$CARGO_CACHE:/cargo-cache" \
	-v "$REPO:/src" \
	-w /src \
	"$IMAGE" \
	bash -c 'cargo build --locked --release -p identitee-node --features metadata-hash'

BIN="$REPO/target-trixie/release/identitee-node"
# Check that the binary starts on a bare Debian 13 (shared libraries and glibc symbols).
docker run --rm -v "$BIN:/usr/local/bin/identitee-node:ro" debian:trixie-slim \
	sh -c 'ldd /usr/local/bin/identitee-node && identitee-node --version'
echo "OK: $BIN"
