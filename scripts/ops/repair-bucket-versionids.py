#!/usr/bin/env python3
# Tested with boto3 >= 1.30. The `client('s3', ...)` constructor and
# `get_paginator('list_object_versions')` surfaces this script uses
# are stable across boto3 1.x.
"""
Repair attachments.{version_id,thumb_version_id} after a bucket mirror.

After scripts/sync-dev-to-vps.sh runs `mc mirror /data b2/$BUCKET`, every
key on B2 carries a fresh PUT version with a B2-issued versionId (`4_z…`-
shaped). The DB rows shipped from dev still hold dev-side MinIO version
ids (UUID-shaped), so any attempt to GetObject / copyFromVersion on the
VPS would fail — B2 does not recognise the UUID and surfaces it as
`S3ServiceException InternalError 500` after three internal retries (or
410 GONE if the storage layer's HEAD-probe runs first, 961fa9c).

This script walks the bucket once via list_object_versions, builds a map
of `key -> latest non-delete-marker versionId`, then iterates the
attachments table and rewrites stale version_ids to point at the freshly
PUT B2 versions.

Hidden rows are pruned post-restore in sync-restore-vps.sh — their bytes
are stripped by the version-unaware `mc mirror` upstream (it does not
carry data that sits below a delete marker), and shipping a DB row
without bytes is data-integrity poison. By the time this script runs,
the only attachments left are `pending` (no version_id, no bytes —
skipped) and `ready` (version_id set, bytes mirrored — rewritten).

A `ready` row whose key has no PUT version on B2 is therefore an anomaly
(corrupted mirror, file dropped during transfer); the row is left with
its dev-side UUID version_id and a stderr WARN is emitted. Runtime, the
storage layer's HEAD-probe surfaces such a row as 410 GONE.

The script also covers thumb_key + thumb_version_id, since the gallery
flow gates on both versions being addressable (api.md §14.2).

Inputs (env):
  B2_ENDPOINT, B2_BUCKET, B2_KEY, B2_SECRET   bucket connection
  ATTACHMENTS_TSV (path)                      pre-extracted DB rows in
                                              the form
                                                <id>\\t<original_key>\\t<thumb_key_or_empty>\\t<version_id_or_empty>\\t<thumb_version_id_or_empty>

Output: SQL UPDATE statements on stdout (caller pipes to psql);
        progress + summary counts on stderr.

Idempotent on a fixed (TSV, bucket): re-running against the same input
emits the same UPDATEs (or none, once they have been applied). The
surrounding sync is NOT idempotent — every `mc mirror` writes new B2
versions, so each sync run shifts the latest-PUT-versionId target.
"""

import csv
import os
import sys
from collections import defaultdict
from typing import Optional

import boto3
from botocore.config import Config


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.stderr.write(f"ERROR: {name} must be set\n")
        sys.exit(1)
    return v


B2_ENDPOINT = env("B2_ENDPOINT")
B2_BUCKET = env("B2_BUCKET")
B2_KEY = env("B2_KEY")
B2_SECRET = env("B2_SECRET")
TSV_PATH = env("ATTACHMENTS_TSV")

# `path` addressing — same as the runtime app client (forcePathStyle).
# B2's S3-compat surface accepts both, but the rest of the codebase
# pins path-style; staying uniform avoids "works in tests, breaks on
# B2" surprises if a future B2 endpoint regresses on virtual-host.
s3 = boto3.client(
    "s3",
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY,
    aws_secret_access_key=B2_SECRET,
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),
)


def sql_quote(s: str) -> str:
    """Single-quote escape for inline SQL literals.

    The script is the only writer; values come from boto3 (versionIds —
    B2 issues opaque ASCII tokens) and from the TSV (UUID ids the schema
    constrains). Both are bounded charsets, so a single-quote escape is
    sufficient defence-in-depth on top of the schema-level type checks.
    """
    return s.replace("'", "''")


