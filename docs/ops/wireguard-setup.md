# WireGuard Setup

Plain WireGuard (kernel module), no third-party control plane.
See [ADR-0008](../adr/0008-vpn-first-network-access.md).

## Subnet plan

| Item           | Value                            |
| -------------- | -------------------------------- |
| Subnet         | `10.213.17.0/24`                 |
| Server (`wg0`) | `10.213.17.1`                    |
| Peers          | `10.213.17.10+` (one `/32` each) |
| Listen port    | `51820/UDP`                      |

## Server setup

1. Install:

   ```bash
   sudo apt-get install -y wireguard-tools qrencode
   ```

2. Generate server keypair:

   ```bash
   sudo mkdir -p /etc/wireguard
   cd /etc/wireguard
   sudo sh -c 'umask 077 && wg genkey | tee server.privkey | wg pubkey > server.pubkey'
   sudo chmod 600 server.privkey
   ```

3. Create `wg0.conf`:

   ```bash
   sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
   [Interface]
   Address    = 10.213.17.1/24
   ListenPort = 51820
   PrivateKey = $(sudo cat /etc/wireguard/server.privkey)
   EOF
   sudo chmod 600 /etc/wireguard/wg0.conf
   ```

4. Systemd drop-in (Docker must wait for `wg0` or Caddy's port bind fails on cold boot):

   ```bash
   sudo mkdir -p /etc/systemd/system/docker.service.d
   sudo tee /etc/systemd/system/docker.service.d/wait-for-wireguard.conf > /dev/null <<'EOF'
   [Unit]
   Requires=wg-quick@wg0.service
   After=wg-quick@wg0.service
   EOF
   sudo systemctl daemon-reload
   ```

5. Enable and start:

   ```bash
   sudo systemctl enable --now wg-quick@wg0.service
   ```

6. Open UDP/51820 in Hetzner Cloud Firewall.

**Verify:**

```bash
ip -4 addr show wg0                                                          # inet 10.213.17.1/24
systemctl is-active wg-quick@wg0.service                                     # active
systemctl list-dependencies docker.service | grep -F wg-quick@wg0.service    # non-empty
systemctl list-dependencies --reverse wg-quick@wg0.service | grep -F docker  # non-empty
sudo ss -ulnp | grep -F :51820                                               # listening
```

## Peer onboarding

Per [ADR-0008](../adr/0008-vpn-first-network-access.md): keys generated server-side, config distributed via Signal or in-person.

Repeatable -- run once per peer.

For each peer:

```bash
PEER_NAME="<user-device>"          # e.g. vladimir-pixel
PEER_IP="10.213.17.10"             # next /32 from 10.213.17.10+
SERVER_PUB=$(sudo cat /etc/wireguard/server.pubkey)
SERVER_ENDPOINT="<server-public-ip>:51820"

sudo mkdir -p /etc/wireguard/peers
cd /etc/wireguard
sudo sh -c "umask 077 && wg genkey | tee peers/${PEER_NAME}.privkey | wg pubkey > peers/${PEER_NAME}.pubkey"

# Append peer to wg0.conf
sudo tee -a /etc/wireguard/wg0.conf > /dev/null <<EOF

# ${PEER_NAME} added $(date -I)
[Peer]
PublicKey  = $(sudo cat peers/${PEER_NAME}.pubkey)
AllowedIPs = ${PEER_IP}/32
EOF

# Reload without interface restart
sudo wg syncconf wg0 <(sudo wg-quick strip wg0)

# Generate client config
sudo tee peers/${PEER_NAME}.conf > /dev/null <<EOF
[Interface]
PrivateKey = $(sudo cat peers/${PEER_NAME}.privkey)
Address    = ${PEER_IP}/32

[Peer]
PublicKey           = ${SERVER_PUB}
Endpoint            = ${SERVER_ENDPOINT}
AllowedIPs          = 10.213.17.0/24
PersistentKeepalive = 25
EOF

# QR code for mobile
sudo qrencode -t ansiutf8 < peers/${PEER_NAME}.conf
```

After user confirms connection:

```bash
# Verify handshake (expect Unix timestamp within last 30s)
sudo wg show wg0 latest-handshakes | grep -F "$(sudo cat /etc/wireguard/peers/${PEER_NAME}.pubkey)"

# Clean up private key material
sudo shred -u /etc/wireguard/peers/${PEER_NAME}.conf
sudo shred -u /etc/wireguard/peers/${PEER_NAME}.privkey
# Keep .pubkey for audit trail
```

If no handshake within ~5 min: remove the `[Peer]` block from `wg0.conf`, `sudo wg syncconf wg0 <(sudo wg-quick strip wg0)`, regenerate.

## Troubleshooting

### No handshake after peer import

1. Remove the `[Peer]` block from `/etc/wireguard/wg0.conf`.
2. Reload:
   ```bash
   sudo wg syncconf wg0 <(sudo wg-quick strip wg0)
   ```
3. Regenerate keys and repeat the peer onboarding steps above.

### Docker starts before wg0 on cold boot -- Caddy bind failure

Caddy binds to `10.213.17.1:443`. If Docker starts before `wg-quick@wg0`, the `wg0` interface does not exist yet and the bind fails.

The systemd drop-in at `/etc/systemd/system/docker.service.d/wait-for-wireguard.conf` prevents this:

```ini
[Unit]
Requires=wg-quick@wg0.service
After=wg-quick@wg0.service
```

Verify the dependency is active:

```bash
systemctl list-dependencies docker.service | grep -F wg-quick@wg0.service
```

If missing, re-create the drop-in (see Server setup step 4) and run `sudo systemctl daemon-reload`.
