/**
 * API integration tests — project purge cascades attachments (AC-218).
 *
 * Pins the cascade contract from data-model.md §5.13 "Cascade on project
 * hard-delete" and verification.md AC-218:
 *
 *   - Purging a project (hard-delete) removes every `attachment` row via
 *     FK cascade AND deletes every backing object (`originalKey` and
 *     `thumbKey` where present) from object storage.
 *   - Archive (soft-delete via the same DELETE surface without `/purge`)
 *     leaves attachments untouched — only purge triggers the cascade.
 *   - A failed storage delete during purge does NOT abort the database
 *     cascade; the operational logger records the orphaned keys. The
 *     metadata-table cleanliness goal trumps a transient storage fault.
 *
 * Skeleton state: the purge route already exists (AT-79 passes), but
 * the attachment-cascade storage-delete arm is not wired. With the
 * skeleton, the DB cascade via the FK alone succeeds (the migration's
 * `ON DELETE CASCADE` does its job) — the asserts that FAIL today are
 * the "storage objects were deleted" arms and any audit-behavior
 * arms. That is the intended TDD red state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import type { StorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

async function seedCustomerId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/customers');
  const customers = res.json().customers ?? res.json().data;
  if (!Array.isArray(customers) || customers.length === 0) {
    throw new Error('Seed setup: at least one customer required');
  }
  return customers[0].id;
}

/** Create a fresh project, returning its id. */
async function createProject(ownerToken: string, customerId: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/projects', {
    number: `PC-${suffix}`,
    title: `Purge-cascade fixture ${suffix}`,
    customerId,
  });
  if (res.statusCode !== 201) {
    throw new Error(`project create failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

/** Archive a project in preparation for purge (AC-156 precondition). */
async function archiveProject(ownerToken: string, projectId: string): Promise<void> {
  const res = await authDelete(ownerToken, `/api/projects/${projectId}`);
  if (res.statusCode !== 200) {
    throw new Error(`archive failed ${res.statusCode} ${res.body}`);
  }
}

interface SeededAttachment {
  id: string;
  originalKey: string;
  thumbKey: string | null;
}

/** Direct-insert a ready attachment (raw SQL is allowlisted under __tests__/). */
async function seedReadyAttachment(
  projectId: string,
  storage: StorageClient,
  withThumb: boolean,
): Promise<SeededAttachment> {
  const { db, pool } = createDatabase();
  const id = crypto.randomUUID();
  const originalKey = `attachments/${projectId}/${id}.orig`;
  const thumbKey = withThumb ? `attachments/${projectId}/${id}.thumb` : null;
  try {
    // ADR-0024: ready rows must carry a wrapped DEK + ciphertext size
    // (CHECK `attachments_wrapped_dek_required_when_ready`). Synthetic
    // envelope bytes are fine — the cascade test pins DB cleanup, not
    // unwrap-time decryption.
    const wrappedDek = Buffer.alloc(192, 0x55).toString('base64');
    const wrappedThumbDek = withThumb ? Buffer.alloc(192, 0x66).toString('base64') : null;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes, ciphertext_thumb_size_bytes,
         original_key, thumb_key, has_thumbnail,
         wrapped_dek, wrapped_thumb_dek)
      VALUES (${id}, ${projectId}, 'ready',
              ${withThumb ? 'photo' : 'binary'},
              ${withThumb ? 'foto' : 'sonstiges'},
              ${'file-' + id.slice(0, 6)},
              ${withThumb ? 'image/jpeg' : 'application/pdf'},
              1024,
              1088, ${withThumb ? 1088 : null},
              ${originalKey}, ${thumbKey}, ${withThumb},
              ${wrappedDek}, ${wrappedThumbDek})
    `);
  } finally {
    await pool.end();
  }
  await storage.upload(originalKey, Buffer.from('primary'), 'application/octet-stream');
  if (thumbKey) {
    await storage.upload(thumbKey, Buffer.from('thumb'), 'image/webp');
  }
  return { id, originalKey, thumbKey };
}

