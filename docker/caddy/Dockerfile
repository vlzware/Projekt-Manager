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

FROM caddy:2.11.2-builder@sha256:c54715e63a99f6bc427f6733749b71dd48fc036f9c4fcda10aa29fb278518ee0 AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build v2.11.2 \
        --with github.com/caddy-dns/cloudflare@a8737d095ad5a48ca031cea6ab704057dbc2d250

FROM caddy:2.11.2@sha256:1e40b251ca9639ead7b5cd2cedcc8765adfbabb99450fe23f130eefabf50f4bc

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
