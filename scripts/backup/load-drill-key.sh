#!/usr/bin/env bash
#
# Operator helper: load the age private identity into the backup
# container's tmpfs for Tier 2 drills (docs/ops/backup/drills.md § Loading the drill key).
#
# Invoked from the VPS as:
#   sudo -u deploy docker compose exec backup load-drill-key
#
# Safety invariants enforced here (AC-175):
#   1. The destination directory MUST be a tmpfs mount. If a prior
#      compose edit accidentally dropped the tmpfs directive, this
#      script refuses to write — a persisted identity on the VPS disk
#      defeats the entire threat model.
#   2. The pasted material is validated by round-tripping through
#      age-keygen -y; a malformed paste (e.g., the operator copied the
#      public recipient file instead of the private identity) is
#      rejected and the partial write deleted.
#   3. The derived recipient is compared to AGE_RECIPIENT. Mismatch =
#      operator loaded the wrong key pair; reject before any backup
#      cycles with a useless drill key.
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

DRILL_DIR="/run/drill-key"
DRILL_FILE="${DRILL_DIR}/identity"

# --- Invariant 1: /run/drill-key MUST be a tmpfs mount ---------------
#
# findmnt -T resolves the given path to its backing mount and prints
# the fstype. We accept only tmpfs. If findmnt isn't on this image for
# some reason, fall back to /proc/mounts.
fstype=""
if command -v findmnt >/dev/null 2>&1; then
  fstype="$(findmnt -T "$DRILL_DIR" -n -o FSTYPE 2>/dev/null || true)"
fi
if [[ -z "$fstype" ]]; then
  # /proc/mounts fallback: find the longest mount whose path is a
  # prefix of DRILL_DIR. A bare `index(p, mp) == 1` string-prefix match
  # is wrong: for DRILL_DIR="/run/drill-key" a mount at "/run/drill"
  # would match (as would "/run/drill-keyboard" if a sibling mount
  # existed). Require that the next character after the match is
  # either end-of-string (exact equality) or `/` (the path is strictly
  # inside that mount). Longest match wins — sort-by-length, first
  # hit.
  fstype="$(awk -v p="$DRILL_DIR" '
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
  echo "ERROR: $DRILL_DIR is not a tmpfs mount (detected: ${fstype:-unknown})." >&2
  echo "       Refusing to write the identity to persistent storage." >&2
  echo "       Fix: check docker-compose.yml services.backup.tmpfs directive." >&2
  exit 1
fi

# --- Invariant 3 preflight: AGE_RECIPIENT must be set ----------------
if [[ -z "${AGE_RECIPIENT:-}" ]]; then
  echo "ERROR: AGE_RECIPIENT not set in the backup container env." >&2
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
# Partial-write safety (F3a): if the script is interrupted (Ctrl-C,
# SIGTERM) or hits an error between `printf > "$DRILL_FILE"` and the
# final validation below, the file on tmpfs is an unvalidated paste
# that the next drill tick would try to decrypt with. Install a trap
# BEFORE the write so any exit path short of explicit success wipes
# the partial file. The trap is cleared at the end of the validation
# block on the success path.
trap 'rm -f "$DRILL_FILE"; unset IDENTITY; exit 1' ERR INT TERM

# umask 0077 so a race between creat() and chmod() cannot expose the
# file to other UIDs on the container. The container runs as the
# `postgres` user (UID 70 — see Dockerfile.backup, #199); the tmpfs at
# /run/drill-key is mounted uid=70,gid=70,mode=0700, so the only UID
# that can reach this path is the one we already run as. Belt and
# suspenders.
umask 0077
printf '%s' "$IDENTITY" > "$DRILL_FILE"
chmod 0400 "$DRILL_FILE"

# --- Invariant 2 + 3: validate ---------------------------------------
# age-keygen -y reads the identity and prints the derived public
# recipient. If the input is malformed it exits non-zero with a short
# error.
derived=""
if ! derived="$(age-keygen -y "$DRILL_FILE" 2>/dev/null)"; then
  # Wipe the partial write BEFORE surfacing the error, so a bad paste
  # never persists even for an instant after failure.
  rm -f "$DRILL_FILE"
  unset IDENTITY derived
  echo "ERROR: pasted material does not parse as a valid age identity." >&2
  echo "       Expected the file produced by 'age-keygen -o ...' —" >&2
  echo "       the one containing a line 'AGE-SECRET-KEY-1...'. Nothing persisted." >&2
  exit 1
fi

if [[ "$derived" != "$AGE_RECIPIENT" ]]; then
  rm -f "$DRILL_FILE"
  unset IDENTITY derived
  echo "ERROR: the pasted identity's public recipient does not match AGE_RECIPIENT." >&2
  echo "       The identity is for a DIFFERENT key pair than the one backups" >&2
  echo "       are encrypted to. Drills would fail 100% with this key. Nothing persisted." >&2
  exit 1
fi

# Validation passed — the file on tmpfs is the real, matching identity.
# Disarm the cleanup trap so normal exit doesn't wipe it.
trap - ERR INT TERM

# Clear the in-memory copy; the disk copy in tmpfs is the only
# remaining holder.
unset IDENTITY derived

echo "Drill key loaded. Next drill tick will use it."
