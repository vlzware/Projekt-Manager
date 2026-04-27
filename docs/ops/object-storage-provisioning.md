# Object storage provisioning (Backblaze B2 + MinIO dev parity)

[ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) requires a versioned bucket with Compliance Object Lock plus a `daysFromHidingToDeleting` lifecycle rule. The app key cannot destroy versions — destruction is a provider-side lifecycle action only. This runbook captures the bucket and key configuration in prod (Backblaze B2) and the dev mirror (MinIO).

## Sizing dials

| Symbol | Meaning                                                       | Current value | Notes                                                                                                |
| ------ | ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `R`    | Default Compliance retention (days) — auto-applied per upload | `1`           | Operator-mistake recovery window. Sized for the iterating-friction phase; bump when real data lands. |
| `L`    | Lifecycle `daysFromHidingToDeleting` (days)                   | `2`           | Trash-bin TTL after a hide. Same: bump for prod.                                                     |

**Required: `R ≤ L`.** With `R > L` the lifecycle would attempt to reap noncurrent versions still protected by Object Lock retention, leaving zombie versions on every reap cycle until `R` elapses — incoherent on its face. The boot-time safety probe refuses to start under `R > L`.

To adjust:

- B2 console → bucket → Object Lock → "Default Retention Policy for Bucket". Change applies to **future uploads only**; existing versions keep their original retention.
- B2 console → bucket → Lifecycle Settings → edit `daysFromHidingToDeleting`. Change applies bucket-wide immediately.
- Dev mirror: re-run `docker compose up storage-init` after changing `STORAGE_OBJECT_LOCK_DAYS` or `STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS` in `.env`.

## B2 bucket — one-time portal setup

Done in the B2 web UI:

1. Create bucket `prmng-object-storage`:
   - Files: **private**
   - Encryption: **disabled** — the SSE-B2 option provides at-rest encryption with a Backblaze-held key. Not end-to-end: the provider can still decrypt, so it adds no confidentiality guarantee against a hostile-or-compromised B2. ADR-0020 covers e2e via age for the R2 backup path; binaries may follow if real e2e becomes a requirement.
   - Object Lock: **enabled** — irreversible, cannot be added later
2. Bucket → Object Lock → Default Retention: **Compliance**, `R` days.
3. Bucket → Lifecycle Settings → Use custom lifecycle rules → `daysFromHidingToDeleting = L`.

Deny-listed (do **not** set):

- `daysFromUploadingToHiding` — would auto-hide live data.
- Any lifecycle rule other than `daysFromHidingToDeleting`.
- Governance retention — bypassable by capability; defeats the layered defense.
- Bucket-wide legal-hold defaults.

## App key — via `b2` CLI

The B2 web UI cannot create capability-restricted keys; it grants only coarse Read / Write. Use the CLI:

```bash
# 1. Authorize once with master credentials (interactive — type yourself):
b2 account authorize <masterKeyId> <masterAppKey>

# 2. Create the bucket-scoped app key:
b2 key create --bucket prmng-object-storage prmng-app readFiles,writeFiles,listFiles
```

The create command prints the secret on stdout **once** — listing keys later shows IDs but never the secret again:

```
<keyId> <applicationKey>
```

Capture both values immediately into `secrets.env.age` as `STORAGE_ACCESS_KEY` (= `keyId`) and `STORAGE_SECRET_KEY` (= `applicationKey`).

Verify the key has only the intended capabilities:

```bash
b2 key list | grep prmng-app
# expected: "<keyId> prmng-app … readFiles,writeFiles,listFiles"
```

If `deleteFiles`, `bypassGovernance`, `writeFileRetentions`, `writeFileLegalHolds`, or any `*Bucket*` capability appears — revoke (`b2 key delete <keyId>`) and recreate.

### Master-key handling

The master key has `deleteFiles` and can destroy versions outside their retention window. Per ADR-0022:

- Stored offline (password manager). Not on the VPS, not in any deploy artifact, not in CI.
- Used **only** for provisioning, key rotation, audited maintenance.
- Never set as `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` on any running service.

App-key rotation: create the new key first, deploy the new credentials, verify, then revoke the old key with `b2 key delete <oldKeyId>`.

## Dev-MinIO parity

Local dev uses MinIO behind the same `STORAGE_*` env interface. The dev bucket mirrors the B2 surface — versioning, object-lock with default retention, lifecycle — AND the credential capability split, so dev tests catch divergence on either axis before prod.

`docker/init-storage.sh` runs once on `docker compose up` and ensures:

