#!/usr/bin/env bash
#
# `docker compose` wrapper that pre-sets APP_IMAGE_TAG from the current
# /opt/projekt-manager HEAD.
#
# The `app` and `backup` services in docker-compose.yml are gated by
# `${APP_IMAGE_TAG:?...}`, which compose evaluates while parsing the
# file — so *every* manual invocation (including `exec`, `logs`, `ps`,
# `stop`, `start`) requires the variable, not just `up`. Without it
# compose refuses to parse the file:
#
#   error while interpolating services.app.image: required variable
#   APP_IMAGE_TAG is missing a value: APP_IMAGE_TAG must be set
#
# scripts/deploy.sh handles this for the deploy path by pinning
# APP_IMAGE_TAG to the SHA it is checking out. Ops runbooks (backup
# drills, rotation, troubleshooting, DR) used to duplicate the same
# `export APP_IMAGE_TAG="sha-$(git rev-parse HEAD)"` prelude on every
# example, which drifted. This wrapper centralises it.
#
# Usage (as the `deploy` user, either directly or via `sudo -u deploy`):
#
#   /opt/projekt-manager/scripts/ops/pm-compose.sh --profile backup exec backup load-drill-key
#   /opt/projekt-manager/scripts/ops/pm-compose.sh --profile backup logs backup --tail=50
#   /opt/projekt-manager/scripts/ops/pm-compose.sh ps
#
# Do NOT use this for deploys — run `scripts/deploy.sh <ref>` instead.
# That script pins APP_IMAGE_TAG to the SHA it is checking out, not to
# HEAD, so a partial deploy does not leave this wrapper pointing at a
# tag that does not exist in GHCR.
set -euo pipefail

REPO_DIR="/opt/projekt-manager"
cd "$REPO_DIR"

APP_IMAGE_TAG="sha-$(git rev-parse HEAD)"
export APP_IMAGE_TAG
exec docker compose -f "$REPO_DIR/docker-compose.yml" "$@"
