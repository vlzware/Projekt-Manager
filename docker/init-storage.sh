#!/bin/sh
# Configure the MinIO bucket to mirror the prod B2 surface — Object Lock,
# Versioning, default Compliance retention, and a lifecycle rule that
# reaps hidden versions. See ADR-0022 and
# docs/ops/object-storage-provisioning.md.
#
# Idempotent: re-running settles the bucket to the desired state.
# Object Lock can only be set at bucket-creation time on MinIO, so a
# pre-existing unlocked bucket is dropped and recreated (dev-only data,
# throwaway).

set -e

TIMEOUT=30
ELAPSED=0

# Wait for MinIO to be ready (max ${TIMEOUT}s)
until mc alias set minio http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "ERROR: MinIO not ready after ${TIMEOUT}s"
    exit 1
  fi
  echo "Waiting for MinIO... (${ELAPSED}/${TIMEOUT}s)"
  sleep 1
done

BUCKET="$STORAGE_BUCKET"
LOCK_DAYS="${STORAGE_OBJECT_LOCK_DAYS:-1}"
HIDE_TTL_DAYS="${STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS:-2}"

# Object Lock cannot be added to an existing bucket on MinIO. If the
# bucket exists without lock, drop and recreate. Dev attachment data is
# throwaway — re-seed with `npm run seed` if needed.
if mc ls "minio/$BUCKET" >/dev/null 2>&1; then
  if ! mc retention info "minio/$BUCKET" >/dev/null 2>&1; then
    echo "WARN: bucket '$BUCKET' exists without Object Lock — recreating."
    echo "      Local attachment data will be destroyed. Re-seed if needed."
    mc rb --force "minio/$BUCKET"
    mc mb --with-lock --with-versioning "minio/$BUCKET"
  fi
else
  mc mb --with-lock --with-versioning "minio/$BUCKET"
fi

# Belt-and-braces: --with-versioning at create-time enables it, but a
# downstream operator could have suspended it. Idempotent re-enable.
mc version enable "minio/$BUCKET" >/dev/null

# Default Compliance retention — auto-applied per upload, mirroring B2's
# bucket-default. The PUT result returns the version id which the app
# persists for restore.
mc retention set --default compliance "${LOCK_DAYS}d" "minio/$BUCKET"

# Lifecycle: reap noncurrent versions HIDE_TTL_DAYS days after they
# become noncurrent. On a versioned bucket, DeleteObject without a
# VersionId demotes the current version to noncurrent and writes a
# delete marker — that's the "hide". NoncurrentDays counts from the
# demotion, matching B2's daysFromHidingToDeleting semantic.
# --expire-delete-marker cleans up the dangling marker after the
# noncurrent version is reaped (otherwise it sits forever as a zombie).
#
# Idempotent: clear-all then add. Cheaper than diffing existing rules,
# and dev-loop cost is irrelevant.
mc ilm rule remove --all --force "minio/$BUCKET" >/dev/null 2>&1 || true
mc ilm rule add \
  --noncurrent-expire-days "$HIDE_TTL_DAYS" \
  --expire-delete-marker \
  "minio/$BUCKET"

echo "Bucket '$BUCKET' ready: Object Lock=Compliance/${LOCK_DAYS}d, NoncurrentDays=${HIDE_TTL_DAYS}, expire-delete-marker=true."
