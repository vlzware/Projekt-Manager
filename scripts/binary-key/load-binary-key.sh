#!/usr/bin/env bash
#
# Operator helper: load the binary-attachment age private identity into
# the app container's tmpfs (docs/ops/binary-key/load.md § The paste).
#
# Invoked from the VPS as:
#   sudo -u deploy docker exec -it projekt-manager-app-1 load-binary-key
#
# Safety invariants enforced here (ADR-0024 §Operator workflow):
#   1. The destination directory MUST be a tmpfs mount. If a prior
#      compose edit accidentally dropped the tmpfs directive, this
#      script refuses to write — a persisted identity on the VPS disk
#      defeats the entire threat model.
#   2. The pasted material is validated by round-tripping through
#      age-keygen -y; a malformed paste (e.g., the operator copied the
#      public recipient file instead of the private identity) is
#      rejected and the partial write deleted.
#   3. The derived recipient is compared to BINARY_AGE_RECIPIENT.
#      Mismatch = operator loaded the wrong key pair (the most common
#      mixup is pasting the backup drill identity here); reject before
#      the boot probe accepts a useless key.
#   4. The identity string lives in shell memory only for the duration
#      of this script; the variable is `unset` before exit. A
#      kernel-level secure-wipe of the memory pages is not attempted —
#      bash + libc do not provide that primitive, and pretending
#      otherwise would be a false assurance. `read -s` suppresses echo;
#      shell history doesn't capture variable contents.
#
# Output: one success line, no other stdout. Validation failures go to
# stderr. NEVER echo the pasted material.
set -euo pipefail

BINARY_DIR="/run/binary-key"
BINARY_FILE="${BINARY_DIR}/identity"

# --- Invariant 1: /run/binary-key MUST be a tmpfs mount --------------
#
# findmnt -T resolves the given path to its backing mount and prints
# the fstype. We accept only tmpfs. If findmnt isn't on this image for
# some reason, fall back to /proc/mounts.
fstype=""
if command -v findmnt >/dev/null 2>&1; then
  fstype="$(findmnt -T "$BINARY_DIR" -n -o FSTYPE 2>/dev/null || true)"
fi
if [[ -z "$fstype" ]]; then
  # /proc/mounts fallback: find the longest mount whose path is a
  # prefix of BINARY_DIR. A bare `index(p, mp) == 1` string-prefix
  # match is wrong: for BINARY_DIR="/run/binary-key" a mount at
  # "/run/binary" would match (as would "/run/binary-keyboard" if a
  # sibling mount existed). Require that the next character after the
  # match is either end-of-string (exact equality) or `/` (the path is
  # strictly inside that mount). Longest match wins — sort-by-length,
  # first hit.
  fstype="$(awk -v p="$BINARY_DIR" '
    {
      mp = $2
      mlen = length(mp)
      if (substr(p, 1, mlen) == mp \
          && (length(p) == mlen || substr(p, mlen + 1, 1) == "/") \
          && (mlen > best_len || best_len == 0)) {
        best_len = mlen
        best = $3
      }
    }
    END { print best }
  ' /proc/mounts)"
fi

if [[ "$fstype" != "tmpfs" ]]; then
  echo "ERROR: $BINARY_DIR is not a tmpfs mount (detected: ${fstype:-unknown})." >&2
  echo "       Refusing to write the identity to persistent storage." >&2
  echo "       Fix: check docker-compose.yml services.app.tmpfs directive." >&2
  exit 1
fi

# --- Invariant 3 preflight: BINARY_AGE_RECIPIENT must be set ---------
if [[ -z "${BINARY_AGE_RECIPIENT:-}" ]]; then
  echo "ERROR: BINARY_AGE_RECIPIENT not set in the app container env." >&2
  echo "       Cannot verify the pasted identity matches the deployed recipient." >&2
  exit 1
fi

# --- Prompt ----------------------------------------------------------
echo "Paste age identity, finish with Ctrl-D:"
# -s  suppress echo (no visible leak to the terminal)
# -r  raw mode (preserve backslashes in the pasted material)
# -d $'\004' use EOT (Ctrl-D) as the delimiter so multi-line paste works
#
# shellcheck disable=SC2162  # -r is passed; -s implies no visible echo
# which makes the absence of -r's "no backslash escape" warning moot
IDENTITY=""
if ! IFS= read -r -s -d $'\004' IDENTITY; then
  # Non-zero from read on EOF is expected with -d; only care if the
  # buffer is empty.
  :
fi
# Clear the prompt line so `ps` / terminal scrollback don't linger on
# it. The value is already out-of-band in $IDENTITY.
printf '\n'

if [[ -z "$IDENTITY" ]]; then
  echo "ERROR: empty input — nothing written." >&2
  unset IDENTITY
  exit 1
fi

# --- Write to tmpfs with restrictive mode ----------------------------
# Partial-write safety: if the script is interrupted (Ctrl-C, SIGTERM)
# or hits an error between `printf > "$BINARY_FILE"` and the final
# validation below, the file on tmpfs is an unvalidated paste that
# the next boot-probe poll would accept. Install a trap BEFORE the
# write so any exit path short of explicit success wipes the partial
# file. The trap is cleared at the end of the validation block on the
# success path.
trap 'rm -f "$BINARY_FILE"; unset IDENTITY; exit 1' ERR INT TERM

# umask 0077 so a race between creat() and chmod() cannot expose the
# file to other UIDs on the container (defensive; the container is
# root-only anyway).
umask 0077
printf '%s' "$IDENTITY" > "$BINARY_FILE"
chmod 0400 "$BINARY_FILE"

# --- Invariant 2 + 3: validate ---------------------------------------
# age-keygen -y reads the identity and prints the derived public
# recipient. If the input is malformed it exits non-zero with a short
# error.
derived=""
if ! derived="$(age-keygen -y "$BINARY_FILE" 2>/dev/null)"; then
  # Wipe the partial write BEFORE surfacing the error, so a bad paste
  # never persists even for an instant after failure.
  rm -f "$BINARY_FILE"
  unset IDENTITY derived
  echo "ERROR: pasted material does not parse as a valid age identity." >&2
  echo "       Expected the file produced by 'age-keygen -o ...' —" >&2
  echo "       the one containing a line 'AGE-SECRET-KEY-1...'. Nothing persisted." >&2
  exit 1
fi

if [[ "$derived" != "$BINARY_AGE_RECIPIENT" ]]; then
  rm -f "$BINARY_FILE"
  unset IDENTITY derived
  echo "ERROR: the pasted identity's public recipient does not match BINARY_AGE_RECIPIENT." >&2
  echo "       The identity is for a DIFFERENT key pair than the one binaries" >&2
  echo "       are encrypted to. Uploads/downloads would fail with this key. Nothing persisted." >&2
  exit 1
fi

# Validation passed — the file on tmpfs is the real, matching identity.
# Disarm the cleanup trap so normal exit doesn't wipe it.
trap - ERR INT TERM

# Clear the in-memory copy; the disk copy in tmpfs is the only
# remaining holder.
unset IDENTITY derived

echo "Binary identity loaded. Boot probe will accept on next poll."