- Bucket exists with Object Lock enabled. Object Lock can only be set at bucket-create time on MinIO; if the existing dev bucket lacks it, the init script logs a warning and recreates the bucket. Dev-volume data is destroyed — re-seed with `npm run seed` if needed.
- Versioning enabled.
- Default Compliance retention = `R` days.
- Lifecycle rule `daysFromHidingToDeleting = L`.
- A capability-restricted MinIO user `${MINIO_APP_ACCESS_KEY}` exists with a bucket-scoped IAM policy named `projekt-manager-app` attached.

The B2 prod recipe (separate restricted app key created via `b2 key create … readFiles,writeFiles,listFiles`) and the MinIO dev recipe (separate restricted IAM user created via `mc admin user add` + `mc admin policy attach`) are now structurally parallel — both deny version destruction at the credential layer, so the boot-time capability self-test in `src/server/storage/safety.ts` exercises the same defense in both environments. The app **never** runs as the MinIO root user; root credentials only exist to provision the MinIO process and the app user.

The IAM policy the init script applies (allow list mirrors the B2 app key's `readFiles, writeFiles, listFiles`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:ListBucket",
        "s3:ListBucketVersions"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    }
  ]
}
```

The explicit `Deny` block is required, not redundant: MinIO's IAM evaluator treats `s3:DeleteObject` as covering a `DeleteObjectCommand` that carries a `VersionId`, so a policy that merely omits `s3:DeleteObjectVersion` is not enough to deny version destruction. MinIO's "deny overrides allow" semantic makes the explicit `Deny` a hard guardrail — even if a downstream policy mutation introduced a broader allow, version destruction would still be blocked.

Override per-developer in `.env`:

```bash
STORAGE_OBJECT_LOCK_DAYS=7              # longer trash window during exploratory work
STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS=14
MINIO_APP_ACCESS_KEY=pmapp              # username for the app user (default in .env.example)
MINIO_APP_SECRET_KEY=pmappsecret        # password for the app user (default in .env.example)
```

`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` continue to provision the MinIO process and run the init script as the privileged caller — they are NEVER set as `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` on the app container. The compose file `:?`-gates `MINIO_APP_ACCESS_KEY` and `MINIO_APP_SECRET_KEY` so a missing value fails the deploy at parse time rather than booting the app under root credentials by accident.

## Boot-time safety probe

`assertStorageBucketSafe()` in `src/server/storage/safety.ts` runs once at startup (before reapers schedule) and reads the bucket's actual versioning, Object Lock, and lifecycle config — plus a credential capability self-test (#45 review H3). Behaviour:

- **Refuses to boot** (data-corruption class):
  - Versioning not Enabled.
  - Object Lock not Enabled, or default retention not `COMPLIANCE` with positive days.
  - No lifecycle rule, more than one rule, or a rule that:
    - is Disabled, or
    - has a prefix or tag filter (must apply to all objects), or
    - lacks `NoncurrentVersionExpiration.NoncurrentDays` (hidden versions would never reap), or
    - lacks `ExpiredObjectDeleteMarker = true` (delete markers would zombie), or
    - has any other action — itemized: `Expiration.Days`, `Expiration.Date`, `Transitions[]`, `NoncurrentVersionTransitions[]`, `AbortIncompleteMultipartUpload`, or a rule with both `Expiration` AND `NoncurrentVersionExpiration` (mixed semantics).
    - has an `ID` containing the deny-listed B2 moniker `daysFromUploadingToHiding`.
  - `R > L` — lifecycle reap is blocked by Object Lock retention for `R-L` days, leaving zombie versions every cycle. The configuration is incoherent; refuse to start.
  - **Capability self-test** — issues `DeleteObjectCommand` with a non-existent `VersionId` against the sentinel key `__probe/safety` and refuses to boot unless the response is `AccessDenied`. A 2xx response means the credential CAN destroy versions (the primary defense layer is broken); any other error code means the response leaked no perms info and the probe is fail-closed under that ambiguity.

This catches drift between the runbook and live bucket state — e.g., an operator who edits lifecycle in the B2 portal without updating the runbook trips the probe at next deploy. The capability self-test additionally catches the orthogonal "credential drift" axis: a reissued app key with `deleteFiles` enabled by mistake passes every shape check yet breaks the primary defense.

## Related

- [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) — design rationale, layered-defense reasoning, R vs. L sizing.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Lifecycle Rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
- [docs/wip/verify-b2-objectlock.sh](../../docs/wip/verify-b2-objectlock.sh) — throwaway-bucket verification (Compliance lock blocks even max-capability key).
- [docs/wip/verify-hide-capability-split.sh](../../docs/wip/verify-hide-capability-split.sh) — capability split verification (`writeFiles`-only key cannot destroy).
