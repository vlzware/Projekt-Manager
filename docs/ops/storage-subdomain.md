# Storage subdomain setup

Attachment uploads require the browser to POST directly to MinIO via a presigned URL ([AC-221](../spec/verification.md#1526-attachments)). The app signs those URLs against `STORAGE_PUBLIC_ENDPOINT`, which must be a hostname the browser can resolve — the Docker-internal `storage:9000` is not.

This runbook wires up `storage.<DOMAIN>` as a reverse-proxied subdomain so presigned URLs work.

## Symptom this fixes

Attachments stall with "Änderung fehlgeschlagen — erneut versuchen" after "Vorbereiten…". In the database, every row sits at `status='pending'` and the orphan reaper sweeps them after the TTL. App logs show init and complete calls, but no corresponding POSTs to MinIO — because the browser's POST to `http://storage:9000/...` never leaves the client, failing at DNS resolution.

## Prerequisites

- The base deployment from `server-setup.md` + `caddy-tls-bootstrap.md` is in place.
- `${DOMAIN}` is set in `.env` on the VPS (e.g. `DOMAIN=prmng.org`).
- The Cloudflare API token in `secrets.env.age` has `Zone:DNS:Edit` on the parent zone — same scope Caddy already uses for `${DOMAIN}`. No additional permission needed.

## One-time setup

### 1. DNS record

Add a single record at your DNS provider for `storage.<DOMAIN>`:

- **Type**: `CNAME` pointing to `<DOMAIN>` (recommended — tracks the parent if the VPS IP ever changes)
- **Or**: `A` record pointing to the VPS IP (grey-cloud in Cloudflare if `<DOMAIN>` is also grey-cloud)

Match the Cloudflare proxy state (orange vs grey cloud) of the parent record. If the parent is orange-clouded, remember that the free plan caps proxied request bodies at 100 MB; this only bites if `ATTACHMENT_PER_FILE_CAP_BYTES` is ever raised above that.

Verify propagation:

```bash
dig +short storage.<DOMAIN>
# should match `dig +short <DOMAIN>`
```

### 2. Code already landed

No code change needed on first-time setup after the fix landed. These were added once and ship with the image:

- `Caddyfile` — `storage.{$DOMAIN}` block with DNS-01 TLS and `reverse_proxy storage:9000`.
- `docker-compose.yml` — `STORAGE_PUBLIC_ENDPOINT: https://storage.${DOMAIN}` on the app service; `MINIO_API_CORS_ALLOW_ORIGIN: https://${DOMAIN}` on the storage service.
- `src/server/config/env.ts` — `assertStoragePublicEndpointInProduction()` refuses to boot if `STORAGE_ENDPOINT` looks internal and `STORAGE_PUBLIC_ENDPOINT` is unset.

### 3. Deploy

Normal deploy procedure from [manual-deploy.md](manual-deploy.md):

```bash
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

Caddy requests a Let's Encrypt cert for `storage.<DOMAIN>` via DNS-01 on first hit. No cert bootstrap steps needed — DNS-01 works offline (no inbound HTTP challenge to answer).

### 4. Verify

From a browser on WireGuard:

1. Log in to the app.
2. Upload a document attachment on any project.
3. Check the database:

   ```bash
   docker exec projekt-manager-db-1 \
     psql -U pm -d projekt_manager \
     -c "select status, mime_type, size_bytes, created_at from attachments order by created_at desc limit 5;"
   ```

   The new row should be `ready`, not `pending`.

4. Reload the project page. The attachment should render in the gallery / binary list and open via its presigned GET URL.

If still pending, see [Troubleshooting](#troubleshooting).

## Troubleshooting

### App refuses to start

```
Refusing to start: STORAGE_ENDPOINT (http://storage:9000) is a container-only
hostname but STORAGE_PUBLIC_ENDPOINT is not set.
```

`STORAGE_PUBLIC_ENDPOINT` is missing from `services.app.environment` in compose, or `${DOMAIN}` did not interpolate. Confirm `.env` on the VPS has a non-empty `DOMAIN` and the compose file's app service block has `STORAGE_PUBLIC_ENDPOINT: https://storage.${DOMAIN}`.

### Caddy fails to issue a cert for `storage.<DOMAIN>`

Check Caddy logs:

```bash
docker logs projekt-manager-caddy-1 2>&1 | grep -i 'storage\|tls\|acme' | tail -40
```

Typical causes:

- **DNS not propagated yet** — retry after a few minutes.
- **`CLOUDFLARE_API_TOKEN` lacks DNS edit permission on the zone** — rotate the token with `Zone:DNS:Edit` on the `<DOMAIN>` zone.
- **DNS record points at the wrong IP** — `dig +short storage.<DOMAIN>` should match the parent.

### CORS rejection on upload

Browser console shows `Access-Control-Allow-Origin` errors. Check MinIO logs for the CORS preflight and confirm `MINIO_API_CORS_ALLOW_ORIGIN` matches the origin the browser is sending:

```bash
docker exec projekt-manager-storage-1 env | grep CORS
```

Value must be exactly `https://<DOMAIN>` (no trailing slash, no wildcard unless you intentionally widened it).

### Presigned POST returns 403 SignatureDoesNotMatch

MinIO saw a different Host in the incoming request than the signer used. This means Caddy is rewriting the Host header before forwarding. Default Caddy behaviour preserves Host — confirm nothing in the Caddyfile set `header_up Host` to a different value.

### Uploads still fail with network errors

Open the browser devtools Network tab, attempt an upload, and inspect the POST to `storage.<DOMAIN>`:

- **`net::ERR_NAME_NOT_RESOLVED`** — DNS not live, or the browser is not on WireGuard. Both `<DOMAIN>` and `storage.<DOMAIN>` resolve to the WireGuard IP.
- **`ERR_CERT_AUTHORITY_INVALID`** — first-request cert issuance may have failed; check Caddy logs.
- **200 OK** on POST + pending row flipping to ready — working as intended.

## Related

- [ADR-0008](../adr/0008-network-topology-caddy-wireguard.md) — network topology rationale.
- [docs/spec/verification.md AC-221](../spec/verification.md#1526-attachments) — "uploads go direct browser → storage, app does not proxy bytes."
- [ARCHITECTURE.md § Attachments Module / Internal vs public storage endpoint](../../ARCHITECTURE.md#internal-vs-public-storage-endpoint) — design rationale.
