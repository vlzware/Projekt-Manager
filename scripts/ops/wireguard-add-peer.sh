#!/usr/bin/env bash
#
# Add a WireGuard peer: generate keypair, append to wg0.conf, reload the
# in-kernel config, emit client .conf + QR for mobile import.
# Repeatable — run once per peer.
#
# Per ADR-0008 (docs/adr/0008-vpn-first-network-access.md): keys are
# generated server-side, the resulting config is distributed via Signal
# or in-person.
#
# Usage (as root, on the VPS):
#
#   sudo /opt/projekt-manager/scripts/ops/wireguard-add-peer.sh \
#        <peer-name> <peer-ip> <server-endpoint>
#
#   sudo /opt/projekt-manager/scripts/ops/wireguard-add-peer.sh \
#        vladimir-pixel 10.213.17.10 203.0.113.5:51820
#
# Arguments:
#   peer-name         DNS-safe identifier ([a-z0-9][a-z0-9-]*); used as filename.
#   peer-ip           /32 inside 10.213.17.0/24 (last octet 2-254,
#                     not already allocated — check `sudo wg show wg0`).
#   server-endpoint   public host:port as seen by peers (usually <public-ip>:51820).
#
# Side effects (all under /etc/wireguard, root:root, 0700/0600):
#   - peers/<name>.privkey, peers/<name>.pubkey
#   - peers/<name>.conf     (client config)
#   - append [Peer] block to wg0.conf
#   - in-kernel config reloaded via `wg syncconf`
#
# Partial failures are rolled back (keys shredded, wg0.conf restored,
# in-kernel state re-synced) so a retry with the same arguments is clean.
#
# After the peer confirms connectivity over the VPN:
#
#   # verify handshake (expect a recent Unix timestamp)
#   sudo wg show wg0 latest-handshakes \
#     | grep -F "$(sudo cat /etc/wireguard/peers/<name>.pubkey)"
#
#   # shred ephemeral key material (keep .pubkey for audit trail)
#   sudo shred -u /etc/wireguard/peers/<name>.conf
#   sudo shred -u /etc/wireguard/peers/<name>.privkey
#
set -euo pipefail

WG_DIR=/etc/wireguard
WG_CONF="$WG_DIR/wg0.conf"
PEERS_DIR="$WG_DIR/peers"
SERVER_PUBKEY_FILE="$WG_DIR/server.pubkey"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <peer-name> <peer-ip> <server-endpoint>

  peer-name         DNS-safe, [a-z0-9][a-z0-9-]* (e.g. vladimir-pixel)
  peer-ip           10.213.17.N where N in 2-254 (e.g. 10.213.17.10)
  server-endpoint   public host:port (e.g. 203.0.113.5:51820)

See header of this script for post-handshake verification/cleanup steps.
EOF
}

if [ "$#" -ne 3 ]; then
  usage
  exit 1
fi

PEER_NAME="$1"
PEER_IP="$2"
SERVER_ENDPOINT="$3"

# --- Input validation -------------------------------------------------------

