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

One-shot. Run on the VPS as root, after cloning the repo to `/opt/projekt-manager`:

```bash
sudo /opt/projekt-manager/scripts/ops/wireguard-server-init.sh
```

The script installs `wireguard-tools` + `qrencode`, generates the server keypair under `/etc/wireguard/`, writes `wg0.conf`, installs the systemd drop-in that makes `docker.service` wait for `wg-quick@wg0.service` (Caddy's `10.213.17.1:443` bind fails on cold boot otherwise), enables the unit, and prints a verification block. Re-runs are safe — existing artifacts are preserved.

Still manual AFTER this: **open UDP/51820 in the Hetzner Cloud Firewall.** The VPN is dead on the wire until the datagram can reach the host.

## Peer onboarding

Per [ADR-0008](../adr/0008-vpn-first-network-access.md): keys generated server-side, config distributed via Signal or in-person.

Repeatable — run once per peer:

```bash
sudo /opt/projekt-manager/scripts/ops/wireguard-add-peer.sh \
    <peer-name> <peer-ip> <server-endpoint>

# e.g.
sudo /opt/projekt-manager/scripts/ops/wireguard-add-peer.sh \
    vladimir-pixel 10.213.17.10 203.0.113.5:51820
```

| Argument          | Format                           | Notes                                         |
| ----------------- | -------------------------------- | --------------------------------------------- |
| `peer-name`       | `[a-z0-9][a-z0-9-]*`             | DNS-safe; used as filename                    |
| `peer-ip`         | `10.213.17.N` where `N ∈ 2..254` | Must be free; check `sudo wg show wg0`        |
| `server-endpoint` | `host:port`                      | Public IP / DNS of the VPS, usually `…:51820` |

The script generates a keypair under `/etc/wireguard/peers/`, appends the `[Peer]` block to `wg0.conf`, reloads the kernel config via `wg syncconf`, writes the client `.conf`, and prints a QR code for mobile import. Duplicate `peer-name` or `peer-ip` is rejected up-front. Partial failures are rolled back.

If the QR scrolls off the terminal before the peer scans it, re-render from the `.conf` (valid only until the post-handshake shred below):

```bash
sudo qrencode -t ansiutf8 < /etc/wireguard/peers/<name>.conf
```

After the peer confirms connectivity over the VPN (see [Peer device setup](#peer-device-setup)):

```bash
# Verify handshake (expect a recent Unix timestamp)
sudo wg show wg0 latest-handshakes \
  | grep -F "$(sudo cat /etc/wireguard/peers/<name>.pubkey)"

# Shred ephemeral key material (keep .pubkey for audit trail)
sudo shred -u /etc/wireguard/peers/<name>.conf
sudo shred -u /etc/wireguard/peers/<name>.privkey
```

Once the private key is shredded, the QR cannot be regenerated — that's the point. If the peer later loses their device, rotate instead of recover: run the removal script, then `wireguard-add-peer.sh` with a fresh IP.

## Peer device setup

Run by the peer on their own device, once they have the `.conf` (Linux / Windows) or QR (Android) from `wireguard-add-peer.sh`.

### Linux

```bash
sudo apt install wireguard
sudo vim /etc/wireguard/wg0.conf   # paste contents of VPS's /etc/wireguard/peers/<peer-name>.conf
sudo wg-quick up wg0
```

### Android

Install the WireGuard app → `+` → **Scan from QR code** → scan the QR printed by `wireguard-add-peer.sh`.

### Windows

Download the [official installer](https://download.wireguard.com/windows-client/wireguard-installer.exe) → **Import tunnel(s) from file** → select the `.conf`.

### Verify

Open `https://<domain>` in a browser. App loads → tunnel works. If it hangs or times out, the tunnel is not carrying traffic.

## Peer removal / rotation

```bash
sudo /opt/projekt-manager/scripts/ops/wireguard-remove-peer.sh <peer-name>
```

Drops the `[Peer]` block from `wg0.conf`, reloads the kernel config, shreds any leftover `.privkey` / `.conf` on disk. The `.pubkey` is retained for the audit trail. Use this for aborted onboardings (no handshake within ~5 min), lost/stolen devices, or access revocation.

## Troubleshooting

### Docker starts before wg0 on cold boot — Caddy bind failure

Caddy binds to `10.213.17.1:443`. If Docker starts before `wg-quick@wg0`, `wg0` does not exist yet and the bind fails. `wireguard-server-init.sh` installs a drop-in at `/etc/systemd/system/docker.service.d/wait-for-wireguard.conf` that prevents this:

```ini
[Unit]
Requires=wg-quick@wg0.service
After=wg-quick@wg0.service
```

Verify the dependency is active:

```bash
systemctl list-dependencies docker.service | grep -F wg-quick@wg0.service
```

If missing, re-run `wireguard-server-init.sh`.
