#!/usr/bin/env bash
# Nightly backup of an identitee node server, installed as /usr/local/sbin/identitee-backup and
# run by identitee-backup.timer (deploy/identitee-backup.{service,timer}). See docs/OPERATIONS.md.
#
# Stops the verifier, the migrator and the node (a RocksDB or a SQLite file copied while it is written
# is not a backup), archives /var/lib/identitee (chain database, keystore, node key),
# /var/lib/identitee-verifier (verifier.db, its HMAC keys, the Matrix bot's session and crypto store;
# when it exists) and /etc/identitee (chain spec, public keys, SECRETS) into
# /var/backups/identitee/identitee-YYYYMMDD.tar.zst (600 root, dir 700), starts them again, checks
# the archive, and keeps the 7 newest. Next to each archive:
#   .sha256  checksum, to check a copy taken off the server by hand
#   .info    best and finalized block (number and hash) just before the stop, to check a restore
# On success it removes /var/backups/identitee/LAST_FAILURE, which identitee-backup-failed.service
# (OnFailure= of identitee-backup.service) writes when a run fails.
#
# Disk guard: it fails (and so writes LAST_FAILURE) without stopping anything when the root
# filesystem is more than MAX_ROOT_USE % used. On the testnet the chain can grow from free
# transactions (spam), and the database, the archives and the system share one disk: a full
# disk stops the node. The alert is the failed backup; the 7 archives already there stay.
set -euo pipefail

DEST=/var/backups/identitee
KEEP=7
STAMP="$(date -u +%Y%m%d)"
NAME="identitee-$STAMP.tar.zst"
ARCHIVE="$DEST/$NAME"
SERVICES=(identitee-verifier identitee-migrator identitee-node) # stop order; started in reverse
VERIFIER_STATE=var/lib/identitee-verifier
MAX_ROOT_USE=80 # percent of the root filesystem

used="$(df --output=pcent / | tail -n 1 | tr -dc '0-9')"
if [[ -z "$used" ]] || ((used > MAX_ROOT_USE)); then
	echo "ERROR: root filesystem ${used:-?} % used (over $MAX_ROOT_USE %): no backup taken, nothing stopped. Free space or grow the disk (docs/OPERATIONS.md, Backups)." >&2
	exit 1
fi

umask 077
install -d -m 700 -o root -g root "$DEST"

rpc() {
	curl -fsS --max-time 5 -H 'Content-Type: application/json' \
		-d "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":[${2:-}]}" http://127.0.0.1:9944 \
		| jq -r "$3"
}

# Where the chain stands when it stops (best effort: a node already down still gets backed up).
info="$(
	set +e
	best_hash="$(rpc chain_getBlockHash '' .result)"
	best="$(rpc chain_getHeader "\"$best_hash\"" .result.number)"
	fin_hash="$(rpc chain_getFinalizedHead '' .result)"
	fin="$(rpc chain_getHeader "\"$fin_hash\"" .result.number)"
	printf 'best=%d best_hash=%s finalized=%d finalized_hash=%s\n' "$best" "$best_hash" "$fin" "$fin_hash"
)" || info="unknown (node not answering before the stop)"

# Start again whatever happens below: a failed backup must not leave the testnet down. A service
# is started again if it is enabled or was running, including `activating` (waiting for an
# automatic restart after a crash): stopping it cancels that restart.
to_start=()
for s in "${SERVICES[@]}"; do
	state="$(systemctl show -p ActiveState --value "$s")"
	if systemctl is-enabled --quiet "$s" || [[ "$state" == active || "$state" == activating || "$state" == reloading ]]; then
		to_start+=("$s")
	fi
done
restart() {
	local i
	for ((i = ${#to_start[@]} - 1; i >= 0; i--)); do
		systemctl start "${to_start[$i]}" || echo "ERROR: could not start ${to_start[$i]}" >&2
	done
	to_start=()
}
cleanup() {
	restart
	rm -f -- "$ARCHIVE.part" # a half-written archive (it holds the secrets) is never left behind
}
trap cleanup EXIT

# A unit not installed on this host is skipped: stopping it would fail the backup.
installed=()
for s in "${SERVICES[@]}"; do
	[[ "$(systemctl show -p LoadState --value "$s")" == loaded ]] && installed+=("$s")
done
systemctl stop "${installed[@]}"
echo "stopped ${installed[*]} at $(date -u +%FT%TZ); chain: $info"
paths=(var/lib/identitee etc/identitee)
[[ -d "/$VERIFIER_STATE" ]] && paths+=("$VERIFIER_STATE")
tar --zstd -cf "$ARCHIVE.part" -C / "${paths[@]}"
restart
echo "services started again at $(date -u +%FT%TZ)"

# Check the archive before it replaces anything: it decompresses, and holds what a restore needs.
listing="$(tar --zstd -tf "$ARCHIVE.part")"
for needed in \
	var/lib/identitee/node-key \
	var/lib/identitee/chains/identitee_testnet/keystore/ \
	var/lib/identitee/chains/identitee_testnet/db/ \
	etc/identitee/identitee-testnet-raw.json \
	etc/identitee/public-keys.json \
	etc/identitee/secrets/session.phrase \
	etc/identitee/secrets/migrator.phrase \
	etc/identitee/secrets/node-key; do
	grep -qxF "$needed" <<<"$listing" || { echo "ERROR: $needed missing from the archive" >&2; exit 1; }
done
# The verifier's state, once it exists (its database once the service has made it).
verifier_needed=()
[[ -d "/$VERIFIER_STATE" ]] && verifier_needed+=("$VERIFIER_STATE/")
[[ -f "/$VERIFIER_STATE/verifier.db" ]] && verifier_needed+=("$VERIFIER_STATE/verifier.db")
for needed in "${verifier_needed[@]}"; do
	grep -qxF "$needed" <<<"$listing" || { echo "ERROR: $needed missing from the archive" >&2; exit 1; }
done
mv -f "$ARCHIVE.part" "$ARCHIVE"
(cd "$DEST" && sha256sum "$NAME" >"$NAME.sha256")
echo "$info" >"$ARCHIVE.info"
chmod 600 "$ARCHIVE" "$ARCHIVE.sha256" "$ARCHIVE.info"
echo "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1), $(wc -l <<<"$listing") entries)"

# Keep the KEEP newest archives (names sort by date).
mapfile -t old < <(printf '%s\n' "$DEST"/identitee-*.tar.zst | sort -r | tail -n +$((KEEP + 1)))
for f in "${old[@]}"; do
	rm -f -- "$f" "$f.sha256" "$f.info"
	echo "removed $f"
done
rm -f "$DEST/LAST_FAILURE"