if ! [[ "$PEER_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ERROR: peer-name '$PEER_NAME' invalid; must match [a-z0-9][a-z0-9-]*" >&2
  exit 1
fi

# 10.213.17.N where N in 2-254. Reject .0 (network), .1 (server), .255 (broadcast).
if ! [[ "$PEER_IP" =~ ^10\.213\.17\.([0-9]{1,3})$ ]]; then
  echo "ERROR: peer-ip '$PEER_IP' must be in 10.213.17.0/24" >&2
  exit 1
fi
LAST_OCTET="${BASH_REMATCH[1]}"
if (( LAST_OCTET < 2 || LAST_OCTET > 254 )); then
  echo "ERROR: peer-ip '$PEER_IP' last octet must be 2-254" >&2
  exit 1
fi

if ! [[ "$SERVER_ENDPOINT" =~ ^[^:[:space:]]+:[0-9]+$ ]]; then
  echo "ERROR: server-endpoint '$SERVER_ENDPOINT' must be host:port" >&2
  exit 1
fi

# --- Must run as root -------------------------------------------------------
# Reads server.pubkey and writes to /etc/wireguard (mode 0700 root:root).

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (use sudo)" >&2
  exit 1
fi

# --- Preflight: server must already be initialised --------------------------

for f in "$WG_CONF" "$SERVER_PUBKEY_FILE"; do
  if [ ! -s "$f" ]; then
    echo "ERROR: $f missing or empty — run wireguard-server-init.sh first" >&2
    exit 1
  fi
done

# --- Duplicate guards -------------------------------------------------------
# A repeat with the same name or IP would silently overwrite keys and lock
# out the existing peer. Refuse rather than recover.

if grep -qE "^# ${PEER_NAME} added " "$WG_CONF"; then
  echo "ERROR: peer '$PEER_NAME' already present in $WG_CONF" >&2
  exit 1
fi
if grep -qE "^AllowedIPs[[:space:]]*=[[:space:]]*${PEER_IP}/32[[:space:]]*$" "$WG_CONF"; then
  echo "ERROR: IP '$PEER_IP' already allocated in $WG_CONF" >&2
  exit 1
fi
for f in "$PEERS_DIR/${PEER_NAME}.privkey" \
         "$PEERS_DIR/${PEER_NAME}.pubkey" \
         "$PEERS_DIR/${PEER_NAME}.conf"; do
  if [ -e "$f" ]; then
    echo "ERROR: stale key material for '$PEER_NAME' at $f" >&2
    exit 1
  fi
done

# --- Rollback trap ----------------------------------------------------------
# Track progress so cleanup removes exactly the right artifacts. A partial
# run that wrote keys but failed before `wg syncconf` would otherwise leave
# orphaned privkey material on disk and a phantom [Peer] block in wg0.conf.

CONF_BACKUP=""
KEYS_CREATED=0
CONF_APPENDED=0
PEER_CONF_CREATED=0

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL(rc=$rc): rolling back partial changes" >&2
    if [ "$PEER_CONF_CREATED" -eq 1 ] && [ -f "$PEERS_DIR/${PEER_NAME}.conf" ]; then
      shred -u "$PEERS_DIR/${PEER_NAME}.conf" 2>/dev/null || rm -f "$PEERS_DIR/${PEER_NAME}.conf"
    fi
    if [ "$CONF_APPENDED" -eq 1 ] && [ -n "$CONF_BACKUP" ] && [ -f "$CONF_BACKUP" ]; then
      cp "$CONF_BACKUP" "$WG_CONF"
      wg syncconf wg0 <(wg-quick strip wg0) 2>/dev/null || true
    fi
    if [ "$KEYS_CREATED" -eq 1 ]; then
      for f in "$PEERS_DIR/${PEER_NAME}.privkey" "$PEERS_DIR/${PEER_NAME}.pubkey"; do
        [ -f "$f" ] && { shred -u "$f" 2>/dev/null || rm -f "$f"; }
      done
    fi
  fi
  [ -n "$CONF_BACKUP" ] && [ -f "$CONF_BACKUP" ] && rm -f "$CONF_BACKUP"
}
trap cleanup EXIT

# --- Generate keypair -------------------------------------------------------

mkdir -p "$PEERS_DIR"
chmod 700 "$PEERS_DIR"
(
  cd "$WG_DIR"
  umask 077
  wg genkey | tee "peers/${PEER_NAME}.privkey" | wg pubkey > "peers/${PEER_NAME}.pubkey"
)
KEYS_CREATED=1

PEER_PUB=$(cat "$PEERS_DIR/${PEER_NAME}.pubkey")
SERVER_PUB=$(cat "$SERVER_PUBKEY_FILE")

# --- Append [Peer] to wg0.conf ---------------------------------------------

CONF_BACKUP=$(mktemp "/tmp/wg0.conf.backup.XXXXXX")
cp "$WG_CONF" "$CONF_BACKUP"

tee -a "$WG_CONF" > /dev/null <<EOF

# ${PEER_NAME} added $(date -I)
[Peer]
PublicKey  = ${PEER_PUB}
AllowedIPs = ${PEER_IP}/32
EOF
CONF_APPENDED=1

# --- Reload in-kernel config ------------------------------------------------

wg syncconf wg0 <(wg-quick strip wg0)

# --- Generate client config -------------------------------------------------

PEER_CONF="$PEERS_DIR/${PEER_NAME}.conf"
( umask 077 && tee "$PEER_CONF" > /dev/null <<EOF
[Interface]
PrivateKey = $(cat "$PEERS_DIR/${PEER_NAME}.privkey")
Address    = ${PEER_IP}/32

[Peer]
PublicKey           = ${SERVER_PUB}
Endpoint            = ${SERVER_ENDPOINT}
AllowedIPs          = 10.213.17.0/24
PersistentKeepalive = 25
EOF
)
PEER_CONF_CREATED=1

# --- Output -----------------------------------------------------------------

echo
echo "Peer '${PEER_NAME}' added: ${PEER_IP}/32"
echo
echo "QR code for mobile import:"
qrencode -t ansiutf8 < "$PEER_CONF"
echo
echo "Next steps:"
echo "  1. Deliver ${PEER_CONF} to the peer (Signal or in-person)."
echo "  2. After the peer connects, verify handshake:"
echo "       sudo wg show wg0 latest-handshakes | grep -F '${PEER_PUB}'"
echo "  3. Shred ephemeral key material (keep .pubkey for audit trail):"
echo "       sudo shred -u ${PEER_CONF}"
echo "       sudo shred -u ${PEERS_DIR}/${PEER_NAME}.privkey"
echo "  4. If no handshake within ~5 min, remove the [Peer] block from"
echo "     ${WG_CONF}, reload (sudo wg syncconf wg0 <(sudo wg-quick strip wg0)),"
echo "     then re-run this script."
