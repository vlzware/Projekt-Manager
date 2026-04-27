/**
 * Papierkorb round-trip — upload → hide → trash list → restore (#45 / ADR-0022).
 *
 * Closes the issue's "smoke" deliverable: end-to-end, browser-driven
 * exercise of the soft-hide + restore loop, against the real app
 * (versioned MinIO bucket, presigned-POST upload, server-side
 * `copyFromVersion` on restore).
 *
 * Mutating: uploads + hides + restores leave persistent rows on the
 * project. Runs under `chromium-mutating` for the same reason
 * `attachment-upload.spec.ts` does — concurrent readers would observe
 * the row mid-flight and trip on count assertions.
 *
 * Storage state: owner — the only role that sees the Papierkorb tab
 * (workers / bookkeepers don't have `attachment:trash`). Driving the
 * flow through one role keeps the spec linear; the unit tests for the
 * permission gate cover the worker / bookkeeper rejection arms.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORAGE_STATES } from './storage-states';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');

test.use({ storageState: STORAGE_STATES.owner });

/**
 * Open any owner-visible project's detail page via /kanban → first card.
 * Owner sees every card; the spec doesn't depend on a specific seed
 * project. Returns the project id parsed off the card's testid.
 */
async function openProjectDetail(page: Page): Promise<string> {
  await page.goto('/kanban');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  const firstCard = page.locator('[data-testid^="project-card-"]').first();
  await expect(firstCard).toBeVisible();
  // Capture the id BEFORE navigating away — the card is detached the
  // moment the detail page mounts, and getAttribute on a detached
  // handle throws.
  const cardTestId = await firstCard.getAttribute('data-testid');
  const projectId = cardTestId!.replace('project-card-', '');

  await firstCard.click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('detail-open-page').click();

  await expect(page.getByTestId('project-detail-page')).toBeVisible();
  return projectId;
}

test.describe('Papierkorb — hide → trash → restore round-trip', () => {
  test('owner hides a photo, finds it in Papierkorb, restores it back to the gallery', async ({
    page,
  }) => {
    await openProjectDetail(page);

    // The tab strip is visible for owner (canTrash). Workers never see
    // it; the unit tests pin that branch.
    const anhaengeTab = page.getByTestId('attachment-tab-anhaenge');
    const papierkorbTab = page.getByTestId('attachment-tab-papierkorb');
    await expect(anhaengeTab).toBeVisible();
    await expect(papierkorbTab).toBeVisible();

    // Upload a photo — owner has `attachment:write`. Same drag-drop
    // input the worker spec uses; the file lands in the gallery via
    // init → POST → complete.
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // Hide via the row-level delete affordance + confirm dialog. The
    // confirm copy is now "in den Papierkorb verschoben" (the action
    // is reversible from this commit on); the dialog itself uses the
    // shared `confirm-dialog` testid.
    await thumb.getByTestId('attachment-delete').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/Papierkorb/);
    await page.getByTestId('confirm-ok').click();
    await expect(thumb).toHaveCount(0);

    // Switch to the Papierkorb tab. The hidden row appears with a
    // "Wiederherstellen" button.
    await papierkorbTab.click();
    const papierkorb = page.getByTestId('project-detail-papierkorb');
    await expect(papierkorb).toBeVisible();
    const trashRow = papierkorb.locator('[data-testid^="papierkorb-row-"]').first();
    await expect(trashRow).toBeVisible({ timeout: 10_000 });
    await expect(trashRow).toContainText(/gelöscht/); // "vor X gelöscht" relative-time label

    // Restore — single-click, no confirm dialog.
    await trashRow.locator('[data-testid^="papierkorb-restore-"]').click();
    await expect(trashRow).toHaveCount(0);

    // Back on the Anhänge tab the photo is in the gallery again. The
    // server-side `copyFromVersion` produced a fresh current version
    // (different VersionId in DB), but visually the user sees the same
    // photo restored.
    await anhaengeTab.click();
    await expect(gallery.getByTestId('attachment-thumbnail').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
