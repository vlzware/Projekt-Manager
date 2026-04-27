# Object storage provisioning (Backblaze B2 + MinIO dev parity)

[ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) requires a versioned bucket with Compliance Object Lock plus a `daysFromHidingToDeleting` lifecycle rule. The app key cannot destroy versions — destruction is a provider-side lifecycle action only. This runbook captures the bucket and key configuration in prod (Backblaze B2) and the dev mirror (MinIO).

## Sizing dials

| Symbol | Meaning                                                       | Current value | Notes                                                                                                |
| ------ | ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `R`    | Default Compliance retention (days) — auto-applied per upload | `1`           | Operator-mistake recovery window. Sized for the iterating-friction phase; bump when real data lands. |
| `L`    | Lifecycle `daysFromHidingToDeleting` (days)                   | `2`           | Trash-bin TTL after a hide. Same: bump for prod.                                                     |

Preferred: `R ≤ L` (every hide reaps at exactly `L`). If `R > L`, the lifecycle reap retries until retention expires — trash-bin TTL stretches but data is still eventually destroyed.

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

Local dev uses MinIO behind the same `STORAGE_*` env interface. The dev bucket mirrors the B2 surface — versioning, object-lock with default retention, lifecycle — so dev tests catch divergence before prod.

`docker/init-storage.sh` runs once on `docker compose up` and ensures:

- Bucket exists with Object Lock enabled. Object Lock can only be set at bucket-create time on MinIO; if the existing dev bucket lacks it, the init script logs a warning and recreates the bucket. Dev-volume data is destroyed — re-seed with `npm run seed` if needed.
- Versioning enabled.
- Default Compliance retention = `R` days.
- Lifecycle rule `daysFromHidingToDeleting = L`.

Override per-developer in `.env`:

```bash
STORAGE_OBJECT_LOCK_DAYS=7              # longer trash window during exploratory work
STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS=14
```

## Related

- [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md) — design rationale, layered-defense reasoning, R vs. L sizing.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Lifecycle Rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
- [docs/wip/verify-b2-objectlock.sh](../../docs/wip/verify-b2-objectlock.sh) — throwaway-bucket verification (Compliance lock blocks even max-capability key).
- [docs/wip/verify-hide-capability-split.sh](../../docs/wip/verify-hide-capability-split.sh) — capability split verification (`writeFiles`-only key cannot destroy).
