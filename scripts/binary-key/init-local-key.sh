#!/usr/bin/env bash
#
# Bootstrap the local-dev binary `age` identity (ADR-0024).
#
# In production the operator pastes a real keypair into a tmpfs mount
# inside the app container (see scripts/binary-key/load-binary-key.sh
# and docs/ops/binary-key/load.md). In local dev there is no
# operator and no tmpfs — the boot probe still fires, so we need a
# persistent keypair on the host filesystem. This script is the dev-
# loop equivalent of the operator paste:
#
#   - generates an age keypair at $BINARY_AGE_IDENTITY_PATH if absent
#     (default: ~/.local/share/projekt-manager/binary-identity-dev);
#   - never overwrites an existing identity (idempotent);
#   - prints the matching public recipient + the two .env lines to
#     paste, so a fresh `cp .env.example .env` followed by this
#     script unblocks `npm run dev` in two commands.
#
# This identity protects nothing of value (test data only). It exists
# purely to satisfy the boot probe with the same shape the production
# code path uses, so the dev loop exercises the real probe contract.
#
# Usage:
#   scripts/binary-key/init-local-key.sh
#
# Override the path:
#   BINARY_AGE_IDENTITY_PATH=/some/other/path scripts/binary-key/init-local-key.sh
#
set -euo pipefail

DEFAULT_PATH="${HOME}/.local/share/projekt-manager/binary-identity-dev"
IDENTITY_PATH="${BINARY_AGE_IDENTITY_PATH:-$DEFAULT_PATH}"

if ! command -v age-keygen >/dev/null 2>&1; then
  echo "ERROR: age-keygen not found in PATH. Install age (apt install age)." >&2
  exit 1
fi

mkdir -p "$(dirname "$IDENTITY_PATH")"

if [[ -s "$IDENTITY_PATH" ]]; then
  echo "Identity already present at $IDENTITY_PATH — leaving in place."
else
  # Mode 0600 — no other uid on the host should read it. Production
  # uses 0400 with a privileged loader; the dev account is its own
  # loader so the writable bit on the owner is fine.
  umask 0077
  age-keygen -o "$IDENTITY_PATH" >/dev/null 2>&1
  chmod 0600 "$IDENTITY_PATH"
  echo "Generated dev identity at $IDENTITY_PATH (mode 0600)."
fi

# `age-keygen -y` re-derives the public recipient deterministically
# from the private file — same call shape `load-binary-key.sh` uses
# for its round-trip validation.
RECIPIENT="$(age-keygen -y "$IDENTITY_PATH")"

echo
echo "Add (or update) these two lines in .env:"
echo
echo "  BINARY_AGE_RECIPIENT=$RECIPIENT"
echo "  BINARY_AGE_IDENTITY_PATH=$IDENTITY_PATH"
echo
echo "Then start the dev stack: npm run dev"
