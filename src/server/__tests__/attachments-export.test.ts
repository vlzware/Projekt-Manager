/**
 * API integration tests — attachment export envelope (AC-220).
 *
 * Pins the export-envelope extension from data-model.md §5.8:
 *
 *   interface ExportEnvelope {
 *     schema_version: number;
 *     exported_at: string;
 *     customers: Customer[];
 *     projects: Project[];
 *     project_workers: { projectId, userId }[];
 *     attachments: Attachment[];  // status='ready' only
 *   }
 *
 * Invariants under test:
 *   - Export body carries an `attachments` array.
 *   - Every `status='ready'` row appears.
 *   - `status='pending'` rows are excluded.
 *   - Round-trip (export → import into an empty DB → re-export) preserves
 *     ids on the restored rows — this is the AC-137 "id-preserving
 *     import" semantics extended to attachments.
 *
 * Bytes stay in storage per ADR-0018 and are NOT part of the envelope;
 * this file does not assert on backing-object presence — a restored
 * row whose bytes are missing renders "Datei fehlt" in the UI, which
 * is covered by AC-224 at the E2E layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

interface AttachmentSeed {
  id?: string;
  projectId: string;
  status: 'pending' | 'ready';
  label?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind?: 'photo' | 'binary';
}

async function seedAttachment(spec: AttachmentSeed): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = spec.id ?? crypto.randomUUID();
    const kind = spec.kind ?? (spec.mimeType?.startsWith('image/') ? 'photo' : 'binary');
    const label = spec.label ?? 'sonstiges';
    const fileName = spec.fileName ?? `file-${id.slice(0, 6)}`;
    const mimeType = spec.mimeType ?? 'application/pdf';
    const sizeBytes = spec.sizeBytes ?? 1024;
    const originalKey = `attachments/${spec.projectId}/${id}.orig`;
    const thumbKey = kind === 'photo' ? `attachments/${spec.projectId}/${id}.thumb` : null;
    // Synthetic wrapped envelopes — the seeded rows do not need to be
    // unwrappable; AC-220 only pins that the column rides the export
    // envelope byte-for-byte. Real envelope shape is the `age` X25519
    // KEM output wrapped in base64 — the seed uses base64 of opaque
    // bytes (length differs per blob to detect a regression that
    // copied one column over another). Ciphertext sizes mirror the
    // plaintext sizes for the seeded fixture; the row's
    // `ciphertext_size_bytes` column is what the export envelope
    // surfaces. (Numerical relationship between plaintext and
    // ciphertext is implementation-defined per api.md §14.2.11.)
    const wrappedDek = Buffer.from(`wrapped-orig-${id}`).toString('base64');
    const wrappedThumbDek =
      kind === 'photo' ? Buffer.from(`wrapped-thumb-${id}`).toString('base64') : null;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, ciphertext_thumb_size_bytes,
         original_key, thumb_key, has_thumbnail,
         wrapped_dek, wrapped_thumb_dek)
      VALUES (${id}, ${spec.projectId}, ${spec.status}, ${kind}, ${label},
              ${fileName}, ${mimeType}, ${sizeBytes},
              ${sizeBytes}, ${kind === 'photo' ? Math.max(1, Math.floor(sizeBytes / 10)) : null},
              ${originalKey}, ${thumbKey}, ${kind === 'photo'},
              ${wrappedDek}, ${wrappedThumbDek})
    `);
    return id;
  } finally {
    await pool.end();
  }
}

interface AttachmentInEnvelope {
  id: string;
  projectId: string;
  status: 'pending' | 'ready';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  ciphertextSizeBytes: number;
  ciphertextThumbSizeBytes: number | null;
  originalKey: string;
  wrappedDek: string;
  wrappedThumbDek: string | null;
  kind: 'photo' | 'binary';
}

describe('Attachment export envelope (AC-220)', () => {
  let ownerToken: string;
  let projectId: string;
  let readyIds: string[];
  let pendingIds: string[];

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);

    // Seed three ready rows and two pending rows. The export must
    // carry the ready rows and omit the pending ones.
    readyIds = await Promise.all([
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'angebot',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 111,
      }),
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'rechnung',
        fileName: 'b.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 222,
      }),
      seedAttachment({
        projectId,
        status: 'ready',
        label: 'foto',
        fileName: 'c.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 333,
      }),
    ]);
    pendingIds = await Promise.all([
      seedAttachment({
        projectId,
        status: 'pending',
        label: 'aufmass',
        fileName: 'p1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 400,
      }),
      seedAttachment({
        projectId,
        status: 'pending',
        label: 'sonstiges',
        fileName: 'p2.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 500,
      }),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-220 Part 1 — Envelope shape + ready/pending filtering
  // -------------------------------------------------------------------
  it('exports an attachments array', async () => {
    const res = await authGet(ownerToken, '/api/export');
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(Array.isArray(env.attachments)).toBe(true);
  });

  it('includes every ready row with all persisted fields', async () => {
    const res = await authGet(ownerToken, '/api/export');
    expect(res.statusCode).toBe(200);
    const env = res.json() as { attachments: AttachmentInEnvelope[] };
    const exportedIds = env.attachments.map((a) => a.id);
    for (const id of readyIds) {
      expect(exportedIds).toContain(id);
    }

    // Pin the row-level fidelity — each exported row carries the
    // documented fields.
    const first = env.attachments.find((a) => a.id === readyIds[0]);
    expect(first).toBeDefined();
    expect(first!.projectId).toBe(projectId);
    expect(first!.status).toBe('ready');
    expect(first!.label).toBe('angebot');
    expect(first!.mimeType).toBe('application/pdf');
    expect(first!.sizeBytes).toBe(111);
    expect(typeof first!.originalKey).toBe('string');
    expect(first!.originalKey.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // AC-220 — wrapped envelopes ride the export envelope.
  //
  // Without `wrappedDek` (and `wrappedThumbDek` for photos) on the
  // exported row, the ciphertext on B2 is unrecoverable post-restore —
  // the wrapped envelope is what the operator-loaded `age` identity
  // unwraps to recover the per-blob DEK. ADR-0024 makes the export
  // envelope itself sensitive material as a result; the audit-exclusion
  // contract (AC-240) still applies — wrapped envelopes never appear
  // in `audit_log` payloads.
  // -------------------------------------------------------------------
  it('every ready row carries wrappedDek (and wrappedThumbDek for photos)', async () => {
    const res = await authGet(ownerToken, '/api/export');
    const env = res.json() as { attachments: AttachmentInEnvelope[] };

    for (const row of env.attachments) {
      // Original wrap is mandatory for every ready row regardless of
      // kind — without it the ciphertext on B2 is junk.
      expect(typeof row.wrappedDek).toBe('string');
      expect(row.wrappedDek.length).toBeGreaterThan(0);
      // Photos additionally carry the thumbnail wrap; binaries set null.
      if (row.kind === 'photo') {
        expect(typeof row.wrappedThumbDek).toBe('string');
        expect((row.wrappedThumbDek as string).length).toBeGreaterThan(0);
      } else {
        expect(row.wrappedThumbDek).toBeNull();
      }
      // Ciphertext sizes ride too — the row's `ciphertextSizeBytes`
      // is what HEAD asserts at complete and what the operator needs
      // to know when reasoning about disk consumption post-restore.
      expect(row.ciphertextSizeBytes).toBeGreaterThan(0);
    }
  });

  it('round-trip preserves wrapped envelope bytes byte-for-byte (DB-level read)', async () => {
    // The export envelope serializes `wrappedDek` as base64 of the
    // opaque bytes. After import, a re-export must surface byte-
    // identical strings — anything else means the import-side coercion
    // (e.g. string → utf-8 → bytea round-trip) is corrupting the
    // envelope, which would silently lose the only path to the
    // ciphertext on B2.
    //
    // Direct DB read (rather than re-export comparison) so the test
    // observes what the persistence layer actually stored, not what the
    // export endpoint chose to surface. The two should match by
    // construction; a divergence here points at the export-side
    // serializer drifting from the row.
    const snapshot = (await authGet(ownerToken, '/api/export')).json();
    const snapshotById = new Map<string, AttachmentInEnvelope>(
      (snapshot.attachments as AttachmentInEnvelope[]).map((a) => [a.id, a]),
    );

    const { db, pool } = createDatabase();
    try {
      for (const id of readyIds) {
        const exported = snapshotById.get(id);
        expect(exported).toBeDefined();
        const dbRow = await db.execute(
          sql`SELECT wrapped_dek, wrapped_thumb_dek FROM attachments WHERE id = ${id}`,
        );
        const row = dbRow.rows[0] as {
          wrapped_dek: string;
          wrapped_thumb_dek: string | null;
        };
        // Byte-for-byte match — a regression that re-encoded the
        // envelope (e.g. utf-8 ↔ base64 misalignment) would diverge
        // here.
        expect(exported!.wrappedDek).toBe(row.wrapped_dek);
        expect(exported!.wrappedThumbDek ?? null).toBe(row.wrapped_thumb_dek ?? null);
      }
    } finally {
      await pool.end();
    }
  });

  it('excludes every pending row', async () => {
    const res = await authGet(ownerToken, '/api/export');
    const env = res.json() as { attachments: AttachmentInEnvelope[] };
    const exportedIds = new Set(env.attachments.map((a) => a.id));
    for (const id of pendingIds) {
      expect(exportedIds.has(id)).toBe(false);
    }
    for (const row of env.attachments) {
      expect(row.status).toBe('ready');
    }
  });

  // -------------------------------------------------------------------
  // AC-220 Part 2 — Import preserves attachment ids + wrapped envelopes
  // (AC-137 extension — the wrapped envelopes are the post-restore
  // decryption path; losing them silently strands the ciphertext on B2).
  // -------------------------------------------------------------------
  it('import into an empty DB preserves attachment ids and wrapped envelopes (round-trip)', async () => {
    // Snapshot the current export as the envelope we will restore.
    const snapshot = (await authGet(ownerToken, '/api/export')).json();
    const snapshotAttachments = snapshot.attachments as AttachmentInEnvelope[];
    expect(snapshotAttachments.length).toBeGreaterThan(0);

    // Wipe business data so the import lands on an empty target. The
    // import endpoint requires an empty target or the destructive
    // restore confirmation — easier to wipe directly.
    const { db, pool } = createDatabase();
    try {
      await db.execute(
        sql`TRUNCATE TABLE attachments, project_workers, projects, customers RESTART IDENTITY CASCADE`,
      );
    } finally {
      await pool.end();
    }

    // Re-login after any session churn. Wipe doesn't touch sessions
    // directly; kept defensive so this test stays robust under future
    // changes to wipe semantics.
    const token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const importRes = await authPost(token, '/api/import', snapshot);
    expect(importRes.statusCode).toBe(200);

    const reExport = (await authGet(token, '/api/export')).json();
    const reAttachments = reExport.attachments as AttachmentInEnvelope[];
    const reById = new Map(reAttachments.map((a) => [a.id, a]));
    for (const original of snapshotAttachments) {
      // Id preservation (AC-137 extension to attachments).
      const restored = reById.get(original.id);
      expect(restored).toBeDefined();
      // Byte-for-byte preservation of the wrapped envelope — without
      // this the ciphertext on B2 is unrecoverable post-restore.
      expect(restored!.wrappedDek).toBe(original.wrappedDek);
      expect(restored!.wrappedThumbDek ?? null).toBe(original.wrappedThumbDek ?? null);
    }
  });
});
