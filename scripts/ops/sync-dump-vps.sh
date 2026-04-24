#!/usr/bin/env bash
#
# VPS side of scripts/sync-vps-to-dev.sh. Not intended to be run directly.
# The orchestrator streams this script over SSH (`ssh hetzner bash -s`) with
# these env vars set. Dumps the VPS DB and bucket into $REMOTE_TMP so the
# orchestrator can rsync them down.
#
# Env contract:
#   REMOTE_TMP       directory on VPS to write dumps into
#   MC_IMAGE         minio/mc image tag (same as app stack uses)
#   BUCKET           MinIO bucket name (projekt-manager)
#   COMPOSE_PROJECT  compose project name (projekt-manager)
#
# This script does NOT stop the app — pg_dump holds a consistent snapshot
# in a single transaction by default, and MinIO is content-addressed so a
# concurrent write at most produces a fresh key the next sync will pick
# up. No trap needed because nothing is being stopped or mutated.

set -euo pipefail

: "${REMOTE_TMP:?REMOTE_TMP must be set}"
: "${MC_IMAGE:?MC_IMAGE must be set}"
: "${BUCKET:?BUCKET must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"

DB_CONTAINER="${COMPOSE_PROJECT}-db-1"
STORAGE_CONTAINER="${COMPOSE_PROJECT}-storage-1"
NETWORK="${COMPOSE_PROJECT}_default"

mkdir -p "$REMOTE_TMP/bucket"

# Dump DB with the same flags the forward script uses. pg_dump defaults
# to a single transaction (serializable snapshot) so no lock is needed.
docker exec "$DB_CONTAINER" \
  pg_dump -U pm -d projekt_manager \
  --clean --if-exists --no-owner --no-acl \
  > "$REMOTE_TMP/db.sql"

# Pull VPS MinIO creds from the running storage container's env — same
# pattern as the forward path, avoids decrypting secrets.env.age.
VPS_MINIO_USER=$(docker exec "$STORAGE_CONTAINER" printenv MINIO_ROOT_USER)
VPS_MINIO_PASS=$(docker exec "$STORAGE_CONTAINER" printenv MINIO_ROOT_PASSWORD)

# Mirror bucket contents into a filesystem directory. `--overwrite --remove`
# keeps the directory an exact mirror of the bucket across repeated runs
# of this script, matching the forward path's semantics.
docker run --rm \
  --network "$NETWORK" \
  -v "$REMOTE_TMP/bucket:/data" \
  -e MC_HOST_src="http://${VPS_MINIO_USER}:${VPS_MINIO_PASS}@storage:9000" \
  "$MC_IMAGE" \
  mirror --overwrite --remove "src/$BUCKET" /data >/dev/null
