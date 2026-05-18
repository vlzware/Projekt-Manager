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
#       within (today, today+90d]; empty files are valid.
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
import os, sys, tomllib
from datetime import date, timedelta

path = os.environ["OSV_FILE_PATH"]
today = date.today()
max_d = today + timedelta(days=90)
out = []

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
    if "ignoreUntil" not in entry:
        out.append(f"{label}: ignoreUntil: missing")
    else:
        v = entry["ignoreUntil"]
        # tomllib maps bare TOML dates to datetime.date; a quoted
        # "YYYY-MM-DD" stays a str and is explicitly rejected so
        # the schema cannot drift into freeform date strings.
        if not isinstance(v, date):
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
        # accountability — no dedicated owner field exists.
        if not isinstance(r, str) or not r.lstrip().startswith("@") or ":" not in r.split(None, 1)[0]:
            out.append(
                f"{label}: reason: must start with `@<handle>:` prefix"
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

entry_re = re.compile(r"^([A-Z]+-\S+)(?:\s+(.*))?$")
owner_re = re.compile(r"^#\s*owner:\s*@\S+\s*$")
reason_re = re.compile(r"^#\s*reason:\s*\S.*$")
exp_re = re.compile(r"\bexp:(\d{4}-\d{2}-\d{2})\b")

with open(path, encoding="utf-8") as f:
    lines = f.read().splitlines()

# Walk a small state machine: accumulate comment lines into `block`,
# reset on blanks/garbage; on an entry line, validate the block then
# clear it (so two entries can't share one comment block).
block = []
for idx, raw in enumerate(lines, start=1):
    line = raw.rstrip()
    if not line.strip():
        block = []
        continue
    if line.lstrip().startswith("#"):
        block.append(line)
        continue
    m = entry_re.match(line)
    if not m:
        out.append(f"{path}:{idx}: format: unrecognized line `{line}`")
        block = []
        continue
    label = f"{path}:{idx}"
    if not any(owner_re.match(b) for b in block):
        out.append(f"{label}: owner: missing `# owner: @<handle>` above entry")
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
