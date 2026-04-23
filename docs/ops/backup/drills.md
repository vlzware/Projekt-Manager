# Layer 2 Backup — Drills

Tier 2 drills prove the encrypted round-trip on the real R2 endpoint. There are two kinds:

- **Tier 2 in-container drill** — runs on every backup tick (offset +2 min), unattended, but only when the operator's private identity is loaded into the VPS tmpfs. See [§ Loading the drill key](#loading-the-drill-key-on-the-vps).
- **Monthly operator-workstation drill** — a manual end-to-end restore the operator performs on their own machine. Closes the gap Tier 2 cannot see. See [§ Monthly drill](#monthly-operator-workstation-drill).

Concept map: [overview.md](overview.md). Design rationale: [ADR-0020 §Decision](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision).

## Loading the drill key on the VPS

Tier 2 needs the private identity on the VPS. `load-drill-key.sh` writes it to a tmpfs mount inside the `backup` container and never anywhere else ([AC-175](../../spec/verification.md#1522-backup-and-recovery)).

**Location:** `scripts/backup/load-drill-key.sh` in the repo. `Dockerfile.backup` copies it into the image at `/usr/local/bin/load-drill-key` (no `.sh`) — that is the only path the operator ever invokes, via `docker exec` into the running backup container. The tmpfs target inside the container is `/run/drill-key/identity` (file mode 0400, owned by root; the tmpfs mount itself is mode 0700 uid 0 — the container runs as root).

You are about to write private key material into RAM on the VPS; this is cleared on reboot or on container recreation, and can be overwritten by rerunning the script.

1. Have `~/secrets/age-backup.key` open on the operator workstation. Copy its full contents (including the comment lines and the `AGE-SECRET-KEY-1...` body) to the clipboard.
2. SSH to the VPS as the admin user. Use `docker exec` directly, not `pm-compose.sh exec` — the wrapper re-parses `docker-compose.yml`, which requires the full set of interpolation vars (`POSTGRES_PASSWORD`, `CLOUDFLARE_API_TOKEN`, etc.) in shell env; without them compose parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903). `-it` allocates a pseudo-TTY so the script's `read -s` actually suppresses echo during the paste:

   ```bash
   sudo -u deploy docker exec -it projekt-manager-backup-1 load-drill-key
   ```

3. The script prompts with `read -s` ("Paste age identity, end with Ctrl-D:"). Paste the clipboard contents, press Enter, then Ctrl-D. The script:
   - Validates the first line is `# public key: age1...` and that it matches `AGE_RECIPIENT`.
   - Writes the identity to `/run/drill-key/identity` (tmpfs, mode 0400, root-owned).
   - Zeros its own buffer before exit.

4. Verify the key is loaded without exposing it:

   ```bash
   sudo -u deploy docker exec projekt-manager-backup-1 \
     test -s /run/drill-key/identity && echo "drill key loaded"
   ```

   The next cron tick picks it up: `meta_backup_status.lastDrillAt` advances, `lastDrillOk = true`, the badge flips green.

5. **After every VPS reboot or container recreate, the key is gone.** Reload by repeating steps 2–3. Until you do, Tier 2 is skipped (not failed — [AC-168](../../spec/verification.md#1522-backup-and-recovery)), but the badge turns amber ("Drill-Schlüssel neu laden") after the staleness threshold **[C]**.

**Never** write the identity to any path other than `/run/drill-key/identity`. Specifically: not to a bind mount, not to `/opt/projekt-manager`, not to an env var in `secrets.env.age`, not to `docker compose exec backup sh -c 'echo ... >'`. A persisted copy on the VPS disk defeats the entire threat model ([AC-175](../../spec/verification.md#1522-backup-and-recovery)).

## Monthly operator-workstation drill

Tier 2 in-container drills exercise encrypt → upload → download → decrypt against the VPS-side `age` binary and R2 endpoint. They catch pipeline and provider drift as seen from that host. The monthly workstation-side drill closes the gap between the VPS and the operator toolchain:

- Tooling drift between operator workstation and VPS — e.g., a workstation running a newer `age` version that reads the VPS-produced header fine today but changes output next month, or a `pg_restore` major-version gap that only surfaces on the workstation path during a real DR.
- OS/libc gap between the two environments, invisible to Tier 2 because Tier 2 never exercises the workstation toolchain.

**Procedure:** run [recovery.md steps 1–5](recovery.md) (download, decrypt, scratch restore, manifest verify) — **stop before step 6.** No production changes.

Record the result in `~/ops-log/backup-drill-YYYY-MM.md` (create if absent) or in your operations calendar entry. Include: dump timestamp, pass/fail, any mismatch details, workstation `age --version`.

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.
