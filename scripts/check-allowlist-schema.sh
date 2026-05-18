#!/usr/bin/env bash
#
# Enforce the allowlist schema documented in ADR-0027 §Negative and
# docs/ops/dep-management.md §Allowlist for osv-scanner.toml and
# .trivyignore. Both scanners read only the advisory ID; the
# owner/reason/expiry convention is otherwise unenforced. Per the
# project's "refuse to serve, fail the deploy, or block the merge"
# principle (CLAUDE.md §Principles), the convention is gated in CI.
#
# Exit code:
#   0 — every active entry carries owner-prefixed reason + expiry
#       within [today, today+90d]; empty files are valid. Bounds are
#       closed on both ends: today (entry valid through end-of-day) and
#       today+90d (max 90-day window per ADR-0027 §Negative).
#   1 — at least one violation; one line per finding on stdout
#       formatted as `<file>:<line>: <field>: <description>`.

set -euo pipefail

# Repo root: parent of this script's directory. ALLOWLIST_REPO_ROOT
# override lets the test harness point at a fixture tree.
REPO_ROOT="${ALLOWLIST_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

OSV_FILE="$REPO_ROOT/osv-scanner.toml"
TRIVY_FILE="$REPO_ROOT/.trivyignore"

violations=0

if [[ -f "$OSV_FILE" ]]; then
  # Python carries tomllib (3.11+) and proper date arithmetic. Bash
  # alone can do neither cleanly. OSV_FILE flows in via env, NOT as
  # a positional argv into python heredoc, so quoting in the path
  # stays the shell's problem and the heredoc body stays literal.
  if ! OSV_FILE_PATH="$OSV_FILE" python3 - <<'PY'
import os, re, sys, tomllib
from datetime import date, datetime, timedelta

path = os.environ["OSV_FILE_PATH"]
today = date.today()
max_d = today + timedelta(days=90)
out = []

# GitHub handle: 1-39 chars, alnum + non-leading/trailing/consecutive
# hyphens. Anchored at the start of the reason field after the `@`.
handle_re = re.compile(
    r"^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}:"
)

try:
    with open(path, "rb") as f:
        data = tomllib.load(f)
except tomllib.TOMLDecodeError as e:
    print(f"{path}:0: parse: TOML decode error: {e}")
    sys.exit(1)

for i, entry in enumerate(data.get("IgnoredVulns", []), start=1):
    label = f"{path}:0: [[IgnoredVulns]]#{i}"
    if "id" not in entry:
        out.append(f"{label}: id: missing")
    else:
        # tomllib accepts any TOML value; we require a non-empty string
        # so `id = ""` and `id = 12345` are rejected at the gate rather
        # than being passed to OSV-Scanner verbatim.
        v = entry["id"]
        if not isinstance(v, str) or not v.strip():
            out.append(
                f"{label}: id: must be a non-empty TOML string, "
                f"got {type(v).__name__}"
            )
    if "ignoreUntil" not in entry:
        out.append(f"{label}: ignoreUntil: missing")
    else:
        v = entry["ignoreUntil"]
        # tomllib maps bare TOML dates to datetime.date; a TOML offset
        # datetime / local datetime parses to datetime.datetime (subclass
        # of date — the isinstance(date) check would pass, then the
        # `v < today` comparison raises TypeError). Reject both
        # datetimes and non-dates so the only accepted shape is the
        # bare YYYY-MM-DD date literal.
        if isinstance(v, datetime):
            out.append(
                f"{label}: ignoreUntil: must be a bare TOML date "
                f"(YYYY-MM-DD), got TOML datetime"
            )
        elif not isinstance(v, date):
            out.append(
                f"{label}: ignoreUntil: must be a bare TOML date "
                f"(YYYY-MM-DD without quotes), got {type(v).__name__}"
            )
        elif v < today:
            out.append(f"{label}: ignoreUntil: expired ({v} < {today})")
        elif v > max_d:
            out.append(
                f"{label}: ignoreUntil: too far ({v} > today+90d {max_d})"
            )
    if "reason" not in entry:
        out.append(f"{label}: reason: missing")
    else:
        r = entry["reason"]
        # Owner prefix is the only place OSV-Scanner carries
        # accountability — no dedicated owner field exists. Validate
        # the prefix is a real GitHub handle (otherwise `@:` / `@-:`
        # / `@-` slip through and the accountability gate is form-only).
        if not isinstance(r, str) or not handle_re.match(r.lstrip()):
            out.append(
                f"{label}: reason: must start with `@<github-handle>:` "
                f"prefix (1-39 alnum chars + non-leading/trailing hyphens)"
            )

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
  then
    violations=1
  fi
fi

if [[ -f "$TRIVY_FILE" ]]; then
  # Each entry line is preceded by a contiguous `#`-comment block
  # (terminated by any non-comment, non-entry line OR top of file)
  # that MUST contain `# owner: @<handle>` AND `# reason: …`. The
  # entry line itself MUST carry `exp:YYYY-MM-DD` with the same
  # window rule as OSV's ignoreUntil.
  if ! TRIVY_FILE_PATH="$TRIVY_FILE" python3 - <<'PY'
import os, re, sys
from datetime import date, timedelta

path = os.environ["TRIVY_FILE_PATH"]
today = date.today()
max_d = today + timedelta(days=90)
out = []

# GitHub handle regex applied to the `# owner: @<handle>` comment.
# Anchored so `@:` / `@-` / `@a-` / `@a--b` are rejected.
owner_re = re.compile(
    r"^#\s*owner:\s*@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\s*$"
)
reason_re = re.compile(r"^#\s*reason:\s*\S.*$")
exp_re = re.compile(r"\bexp:(\d{4}-\d{2}-\d{2})\b")

with open(path, encoding="utf-8") as f:
    lines = f.read().splitlines()

# Walk a small state machine: accumulate comment lines into `block`,
# reset on blanks; on a non-blank non-comment line treat as an entry,
# validate the block + the inline `exp:` suffix, then clear the block
# (so two entries can't share one comment block).
#
# Note: the script does NOT validate the entry's ID shape. Trivy
# rejects unknown IDs itself; trying to mirror its accepted ID set
# (CVE-, GHSA-, AVD-, DS-, KSV001 without hyphen, lowercase
# `aws-access-token` for secret rules, ...) here is a maintenance
# liability and was the source of false-rejects flagged in PR review.
block = []
for idx, raw in enumerate(lines, start=1):
    line = raw.rstrip()
    if not line.strip():
        block = []
        continue
    if line.lstrip().startswith("#"):
        block.append(line)
        continue
    # Any other non-blank line is treated as a Trivy ID entry.
    label = f"{path}:{idx}"
    if not any(owner_re.match(b) for b in block):
        out.append(
            f"{label}: owner: missing `# owner: @<github-handle>` "
            f"above entry (1-39 alnum chars + non-leading/trailing hyphens)"
        )
    if not any(reason_re.match(b) for b in block):
        out.append(f"{label}: reason: missing `# reason: …` above entry")
    em = exp_re.search(line)
    if not em:
        out.append(f"{label}: exp: missing `exp:YYYY-MM-DD` suffix on entry")
    else:
        try:
            v = date.fromisoformat(em.group(1))
        except ValueError:
            out.append(f"{label}: exp: not a valid YYYY-MM-DD date")
        else:
            if v < today:
                out.append(f"{label}: exp: expired ({v} < {today})")
            elif v > max_d:
                out.append(f"{label}: exp: too far ({v} > today+90d {max_d})")
    block = []

for line in out:
    print(line)
sys.exit(1 if out else 0)
PY
  then
    violations=1
  fi
fi

exit "$violations"