def main() -> int:
    # ------------------------------------------------------------------
    # Phase 1 — walk every version on B2 once. For each key, retain the
    # most recent non-delete-marker version. The paginator loop is the
    # canonical boto3 pattern for buckets that may exceed the 1000-entry
    # per-page cap (production buckets routinely do).
    # ------------------------------------------------------------------
    key_to_latest_put: dict[str, dict] = {}
    seen_keys: set[str] = set()
    page_count = 0
    versions_count = 0
    markers_count = 0

    paginator = s3.get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=B2_BUCKET):
        page_count += 1
        for ver in page.get("Versions", []) or []:
            versions_count += 1
            key = ver["Key"]
            seen_keys.add(key)
            prev = key_to_latest_put.get(key)
            if prev is None or ver["LastModified"] > prev["last_modified"]:
                key_to_latest_put[key] = {
                    "version_id": ver["VersionId"],
                    "last_modified": ver["LastModified"],
                }
        for marker in page.get("DeleteMarkers", []) or []:
            markers_count += 1
            seen_keys.add(marker["Key"])

    sys.stderr.write(
        f"  bucket scan: {page_count} page(s), "
        f"{versions_count} put version(s), {markers_count} delete marker(s), "
        f"{len(seen_keys)} unique key(s)\n",
    )

    # ------------------------------------------------------------------
    # Phase 2 — iterate DB rows, emit UPDATEs.
    #
    # Output rules per (key, current_version_id) pair:
    #   * version_id is NULL in DB (pending row, or thumb on a no-thumb
    #     row) → skip.
    #   * key has a PUT version on B2 matching the DB → skip.
    #   * key has a PUT version on B2 differing from the DB → rewrite.
    #   * key has no PUT version on B2 → anomaly (mirror dropped a
    #     ready-row file). Leave the DB row alone, emit stderr WARN.
    # ------------------------------------------------------------------
    rows_touched = 0
    rows_untouched = 0
    counts_by_disposition: dict[str, int] = defaultdict(int)

    def disposition(key: Optional[str], current: Optional[str]) -> tuple[str, Optional[str]]:
        """Return (action, new_value).

        action ∈ {"rewrite", "skip", "anomaly"}.
        new_value carries the SQL literal when action == "rewrite".
        "anomaly" surfaces a stderr WARN; the caller treats it as skip.
        """
        if not key:
            return ("skip", None)
        if not current:
            return ("skip", None)
        latest = key_to_latest_put.get(key)
        if latest is None:
            # No PUT version on B2 for this key. Hidden rows are dropped
            # before this script runs, so anything reaching here is a
            # `ready` row whose bytes failed to mirror — surface as a
            # WARN and leave the DB row alone (storage layer's HEAD-
            # probe will return 410 GONE at runtime, 961fa9c).
            sys.stderr.write(f"  WARN: no PUT version on B2 for key {key!r} — leaving row unchanged\n")
            return ("anomaly", None)
        if latest["version_id"] == current:
            # Already pointing at the freshest B2 version — re-runs of
            # this script (or a pre-sync row whose dev versionId
            # happened to coincide, vanishingly unlikely with B2's
            # `4_z…` shape) skip the UPDATE.
            return ("skip", None)
        return ("rewrite", latest["version_id"])

    with open(TSV_PATH, newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if len(row) != 5:
                sys.stderr.write(f"  WARN: malformed TSV row skipped: {row!r}\n")
                continue
            (att_id, original_key, thumb_key, version_id, thumb_version_id) = row
            original_key = original_key or None
            thumb_key = thumb_key or None
            version_id = version_id or None
            thumb_version_id = thumb_version_id or None

            orig_action, orig_new = disposition(original_key, version_id)
            thumb_action, thumb_new = disposition(thumb_key, thumb_version_id)

            counts_by_disposition[f"orig:{orig_action}"] += 1
            counts_by_disposition[f"thumb:{thumb_action}"] += 1

            sets: list[str] = []
            if orig_action == "rewrite":
                sets.append(f"version_id='{sql_quote(orig_new)}'")
            if thumb_action == "rewrite":
                sets.append(f"thumb_version_id='{sql_quote(thumb_new)}'")

            if not sets:
                rows_untouched += 1
                continue
            rows_touched += 1
            print(
                f"UPDATE public.attachments SET {', '.join(sets)} "
                f"WHERE id='{sql_quote(att_id)}';"
            )

    sys.stderr.write(
        f"  rows: touched={rows_touched} untouched={rows_untouched}\n",
    )
    sys.stderr.write(
        f"  per-column dispositions: {dict(counts_by_disposition)}\n",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
