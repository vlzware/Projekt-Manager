# Ops Docs

## Setup (one-time)

| Document                                         | Purpose                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| [server-setup.md](server-setup.md)               | VPS provisioning: OS, SSH, deploy user, Docker, fail2ban |
| [wireguard-setup.md](wireguard-setup.md)         | WireGuard VPN server and peer onboarding                 |
| [dns-setup.md](dns-setup.md)                     | Domain DNS configuration (A record → WireGuard IP)       |
| [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md) | First-time TLS certificate provisioning via LE staging   |
| [storage-subdomain.md](storage-subdomain.md)     | `storage.<DOMAIN>` reverse-proxy for attachment uploads  |

## Operations (repeatable)

| Document                                           | Purpose                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [manual-deploy.md](manual-deploy.md)               | Deploy, rollback, secrets management                        |
| [backup/](backup/overview.md)                      | Layer 2 backup — setup, DR restore, drills, troubleshooting |
| [local-dev.md](local-dev.md)                       | Local development environment                               |
| [http-only-evaluation.md](http-only-evaluation.md) | Domain-less HTTP testing on a bare VPS                      |
