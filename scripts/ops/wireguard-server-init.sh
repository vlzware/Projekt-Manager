#!/usr/bin/env bash
#
# Initialise the WireGuard server on the VPS: install tools, generate the
# server keypair, create /etc/wireguard/wg0.conf, install the systemd
# drop-in that makes docker.service wait for wg-quick@wg0.service, then
# enable and start wg-quick@wg0.
#
# Per ADR-0008 (docs/adr/0008-vpn-first-network-access.md). One-shot, but
# safe to re-run — steps that already produced their artifact are skipped.
#
# Still manual AFTER this script: open UDP/51820 in the Hetzner Cloud
# Firewall. The VPN is dead on the wire until the datagram can reach the
# host.
#
# Usage (as root, on a freshly-provisioned VPS with the repo cloned at
# /opt/projekt-manager):
#
#   sudo /opt/projekt-manager/scripts/ops/wireguard-server-init.sh
#
set -euo pipefail

WG_DIR=/etc/wireguard
WG_CONF="$WG_DIR/wg0.conf"
SERVER_PRIVKEY="$WG_DIR/server.privkey"
SERVER_PUBKEY="$WG_DIR/server.pubkey"
SUBNET_CIDR="10.213.17.1/24"
LISTEN_PORT=51820
DOCKER_DROPIN=/etc/systemd/system/docker.service.d/wait-for-wireguard.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (use sudo)" >&2
  exit 1
fi

# --- 1. Install packages ---------------------------------------------------

apt-get update
apt-get install -y wireguard-tools qrencode

# --- 2. Server keypair (skip if present) -----------------------------------

mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

if [ ! -s "$SERVER_PRIVKEY" ]; then
  (
    cd "$WG_DIR"
    umask 077
    wg genkey | tee server.privkey | wg pubkey > server.pubkey
  )
  chmod 600 "$SERVER_PRIVKEY"
  echo "Generated server keypair at $WG_DIR."
else
  echo "Server keypair already present at $SERVER_PRIVKEY — skipping."
  # Defensive: server.pubkey must exist alongside privkey for add-peer.sh.
  if [ ! -s "$SERVER_PUBKEY" ]; then
    wg pubkey < "$SERVER_PRIVKEY" > "$SERVER_PUBKEY"
    echo "Regenerated $SERVER_PUBKEY from existing privkey."
  fi
fi

# --- 3. wg0.conf (skip if present) -----------------------------------------

if [ ! -s "$WG_CONF" ]; then
  tee "$WG_CONF" > /dev/null <<EOF
[Interface]
Address    = ${SUBNET_CIDR}
ListenPort = ${LISTEN_PORT}
PrivateKey = $(cat "$SERVER_PRIVKEY")
EOF
  chmod 600 "$WG_CONF"
  echo "Wrote $WG_CONF."
else
  echo "$WG_CONF already present — skipping."
fi

# --- 4. Docker-waits-for-wg0 systemd drop-in -------------------------------
# Content is deterministic, so overwrite: picks up any future edits to the
# script without needing the operator to hand-edit the drop-in.

mkdir -p "$(dirname "$DOCKER_DROPIN")"
tee "$DOCKER_DROPIN" > /dev/null <<'EOF'
[Unit]
Requires=wg-quick@wg0.service
After=wg-quick@wg0.service
EOF
systemctl daemon-reload
echo "Installed $DOCKER_DROPIN and reloaded systemd."

# --- 5. Enable & start wg-quick@wg0 ----------------------------------------

systemctl enable --now wg-quick@wg0.service

# --- 6. Verify --------------------------------------------------------------

echo
echo "Verification:"

if ! ip -4 addr show wg0 2>/dev/null | grep -qF "inet "; then
  echo "ERROR: wg0 has no IPv4 address" >&2
  exit 1
fi
echo "  wg0 IPv4              OK"

if [ "$(systemctl is-active wg-quick@wg0.service)" != "active" ]; then
  echo "ERROR: wg-quick@wg0.service not active" >&2
  systemctl status wg-quick@wg0.service --no-pager || true
  exit 1
fi
echo "  wg-quick@wg0 active   OK"

if ! systemctl list-dependencies docker.service 2>/dev/null | grep -qF wg-quick@wg0.service; then
  echo "ERROR: docker.service does not depend on wg-quick@wg0.service" >&2
  exit 1
fi
echo "  docker waits for wg0  OK"

if ! ss -ulnp 2>/dev/null | grep -qF ":${LISTEN_PORT}"; then
  echo "ERROR: not listening on UDP/${LISTEN_PORT}" >&2
  exit 1
fi
echo "  listening on UDP/${LISTEN_PORT}  OK"

echo
echo "Next steps (manual):"
echo "  1. Open UDP/${LISTEN_PORT} in the Hetzner Cloud Firewall."
echo "  2. Onboard peers: scripts/ops/wireguard-add-peer.sh <name> <ip> <endpoint>"
