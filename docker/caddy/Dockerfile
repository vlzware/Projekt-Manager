# syntax=docker/dockerfile:1.7

# Custom Caddy build with the caddy-dns/cloudflare DNS provider plugin.
# Required for DNS-01 ACME challenges per ADR-0008 §Network topology.
#
# Pinning policy (ADR-0008 + #52):
# - Caddy version is pinned to a specific tag
# - Both base images are also digest-pinned to defeat retag-under-known-good-label attacks
# - The caddy-dns/cloudflare plugin is pinned to a specific git SHA, not a moving tag,
#   so the build is fully reproducible from source
#
# Bumping any of the three pins is a manual review gate per #52.

FROM caddy:2.11.3-builder@sha256:f96a3b748f2ce4e5f6595453615da734b93993b231213fe35d0673893b5613ef AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build v2.11.3 \
        --with github.com/caddy-dns/cloudflare@a8737d095ad5a48ca031cea6ab704057dbc2d250

FROM caddy:2.11.3@sha256:ec18ee54aab3315c22e25f3b2babda73ff8007d39b13b3bd1bfffa2f0444c7d9

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