async function attachmentRowExists(id: string): Promise<boolean> {
  const { db, pool } = createDatabase();
  try {
    const r = await db.execute(sql`SELECT 1 FROM attachments WHERE id = ${id} LIMIT 1`);
    return r.rows.length > 0;
  } finally {
    await pool.end();
  }
}

async function objectAbsent(storage: StorageClient, key: string): Promise<boolean> {
  try {
    await storage.download(key);
    return false;
  } catch {
    return true;
  }
}

describe('Attachment purge cascade (AC-218)', () => {
  let ownerToken: string;
  let customerId: string;
  let storage: StorageClient;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    customerId = await seedCustomerId(ownerToken);

    const env = getEnv();
    storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Hard-delete (purge) cascades the attachments table + storage.
  // -------------------------------------------------------------------
  it('purge removes every attachment row AND deletes every backing object', async () => {
    const projectId = await createProject(ownerToken, customerId);
    const photo = await seedReadyAttachment(projectId, storage, true);
    const binary = await seedReadyAttachment(projectId, storage, false);
    await archiveProject(ownerToken, projectId);

    const purgeRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purgeRes.statusCode).toBe(204);

    // FK cascade on the table.
    expect(await attachmentRowExists(photo.id)).toBe(false);
    expect(await attachmentRowExists(binary.id)).toBe(false);

    // Backing objects removed from storage — the load-bearing arm of
    // AC-218. The FK cascade alone is not enough; the spec requires
    // the storage-side cleanup to run alongside the DB delete.
    expect(await objectAbsent(storage, photo.originalKey)).toBe(true);
    expect(await objectAbsent(storage, photo.thumbKey!)).toBe(true);
    expect(await objectAbsent(storage, binary.originalKey)).toBe(true);
  });

  // -------------------------------------------------------------------
  // Soft-delete (archive) leaves attachments intact — the cascade fires
  // only on hard-delete. AC-218 final clause: "Soft-delete (archive)
  // leaves attachments unchanged."
  // -------------------------------------------------------------------
  it('archive leaves attachment rows and backing objects intact', async () => {
    const projectId = await createProject(ownerToken, customerId);
    const attachment = await seedReadyAttachment(projectId, storage, true);

    await archiveProject(ownerToken, projectId);

    // Row still exists.
    expect(await attachmentRowExists(attachment.id)).toBe(true);
    // Backing objects still retrievable.
    expect(await objectAbsent(storage, attachment.originalKey)).toBe(false);
    expect(await objectAbsent(storage, attachment.thumbKey!)).toBe(false);
  });

  // -------------------------------------------------------------------
  // A failed storage delete does not abort the DB cascade. AC-218:
  // "A failed storage delete during purge does not abort the database
  // cascade; the operational logger records the orphaned object keys."
  //
  // We simulate the failure-at-storage side by seeding the row without
  // its backing object (S3 DeleteObject on a missing key is idempotent,
  // so even under the skeleton's happy path the row vanishes). The
  // assertion load-bears on the DB side: a pre-existing-but-orphaned
  // key must not block the purge from committing.
  // -------------------------------------------------------------------
  it('a missing backing object (simulated storage failure) does not abort the DB cascade', async () => {
    const projectId = await createProject(ownerToken, customerId);

    // Insert the row directly, without an upload. The purge path will
    // attempt to delete a key that was never there; the DB-side cascade
    // must still run.
    const { db, pool } = createDatabase();
    const id = crypto.randomUUID();
    try {
      const wrappedDek = Buffer.alloc(192, 0x44).toString('base64');
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek)
        VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
                'ghost.pdf', 'application/pdf', 1,
                65,
                ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
                ${wrappedDek}, NULL)
      `);
    } finally {
      await pool.end();
    }

    await archiveProject(ownerToken, projectId);
    const purgeRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purgeRes.statusCode).toBe(204);

    // DB cascade ran despite the storage-side no-op.
    expect(await attachmentRowExists(id)).toBe(false);
  });
});
