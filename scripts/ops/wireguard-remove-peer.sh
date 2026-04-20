#!/usr/bin/env bash
#
# Remove a WireGuard peer: drop the [Peer] block from wg0.conf, reload
# the in-kernel config, shred any remaining server-side key material.
#
# Typical use cases:
#   - Peer device lost or stolen; rotate by running this then add-peer.sh again.
#   - Aborted onboarding (no handshake within ~5 min per ADR-0008).
#   - Access revocation.
#
# The peer's public key file (peers/<name>.pubkey) is preserved for the
# audit trail. Delete manually if your retention policy requires purging.
#
# Usage (as root, on the VPS):
#
#   sudo /opt/projekt-manager/scripts/ops/wireguard-remove-peer.sh <peer-name>
#
# Assumes the peer's [Peer] block follows the standard 4-line format
# emitted by wireguard-add-peer.sh (`# <name> added <date>`, `[Peer]`,
# `PublicKey`, `AllowedIPs`). Hand-edited blocks with additional fields
# (e.g. `PresharedKey`) will leave orphan lines behind — inspect wg0.conf
# afterwards in that case.
#
set -euo pipefail

WG_DIR=/etc/wireguard
WG_CONF="$WG_DIR/wg0.conf"
PEERS_DIR="$WG_DIR/peers"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <peer-name>

  peer-name   identifier used when the peer was added (see add-peer.sh).

List current peers with:
  sudo grep -E '^# .* added ' $WG_CONF
EOF
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

PEER_NAME="$1"

# --- Input validation -------------------------------------------------------

if ! [[ "$PEER_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ERROR: peer-name '$PEER_NAME' invalid; must match [a-z0-9][a-z0-9-]*" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (use sudo)" >&2
  exit 1
fi

if [ ! -s "$WG_CONF" ]; then
  echo "ERROR: $WG_CONF missing or empty" >&2
  exit 1
fi

if ! grep -qE "^# ${PEER_NAME} added " "$WG_CONF"; then
  echo "ERROR: peer '$PEER_NAME' not found in $WG_CONF" >&2
  exit 1
fi

# --- Rewrite wg0.conf without the peer's block ------------------------------
# The awk buffers each line in `prev_line` so that when the target marker is
# seen, the immediately-preceding blank separator can be discarded together
# with the block. This preserves the single-blank-between-blocks invariant
# whether the removed peer is the first, last, or middle one.

CONF_BACKUP=$(mktemp "/tmp/wg0.conf.backup.XXXXXX")
cp "$WG_CONF" "$CONF_BACKUP"

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -f "$CONF_BACKUP" ]; then
    echo "FAIL(rc=$rc): restoring $WG_CONF from backup" >&2
    cp "$CONF_BACKUP" "$WG_CONF"
    wg syncconf wg0 <(wg-quick strip wg0) 2>/dev/null || true
  fi
  [ -f "$CONF_BACKUP" ] && rm -f "$CONF_BACKUP"
}
trap cleanup EXIT

NEW_CONF=$(awk -v name="$PEER_NAME" '
  BEGIN { marker = "# " name " added "; skip = 0; have_prev = 0 }
  {
    if (skip > 0) { skip--; next }
    if (index($0, marker) == 1) {
      if (have_prev && prev_line != "") print prev_line
      have_prev = 0
      skip = 3
      next
    }
    if (have_prev) print prev_line
    prev_line = $0
    have_prev = 1
  }
  END { if (have_prev) print prev_line }
' "$WG_CONF")

printf '%s\n' "$NEW_CONF" > "$WG_CONF"
chmod 600 "$WG_CONF"

# --- Reload in-kernel config ------------------------------------------------

wg syncconf wg0 <(wg-quick strip wg0)

# --- Post-condition: peer must no longer be active --------------------------
# If the pubkey file is still on disk, use it to assert the kernel no
# longer lists this peer. Absence of the file (expected after the
# add-peer post-handshake shred) makes the check a no-op.

PUBKEY_FILE="$PEERS_DIR/${PEER_NAME}.pubkey"
if [ -f "$PUBKEY_FILE" ]; then
  PEER_PUB=$(cat "$PUBKEY_FILE")
  if wg show wg0 peers | grep -qF "$PEER_PUB"; then
    echo "ERROR: peer still active in kernel after syncconf" >&2
    exit 1
  fi
fi

# --- Shred any remaining key material --------------------------------------
# Keep the .pubkey for audit trail. If the post-handshake shred in
# add-peer.sh was already performed, these files are absent — skip quietly.

for f in "$PEERS_DIR/${PEER_NAME}.privkey" "$PEERS_DIR/${PEER_NAME}.conf"; do
  if [ -f "$f" ]; then
    shred -u "$f" 2>/dev/null || rm -f "$f"
    echo "Shredded $f"
  fi
done

echo
echo "Peer '${PEER_NAME}' removed from $WG_CONF."
if [ -f "$PUBKEY_FILE" ]; then
  echo "Public key retained at $PUBKEY_FILE (audit trail)."
fi
