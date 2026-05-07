#!/usr/bin/env bash
#
# Re-wrap every attachment row's `wrapped_dek` (and `wrapped_thumb_dek`)
# from the local age recipient to a target recipient. Emits the matching
# UPDATE statements on stdout; the caller (scripts/sync-dev-to-vps.sh)
# appends them to the pg_dump output so the VPS-side psql restore lands
# the row in its rewrapped shape in a single pass.
#
# This is the canonical envelope re-encryption pattern (AWS KMS calls
# the equivalent operation `ReEncrypt`, GCP Cloud KMS calls it rewrap):
# unwrap with the source key, re-wrap with the target key, atomic update.
# Plaintext DEK bytes are exposed only inside the spawned `age` process
# pipeline — they never hit the filesystem and are not logged.
#
# Why dev-side and not VPS-side: the dev identity stays on dev; only the
# target recipient (a public X25519 string) crosses SSH. The VPS keeps
# its own identity (per the same principle that leaves VAPID keys
# untouched in scripts/sync-dev-to-vps.sh).
#
# Env contract:
#   COMPOSE_PROJECT          compose project for `${COMPOSE_PROJECT}-db-1`
#   BINARY_AGE_IDENTITY_PATH local age identity file (private; mode 0600)
#   TARGET_RECIPIENT         target age recipient (public X25519 string)
#
# Output: UPDATE statements on stdout, one per row. Empty output if the
# attachments table is empty or no row carries a wrapped_dek.
#
# Local DB is read-only — this script does not mutate it.

set -euo pipefail

: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"
: "${BINARY_AGE_IDENTITY_PATH:?BINARY_AGE_IDENTITY_PATH must be set}"
: "${TARGET_RECIPIENT:?TARGET_RECIPIENT must be set}"

if [ ! -r "$BINARY_AGE_IDENTITY_PATH" ]; then
  echo "ERROR: identity file not readable: $BINARY_AGE_IDENTITY_PATH" >&2
  exit 1
fi

# Validate the recipient shape up-front. age recipients are
# `age1...` X25519 strings; pasting an identity (AGE-SECRET-KEY-1...)
# in by mistake would silently produce un-decryptable envelopes on the
# VPS. Cheap regex catches the obvious foot-gun.
case "$TARGET_RECIPIENT" in
  age1*) ;;
  *)
    echo "ERROR: TARGET_RECIPIENT does not look like an age recipient: $TARGET_RECIPIENT" >&2
    exit 1
    ;;
esac

DB_CONTAINER="${COMPOSE_PROJECT}-db-1"

# rewrap one base64-encoded envelope. Reads from stdin, writes to stdout.
# The DEK plaintext exists only as a transient pipe between two `age`
# subprocesses — never on disk, never in a shell variable.
rewrap_one() {
  base64 -d \
    | age --decrypt -i "$BINARY_AGE_IDENTITY_PATH" \
    | age --recipient "$TARGET_RECIPIENT" \
    | base64 -w0
}

# Pull the rows that need rewrapping. `psql -tA -F $'\t'` emits TSV with
# no header/footer; NULL renders as the literal "\\N" string which we
# filter via COALESCE so the read loop sees an empty field instead.
docker exec "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -tA -F $'\t' -c "
    SELECT id, wrapped_dek, COALESCE(wrapped_thumb_dek, '')
    FROM attachments
    WHERE wrapped_dek IS NOT NULL
  " | while IFS=$'\t' read -r id orig_b64 thumb_b64; do
  # Defence-in-depth: refuse to emit SQL for an unexpected id shape. The
  # column is uuid in the schema, but a future migration that loosened
  # it would otherwise let arbitrary content reach an unparameterised
  # UPDATE.
  case "$id" in
    [0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*) ;;
    *) echo "ERROR: invalid id shape: $id" >&2; exit 1 ;;
  esac

  new_orig=$(printf '%s' "$orig_b64" | rewrap_one)

  # Schema-qualify the table because pg_dump --clean emits a tail that
  # leaves `search_path` in a state where `attachments` alone does not
  # resolve — `public.attachments` works regardless of how the dump
  # finishes.
  if [ -n "$thumb_b64" ]; then
    new_thumb=$(printf '%s' "$thumb_b64" | rewrap_one)
    printf "UPDATE public.attachments SET wrapped_dek='%s', wrapped_thumb_dek='%s' WHERE id='%s';\n" \
      "$new_orig" "$new_thumb" "$id"
  else
    printf "UPDATE public.attachments SET wrapped_dek='%s' WHERE id='%s';\n" \
      "$new_orig" "$id"
  fi
done
