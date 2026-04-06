#!/bin/sh
# Create the default bucket in MinIO if it doesn't already exist.
# Runs as a one-shot init container — exits after setup.

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

# Create bucket (ignore error if it already exists)
mc mb --ignore-existing minio/"$STORAGE_BUCKET"

echo "Bucket '$STORAGE_BUCKET' ready."
