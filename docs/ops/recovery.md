# Backup and Recovery Runbook

Operator procedure for the Layer 2 full-state backup feature ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md), [architecture.md §11.10](../spec/architecture.md#1110-full-state-backup-layer-2)). Observable behaviour (badge, status surface, verify tiers) is pinned in [verification.md §15.22](../spec/verification.md#1522-backup-and-recovery).

## 1. When to use this runbook

Reach for this document in exactly three situations:

- **Cold start.** Bring Layer 2 up on a fresh VPS, from zero — no bucket, no keys, no secrets.
- **Credential rotation.** Throw away the R2 token and/or age key pair used to bootstrap and replace them end-to-end; the feature was designed for this flow ([ADR-0020 §Context](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#context)).
- **Disaster recovery.** The production database is lost, corrupt, or diverged, and you need to restore from the last good encrypted dump.

Rationale for the design — encryption tool, bucket policy, operator-held key, dual-write status — lives in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md). This runbook does not restate it.

## 2. Prerequisites

**Operator laptop:**

- Shell with `age`, `age-keygen`, `ssh`, `wg-quick` (or `wg` + a platform-native WireGuard client), `docker` and the `docker compose` plugin, `aws` CLI (or `rclone` — this runbook uses `aws` examples), `curl`, `jq`, `openssl`, `shred`.
- Repo checked out locally: `git clone git@github.com:vlzware/Projekt-Manager.git`.
- WireGuard peer config imported and active ([ops/wireguard-setup.md](../ops/wireguard-setup.md)).
- Password manager entry for: the R2 API token, the age private identity (backed up outside the system — see §4), the `secrets.env.age` passphrase.

**VPS:**

- Provisioned per [ops/server-setup.md](../ops/server-setup.md) — Docker Engine, `age`, `deploy` user with `nologin`, repo cloned at `/opt/projekt-manager`.
- `docker compose` stack is running (`app`, `db`, `storage`, `storage-init`, `caddy`).
- `/opt/projekt-manager/secrets.env.age` exists and is decryptable with the known passphrase.

**Cloudflare:**

- Account with R2 enabled. Billing set up (R2 egress is free; storage has a free tier).

Runtime versions are not pinned here — [CONTRIBUTING.md § Runtime Requirements](../../CONTRIBUTING.md#runtime-requirements) owns that.

## 3. Create off-site storage (Cloudflare R2)

Run from zero every time the feature is bootstrapped or the credential is burned.

### 3.1 Create the bucket

1. Cloudflare dashboard → R2 → **Create bucket**.
2. Name: `projekt-manager-backups` (exact — the backup script reads this literal via env per ADR-0020).
3. Location hint: **EEUR** (Eastern Europe).
4. Click **Create bucket**.

### 3.2 Configure retention (bucket lock)

R2 does not offer native object versioning or S3 Object Lock Compliance Mode. A bucket lock rule over timestamped filenames gives us the practical immutability window ([ADR-0020 §Alternatives](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#alternatives-considered)).

1. Open the bucket → **Settings** → **Object lock rules** → **Add rule**.
2. Mode: **Compliance**. Retention: **14 days**. Prefix scope: all objects (leave empty).
3. **Save**.

### 3.3 Configure deletion (lifecycle rule)

1. Bucket → **Settings** → **Lifecycle rules** → **Add rule**.
2. Name: `delete-after-30-days`. Prefix scope: all objects. Action: **Delete objects** 30 days after upload.
3. **Save**.

Effective behaviour: every uploaded object is immutable for its first 14 days and is deleted on day 30. GFS pinning logic in the backup script promotes weeklies/monthlies to a distinct prefix so the lifecycle rule only culls unpinned dailies ([ADR-0020 §Decision](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision)).

### 3.4 Create the API token

1. R2 landing page → **Manage R2 API Tokens** → **Create API token**.
2. Permissions: **Object Read & Write**.
3. Specify bucket: **Apply to specific buckets only** → select `projekt-manager-backups`. No token TTL.
4. **Create API Token**. Capture immediately (these values appear once):
   - Access Key ID
   - Secret Access Key
   - Endpoint URL (form: `https://<accountid>.r2.cloudflarestorage.com`)
5. Paste all three into the password manager. The values feed §5.

## 4. Generate the age key pair

The private identity is the root of the recovery chain. Generate it on the laptop and never let it leave.

You are about to create long-lived private key material; this is reversible only by discarding the ciphertext it protects.

```bash
mkdir -p ~/secrets
age-keygen -o ~/secrets/age-backup.key
chmod 600 ~/secrets/age-backup.key
```

The identity file's first line is the public recipient, e.g.:

```
# created: 2026-04-17T12:00:00Z
# public key: age1xyz...longstring
AGE-SECRET-KEY-1...
```

Extract the recipient for the VPS:

```bash
age-keygen -y ~/secrets/age-backup.key
```

That single `age1...` line is what `AGE_RECIPIENT` takes in §5. The rest of the file — `AGE-SECRET-KEY-1...` — is the private identity; it stays on the laptop.

**Back up the private identity off-system.** Options, pick one and document it in the password manager:

- Encrypted USB kept in a physical safe.
- Offline password manager vault (e.g., KeePass DB on an air-gapped device).
- Paper printout in a sealed envelope, stored with other recovery material.

Losing the private identity forfeits every Tier 2 drill and every DR restore from encrypted R2 objects ([ADR-0020 §Consequences](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#consequences)). A single compromise invalidates future-read secrecy — rotate with §11 if suspected.

**Never** write the private identity to:

- Anywhere under the project working tree.
- `secrets.env.age` on the VPS.
- The VPS filesystem persistently (see §7 for the tmpfs-only drill flow).
- Any location tracked by git, cloud sync, or chat history.

## 5. Push R2 credentials + recipient to the VPS

After rotation or first setup, the VPS needs the new keys in `secrets.env.age`. This reuses the rotation flow in [ops/manual-deploy.md § Rotate a secret](../ops/manual-deploy.md#rotate-a-secret); the additions are the five Layer 2 keys.

You are about to replace the live backup credentials; this is reversible **only** if the previous `secrets.env.age` is still on hand. A fat-fingered edit with no prior copy overwrites the live file and leaves the VPS non-bootable.

1. On the laptop, pull the current VPS copy as a typo-recovery snapshot; keep it until step 6 succeeds. Then open the SSH session used for the upload:

   ```bash
   scp <admin-username>@<vps-hostname>:/opt/projekt-manager/secrets.env.age ./secrets.env.age.bak
   ssh <admin-username>@<vps-hostname>
   ```

2. On the laptop (not the VPS), assemble the new plaintext `secrets.env`:

   ```bash
   cat > /tmp/secrets.env <<'EOF'
   POSTGRES_PASSWORD='...'
   MINIO_ROOT_PASSWORD='...'
   CLOUDFLARE_API_TOKEN='...'
   R2_ACCESS_KEY_ID='...'
   R2_SECRET_ACCESS_KEY='...'
   R2_ENDPOINT='https://<accountid>.r2.cloudflarestorage.com'
   R2_BUCKET='projekt-manager-backups'
   R2_REGION='auto'
   AGE_RECIPIENT='age1xyz...'
   EOF
   ```

   The first three come from the current `secrets.env.age` — decrypt it locally first with `age -d secrets.env.age` if you don't have the plaintext handy. The five new keys come from §3.4 (R2 token) and §4 (age recipient).

3. Re-encrypt with the existing passphrase:

   ```bash
   age -p -o secrets.env.age /tmp/secrets.env
   shred -u /tmp/secrets.env
   ```

4. Upload and move into place:

   ```bash
   scp secrets.env.age <admin-username>@<vps-hostname>:/tmp/secrets.env.age
   ssh <admin-username>@<vps-hostname> "\
     sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age && \
     sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age && \
     sudo chmod 0600 /opt/projekt-manager/secrets.env.age"
   ```

5. Verify the new values round-trip:

   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy age -d /opt/projekt-manager/secrets.env.age | grep -E '^(R2_|AGE_RECIPIENT)'"
   ```

   You should see the five Layer 2 lines exactly as sent. If any value is missing or mangled, restore the pre-change snapshot (re-run the step-4 `scp` + `mv/chown/chmod` with `./secrets.env.age.bak` as the source) and repeat from step 2. Do not iterate against a broken file.

   After the deploy in §6 succeeds, `shred -u ./secrets.env.age.bak` on the laptop — the snapshot is a window into live credentials and should not linger. Caveat (L2): on journalled filesystems (ext4 default, APFS) `shred` is largely ceremonial — the data blocks may have multiple committed copies the call cannot reach. Treat the deleted backup as "removed from the normal access path", not "cryptographically destroyed". `shred` is still net-better than plain `rm`; do not downgrade to `rm`.

## 6. First deploy after rotation

Pick up the new env values. This is a normal deploy; the backup service reads the new keys at container start.

You are about to cycle the running stack; the running app/db/storage containers survive the pull, the `backup` container is recreated.

```bash
ssh <admin-username>@<vps-hostname> "sudo -u deploy /opt/projekt-manager/scripts/deploy.sh"
```

`scripts/deploy.sh` decrypts `secrets.env.age`, exports all keys into the compose env, pulls the pinned image, `docker compose up -d` (which includes the `backup` service), and polls `/api/health` ([ops/manual-deploy.md](../ops/manual-deploy.md)).

> Any manual `docker compose up` / `pull` / `logs` invocation outside `scripts/deploy.sh` must be run with `APP_IMAGE_TAG=<sha-or-tag>` in the environment. Both the `app` and `backup` services are gated by `${APP_IMAGE_TAG:?...}` in `docker-compose.yml` (H2 audit finding) and will refuse to start without one. `scripts/deploy.sh` already exports it from the resolved SHA; only ad-hoc operator invocations need to set it by hand.

After the deploy settles, verify the backup service is healthy:

```bash
ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml logs --tail=50 backup"
```

First-run expectations, in order:

1. The cron entry inside the `backup` container logs a wake-up at the configured interval.
2. A run writes a row into `meta_backup_status` with `lastBackupOk = true` and a fresh `lastBackupAt` (AC-166).
3. Three R2 objects appear under `projekt-manager-backups`: `daily/<iso>.dump.age`, `daily/<iso>.manifest.json.age`, and `status/latest.json`.
4. The freshness badge on the login screen turns green (amber if no Tier 2 drill has run yet — that is expected until §7).

Sanity-check the status mirror from the laptop, using the new token. The bucket is private — unsigned calls return 401, so every fetch is signed:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/status/latest.json" /tmp/latest.json \
  --endpoint-url "$R2_ENDPOINT"

jq '.' /tmp/latest.json
```

Expected shape (from [data-model.md §5.9](../spec/data-model.md#59-backup-status-entity)):

```json
{
  "lastBackupAt": "2026-04-17T02:00:12Z",
  "lastBackupOk": true,
  "lastDrillAt": null,
  "lastDrillOk": null,
  "lastError": null,
  "updatedAt": "2026-04-17T02:00:12Z"
}
```

Failure modes:

| Symptom                                     | Likely cause                                           | Fix                                                                          |
| ------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `AccessDenied` writing to R2                | Token scoped to the wrong bucket                       | Recreate token per §3.4, rerun §5, redeploy.                                 |
| `Key not recognised` / `no valid recipient` | `AGE_RECIPIENT` is the private identity, not `age1...` | Rerun §4 extraction with `age-keygen -y`, rerun §5.                          |
| `meta_backup_status.lastBackupOk = false`   | Tier 1 mismatch or upload failure                      | `docker compose logs backup` — `lastError` names the failing table. See §10. |
| No row in `meta_backup_status` at all       | Cron never fired; service crash-looping                | `docker compose ps backup`, `docker compose logs backup --tail=200`.         |

## 7. Load the drill key (`load-drill-key.sh`)

Tier 2 drills need the private identity on the VPS. The script writes it to a tmpfs mount inside the `backup` container and never anywhere else.

**Location:** `/opt/projekt-manager/scripts/load-drill-key.sh` in the repo; the backup container mounts it read-only and exposes it as `docker compose exec backup /usr/local/bin/load-drill-key`. The tmpfs target inside the container is `/run/drill-key/identity` (tmpfs, mode 0600, owned by the backup user).

You are about to write private key material into RAM on the VPS; this is cleared on reboot or on container recreation, and can be overwritten by rerunning the script.

1. Have `~/secrets/age-backup.key` open on the laptop. Copy its full contents (including the comment lines and the `AGE-SECRET-KEY-1...` body) to the clipboard.

2. On the VPS:

   ```bash
   ssh <admin-username>@<vps-hostname>
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     exec backup /usr/local/bin/load-drill-key
   ```

3. The script prompts with `read -s` ("Paste age identity, end with Ctrl-D:"). Paste the clipboard contents, press Enter, then Ctrl-D. The script:
   - Validates the first line is `# public key: age1...` and that it matches `AGE_RECIPIENT`.
   - Writes the identity to `/run/drill-key/identity` (tmpfs, 0600).
   - Zeros its own buffer before exit.

4. Verify the key is loaded without exposing it:

   ```bash
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     exec backup test -s /run/drill-key/identity && echo "drill key loaded"
   ```

   The next cron tick picks it up: `meta_backup_status.lastDrillAt` advances, `lastDrillOk = true`, the badge flips green.

5. **After every VPS reboot or container recreate, the key is gone.** Reload by repeating steps 2–3. Until you do, Tier 2 is skipped (not failed — AC-168), but the badge turns amber ("Drill-Schlüssel neu laden") after the staleness threshold **[C]**.

**Never** write the identity to any path other than `/run/drill-key/identity`. Specifically: not to a bind mount, not to `/opt/projekt-manager`, not to an env var in `secrets.env.age`, not to `docker compose exec backup sh -c 'echo ... >'`. A persisted copy on the VPS disk defeats the entire threat model ([AC-175](../spec/verification.md#1522-backup-and-recovery)).

> **Phase 3 note:** `scripts/load-drill-key.sh` and the `backup` compose service do not yet exist. This runbook describes the expected shape; Phase 3 implements both. When implemented, the actual paths and prompt wording supersede this text.

## 8. Disaster-recovery restore (laptop)

Run when production PostgreSQL data is lost, corrupt, or diverged. The laptop is the trusted enclave; the VPS is not involved until the final step.

### 8.1 Pick the dump

If the app is still partially up, check via the login-screen badge or the owner's authenticated landing view (AC-170). Otherwise pull the unencrypted status mirror (`status/latest.json`) from R2 using the signed fetch pattern in §8.2:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/status/latest.json" - \
  --endpoint-url "$R2_ENDPOINT" | jq .
```

List the daily artifacts and pick the newest `lastBackupOk = true` timestamp:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 ls "s3://projekt-manager-backups/daily/" \
  --endpoint-url "$R2_ENDPOINT"
```

### 8.2 Download

```bash
TS='2026-04-17T02-00-12Z'   # replace with the selected timestamp
mkdir -p ~/restore && cd ~/restore

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/daily/${TS}.dump.age" . \
  --endpoint-url "$R2_ENDPOINT"

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/daily/${TS}.manifest.json.age" . \
  --endpoint-url "$R2_ENDPOINT"
```

### 8.3 Decrypt

```bash
age -d -i ~/secrets/age-backup.key "${TS}.dump.age"         > "${TS}.dump"
age -d -i ~/secrets/age-backup.key "${TS}.manifest.json.age" > "${TS}.manifest.json"
```

If either decrypt fails with `no identity matched any of the recipients`, the dump was encrypted to a different public key. You are either holding the wrong identity file, or the key was rotated (see §11) and these objects predate the current pair.

### 8.4 Restore into a scratch Postgres

You are about to start a throwaway container. This is fully reversible — it touches no production data.

```bash
docker run --rm -d \
  --name pm-restore-scratch \
  -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_DB=projekt_manager \
  -e POSTGRES_USER=pm \
  -p 55432:5432 \
  postgres:17-alpine

# Wait for readiness
until docker exec pm-restore-scratch pg_isready -U pm -d projekt_manager >/dev/null 2>&1; do sleep 1; done

# Restore
docker exec -i pm-restore-scratch pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U pm -d projekt_manager < "${TS}.dump"
```

### 8.5 Verify against the manifest

The manifest is the per-table row count + deterministic checksum computed at backup time ([ADR-0020 §Decision](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision), [AC-174](../spec/verification.md#1522-backup-and-recovery)). Recomputing against the scratch DB and comparing proves the encrypted round-trip end-to-end (AC-165 equality property).

PK ordering is load-bearing — the checksum is order-sensitive ([ADR-0020 §Decision](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision)). Current schema PKs ([src/server/db/schema.ts](../../src/server/db/schema.ts)): `users`/`customers`/`projects` use `id`; `project_workers` uses the composite `(project_id, user_id)`. `sessions` is excluded from the backup by manifest construction.

```bash
jq -r '.tables | to_entries[] | "\(.key)\t\(.value.count)\t\(.value.checksum)"' "${TS}.manifest.json" \
  > expected.tsv

# ORDER BY must match the per-table PK above; a new table with a different PK
# needs its row added here and in the manifest generator in lockstep.
pk_for() {
  case "$1" in
    users|customers|projects) echo "id" ;;
    project_workers)          echo "project_id, user_id" ;;
    *) return 1 ;;
  esac
}

while IFS=$'\t' read -r table count checksum; do
  order_by=$(pk_for "$table") || { echo "UNKNOWN TABLE in manifest: ${table} — add a PK mapping and rerun"; continue; }
  actual_count=$(docker exec pm-restore-scratch psql -U pm -d projekt_manager -tAc \
    "SELECT count(*) FROM ${table};")
  actual_checksum=$(docker exec pm-restore-scratch psql -U pm -d projekt_manager -tAc \
    "SELECT md5(string_agg(md5(row(t.*)::text), '' ORDER BY ${order_by})) FROM ${table} t;")
  if [ "$actual_count" != "$count" ] || [ "$actual_checksum" != "$checksum" ]; then
    echo "MISMATCH on ${table}: expected ${count}/${checksum}, got ${actual_count}/${actual_checksum}"
  fi
done < expected.tsv
```

Any `MISMATCH` line is a fatal finding — stop, escalate to §10. A clean pass means the encrypted archive round-trips against manifest — the restore is trustworthy.

Tear down the scratch container:

```bash
docker stop pm-restore-scratch
```

### 8.6 Restore into production

Two paths exist; this runbook supports **(a) only**. Path (b) — targeted table-level restore — is out of scope for this iteration.

**(a) Rebuild the VPS DB volume (maintenance window, downtime).** You are about to destroy the current `pgdata` volume and replace it with the restored state. This is irreversible on the live volume.

1. Announce the maintenance window.
2. On the VPS, stop the stack:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml stop app caddy"
   ```
3. Copy the decrypted dump to the VPS:
   ```bash
   scp "${TS}.dump" <admin-username>@<vps-hostname>:/tmp/
   ssh <admin-username>@<vps-hostname> "sudo chown deploy:deploy /tmp/${TS}.dump"
   ```
4. Drop and recreate the DB, then restore:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     exec -T db psql -U pm -d postgres -c 'DROP DATABASE projekt_manager; CREATE DATABASE projekt_manager;'"
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     exec -T db pg_restore --clean --if-exists --no-owner --no-privileges -U pm -d projekt_manager < /tmp/${TS}.dump"
   ```
5. Shred the plaintext dump from the VPS:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo shred -u /tmp/${TS}.dump"
   ```
6. Restart the stack and verify:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy /opt/projekt-manager/scripts/deploy.sh"
   ```

**(b) Targeted restore.** Not in scope. If a partial restore is required, open an issue with the affected tables and timestamp; do not attempt without a new runbook entry.

### 8.7 Post-restore checklist

- [ ] `curl https://${DOMAIN}/api/health` returns 200 from a WireGuard client.
- [ ] Log in as the owner; confirm project counts match the manifest expectations.
- [ ] `meta_backup_status` row exists and is fresh (the first post-restore cron tick will overwrite it).
- [ ] Freshness badge renders green after the next backup run.
- [ ] Shred local copies: `shred -u ~/restore/${TS}.dump ~/restore/${TS}.manifest.json`.
- [ ] Rotate any credentials that may have been exposed during the incident (§11).

## 9. Monthly operator drill

Tier 2 drills run on every backup when the key is loaded, but only on the VPS and only against the just-uploaded artifact. Tier 2 exercises encrypt → upload → download → decrypt against the VPS-side `age` binary and R2 endpoint — so it catches pipeline and provider drift as seen from that host. The monthly laptop-side drill closes the loop against the laptop-vs-VPS gap Tier 2 cannot see:

- Tooling drift between operator laptop and VPS — e.g., a laptop running a newer `age` version that reads the VPS-produced header fine today but changes output next month, or a `pg_restore` major-version gap that only surfaces on the laptop path during a real DR.
- OS/libc gap between the two environments, invisible to Tier 2 because Tier 2 never exercises the laptop toolchain.

The drill is §8.1 through §8.5 (download, decrypt, scratch restore, manifest verify) — **stop before §8.6.** No production changes.

Record the result in `~/ops-log/backup-drill-YYYY-MM.md` (create if absent) or in your operations calendar entry. Include: dump timestamp, pass/fail, any mismatch details, laptop `age --version`.

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.

## 10. Backup service is broken

When `meta_backup_status.lastBackupOk` stays `false`, the service crash-loops, or manifests don't match.

**First-line diagnostics (5 minutes):**

```bash
ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps backup"
ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml logs backup --tail=200"
ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
  exec -T db psql -U pm -d projekt_manager -c 'SELECT * FROM meta_backup_status;'"
```

`lastError` is a short machine cue from the backup script — the log tail carries the detail.

**Second-line (disable cron, deep-dive):**

1. Stop the scheduled runs so you can iterate:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml stop backup"
   ```
2. Run a one-shot manually and read the full output:
   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     run --rm backup /usr/local/bin/run-backup-once"
   ```
3. Common buckets: R2 credential (re-run §5), age recipient mismatch (re-run §5 with `age-keygen -y`), PostgreSQL connectivity (check `db` container health), manifest algorithm drift (check AC-174 determinism — run the checksum query twice on the same snapshot and compare).

**Escalation threshold.** If you cannot restore the most recent green-labelled backup to a scratch DB per §8.1–§8.5, the backup is not a backup. Do not accept the system as healthy. Next steps: (i) step back one day and retry; (ii) if every available dump fails, prepare for full reconstruction from Layer 1 business-data export ([api.md §14.2.4](../spec/api.md#1424-unified-data-exchange)) plus a fresh admin bootstrap (see the "First-login ritual" phase in [ops/server-setup.md](../ops/server-setup.md)). This reconstruction loses users, sessions, and audit FKs — it is worst-case recovery, not a replacement for Layer 2.

## 11. Credential rotation — full dance

The feature was designed to make this routine. Do it any time an R2 token is suspected of leak, staff handover, or on a scheduled interval (recommended: annually).

You are about to burn the current credentials; older encrypted backups in R2 remain readable only if you keep the corresponding age identity.

**Before step 1 — quiesce the scheduler.** Stop the backup service so it does not accumulate `AccessDenied` errors against the dead token while steps 1–5 are in flight. The badge will fall stale until step 6 completes; that is expected.

```bash
ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml stop backup"
```

1. **Burn the R2 token.** Cloudflare dashboard → R2 API Tokens → select the current token → **Delete**. Confirm. Every client using this token fails on its next call — the scheduler is already stopped, so the VPS side stays quiet.

2. **Issue a fresh R2 token.** Re-run §3.4. Capture the new Access Key ID, Secret Access Key, Endpoint URL.

3. **(Optional) Rotate the age key pair.** Do this if the private identity is suspected compromised, a laptop was lost, or on a slower cadence than the token rotation.

   Cost: older R2 objects encrypted to the old recipient become unreadable by the new identity. Options:
   - **Accept the gap.** Old dumps age out under the 30-day lifecycle. For the 14-day immutability window, any restore must still use the old identity — keep it in the password manager, marked "retired, read-only".
   - **Re-encrypt the lock window.** For each still-locked old object: download, `age -d -i ~/secrets/age-backup.key.old`, `age -r <new-recipient>`, re-upload under a new timestamped key. Labour-intensive; skip unless the old identity is confirmed compromised.

   To rotate: rerun §4 with `~/secrets/age-backup.key.new`, update the password-manager entries, move the old identity to a "retired" vault.

4. **Push the new creds to the VPS.** Rerun §5 with the new R2 values and (if rotated) the new `AGE_RECIPIENT`.

5. **Redeploy.** Rerun §6.

6. **Restart the scheduler.** Bring the backup service back up so the next interval tick fires. No-op if the redeploy in step 5 already recreated and started the `backup` container; otherwise this flips it from the pre-step-1 stopped state:

   ```bash
   ssh <admin-username>@<vps-hostname> "sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml start backup"
   ```

7. **Sanity-check.** Immediately run the monthly drill per §9 against the next completed backup. A rotation that passes the drill is successfully done; a rotation whose drill fails is a rollback candidate — restore the previous `secrets.env.age` from the password manager and investigate before retrying.

## 12. Escalation

The project is currently single-operator. The owner (Vladimir) is the escalation contact for every failure class above. If the owner is unavailable and the outage blocks business operations, the fallback plan is the Layer 1 business-data export ([ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md)) restored onto a fresh bootstrap — partial recovery, no users/sessions/audit, but projects and customers survive.

Review this section at every staffing change.
