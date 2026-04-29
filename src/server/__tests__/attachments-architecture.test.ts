/**
 * Architecture-level invariants for the attachment subsystem.
 *
 *   - AC-179 Part 2: the attachment table is in the audited-table set
 *     the CI check (`scripts/check-audit-mutations.sh`) scans. The
 *     check derives its set from `AUDIT_ENTITY_TO_TABLE` via
 *     `scripts/print-audited-tables.ts`. `attachment` is a first-class
 *     member of `AuditEntityType` (data-model.md §5.10), so the map
 *     entry + derivation carry the table into the scan automatically —
 *     no special-case append needed. A new audited table that ships
 *     without observing the mutation surface is exactly the fail-open
 *     that AC-179 forbids.
 *
 *   - AC-221: no attachment route handler accepts a raw/multipart
 *     body. The upload path is presigned-PUT direct-to-storage; the
 *     only attachment endpoints on the app are init, complete, delete,
 *     list, download-url, bulk-download — all JSON control plane.
 *     "No byte traffic through the app" (api.md §14.2.11 design note)
 *     is load-bearing for module scalability and is pinned by a
 *     structural assertion parallel to AC-179.
 *
 * Both assertions are structural, not behavioral. They run without
 * startApp() — both inspect source / config directly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------
// AC-179 Part 2 — attachment table in the audited-table surface.
// ---------------------------------------------------------------------

describe('AC-179: attachment table wired into the audit-mutation architecture check', () => {
  it('the AuditEntityType enum includes `attachment` as a first-class member', async () => {
    // Promoting `attachment` into the enum is what drives the audited-
    // table derivation in scripts/print-audited-tables.ts. Prior to this
    // promotion the table was appended by hand in check-audit-mutations.sh —
    // a workaround the enum change eliminates.
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const entityTypes = schemaModule.AUDIT_ENTITY_TYPES as readonly string[];
    expect(entityTypes).toContain('attachment');
  });

  it('the audited-table set exposed to scripts/check-audit-mutations.sh includes `attachments`', async () => {
    // The audit check derives its scan set from the AUDIT_ENTITY_TO_TABLE
    // map. With `attachment` in AuditEntityType, the Record<AuditEntityType, …>
    // satisfies clause forces the map entry — the `attachments` table is
    // picked up automatically. A new audited table that ships without
    // observing its mutation surface is the fail-open this check forbids.
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const map = schemaModule.AUDIT_ENTITY_TO_TABLE as Record<
      string,
      { sqlName: string; drizzleExport: string }
    >;
    const sqlNames = Object.values(map).map((v) => v.sqlName);
    expect(sqlNames).toContain('attachments');
  });

  it('the Drizzle export set exposed to the check includes the `attachments` table', async () => {
    const schemaModule = (await import('../db/schema.js')) as Record<string, unknown>;
    const map = schemaModule.AUDIT_ENTITY_TO_TABLE as Record<
      string,
      { sqlName: string; drizzleExport: string }
    >;
    const drizzleExports = Object.values(map).map((v) => v.drizzleExport);
    expect(drizzleExports).toContain('attachments');
  });

  it('check-audit-mutations.sh carries no manual append for `attachments` — derivation is the sole source', () => {
    // Regression guard against the pre-promotion workaround: the shell
    // script appended `attachments` to AUDITED_TABLE_SQL_NAMES /
    // AUDITED_DRIZZLE_EXPORTS by hand because `attachment` was outside
    // the enum. With enum promotion the append must be gone.
    const scriptSrc = readSource('scripts/check-audit-mutations.sh');
    expect(scriptSrc).not.toMatch(/AUDITED_TABLE_SQL_NAMES\+=\("attachments"\)/);
    expect(scriptSrc).not.toMatch(/AUDITED_DRIZZLE_EXPORTS\+=\("attachments"\)/);
  });

  it('the reaper path (src/server/services/attachment-orphan-reaper.ts) is allowlisted in check-audit-mutations.sh', () => {
    // The spec names the reaper as an allowlisted bypass (it deletes
    // attachment rows outside mutate() — pending orphans never entered
    // the domain, so there is no audit event to emit). An allowlist
    // entry must land with the reaper.
    const scriptSrc = readSource('scripts/check-audit-mutations.sh');
    expect(scriptSrc).toContain('src/server/services/attachment-orphan-reaper.ts');
  });
});

// ---------------------------------------------------------------------
// AC-221 — No byte proxy through the app.
// ---------------------------------------------------------------------

describe('AC-221: no attachment route accepts a raw/multipart body', () => {
  const ROUTES_SRC = readSource('src/server/routes/attachments.ts');

  it('the attachment routes file imports no multipart parser', () => {
    // @fastify/multipart would register parsers for multipart/form-data
    // and turn Fastify into a byte proxy for upload payloads. AC-221
    // bans any such dependency on the attachment surface.
    expect(ROUTES_SRC).not.toContain('@fastify/multipart');
    expect(ROUTES_SRC).not.toContain('fastify-multipart');
    expect(ROUTES_SRC).not.toContain('fastify-formidable');
    expect(ROUTES_SRC).not.toContain('busboy');
  });

  it('the attachment routes file does not register a raw or octet-stream content-type parser', () => {
    // addContentTypeParser with octet-stream or wildcard would accept
    // arbitrary request bodies. The JSON control plane is the only
    // admissible surface.
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]application\/octet-stream/);
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]multipart\//);
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*['"]\*\/\*/);
    // `addContentTypeParser` with the first argument being a plain
    // bare "'*'" wildcard is equally broad — catch that too.
    expect(ROUTES_SRC).not.toMatch(/addContentTypeParser\s*\(\s*'\*'/);
  });

  it('only the eight documented endpoints are registered under /api/projects/:id/attachments', () => {
    // The documented control plane per api.md §14.2.11 + ADR-0022:
    //   GET    /api/projects/:id/attachments                             (list — ready only)
    //   POST   /api/projects/:id/attachments/init                        (init)
    //   POST   /api/projects/:id/attachments/:attId/complete             (complete)
    //   DELETE /api/projects/:id/attachments/:attId                      (soft-hide)
    //   GET    /api/projects/:id/attachments/:attId/download-url         (download URL)
    //   POST   /api/projects/:id/attachments/bulk-download               (bulk download URL)
    //   GET    /api/projects/:id/attachments/trash                       (Papierkorb listing)
    //   POST   /api/projects/:id/attachments/:attId/restore              (Papierkorb restore)
    //
    // Pinning the registrations here prevents a subsequent PR from
    // adding a 9th route that quietly accepts bytes.
    const methodPathRegistrations = [
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/init['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/complete['"]/,
      /app\.delete\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId['"]/,
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/download-url['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/bulk-download['"]/,
      /app\.get\s*\(\s*['"]\/api\/projects\/:id\/attachments\/trash['"]/,
      /app\.post\s*\(\s*['"]\/api\/projects\/:id\/attachments\/:attId\/restore['"]/,
    ];
    for (const re of methodPathRegistrations) {
      expect(ROUTES_SRC).toMatch(re);
    }

    // No other verb-method combinations on an `/api/projects/:id/attachments`
    // path. A 9th endpoint is a regression — either a genuine new
    // capability (which needs its own AC + review) or a byte-proxy slip.
    const attachmentRegistrationCount = (
      ROUTES_SRC.match(
        /app\.(get|post|put|patch|delete)\s*\(\s*['"]\/api\/projects\/:id\/attachments/g,
      ) ?? []
    ).length;
    expect(attachmentRegistrationCount).toBe(methodPathRegistrations.length);
  });

  it('the attachment routes file does not declare a raw-body route config', () => {
    // Fastify exposes a route-level `rawBody: true` or `bodyLimit: <large>`
    // that lets a handler receive arbitrary bytes. Neither is admissible
    // on the attachment surface. `bodyLimit` is a number — we check for
    // the presence of either verbatim string in the routes file.
    expect(ROUTES_SRC).not.toMatch(/rawBody\s*:\s*true/);
    // A route setting bodyLimit to an arbitrary-large number is another
    // proxy-smell; the JSON control plane never needs it.
    expect(ROUTES_SRC).not.toMatch(/bodyLimit\s*:\s*\d{7,}/);
  });
});
