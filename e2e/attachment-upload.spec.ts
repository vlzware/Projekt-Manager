import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORAGE_STATES } from './storage-states';

/**
 * Happy-path attachment upload — worker on an assigned project opens
 * the project detail page via the quick-glance panel's `Öffnen`
 * affordance, uploads one photo and one PDF, then confirms the gallery
 * and binary list render each attachment. The PDF download is exercised
 * via the `Herunterladen` action.
 *
 * Runs under `chromium-mutating` because the upload flow persists
 * `attachment` rows plus backing objects in MinIO — a parallel reader
 * of the same project would observe those rows mid-flight.
 *
 * Worker `arbeiter1` (Jan Nowak) is assigned to project suffix `-007`
 * per `src/server/seed/business.ts` (ASSIGNMENT_SPECS). The project is
 * in `geplant`, so the worker can open the quick-glance panel, hit the
 * `Öffnen` affordance, and land on `/projects/:id`.
 *
 * Fixture bytes live under `e2e/fixtures/` — a ~28 KB 3840×2160 JPEG
 * with EXIF (including synthetic GPS) and a 594-byte PDF. The JPEG is
 * sized so the client-side resize branch is exercised end-to-end
 * (longest edge > `imageMaxDimension`), while staying well under the
 * 1 MB per-file cap (architecture.md §12.2) so the upload itself cannot
 * trip the size validation gate.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');
const PDF_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.pdf');

test.use({ storageState: STORAGE_STATES.worker });

/**
 * Open the Kanban quick-glance panel for the `-007` project (worker is
 * assigned), hit `Öffnen`, and wait for the project detail page to
 * render. Centralized here because both the gallery and binary flows
 * start from the same navigation sequence.
 *
 * Worker landing is now `/meine-projekte` (the personal list). The
 * upload-from-kanban flow this helper exercises still exists, so we
 * navigate to /kanban explicitly rather than chasing the landing.
 */
async function openProjectDetailViaPanel(page: Page): Promise<string> {
  await page.goto('/kanban');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // Pick the -007 geplant card (assigned to arbeiter1 per seed data).
  const geplantColumn = page.getByTestId('kanban-column-geplant');
  const assignedCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
  await assignedCard.click();

  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  const cardTestId = await assignedCard.getAttribute('data-testid');
  const projectId = cardTestId!.replace('project-card-', '');

  // The `Öffnen` affordance is present whenever the panel is and
  // navigates to /projects/:id. Testid shared with the component-level
  // panel test (`ProjectDetailPanel.test.tsx`) so the same affordance
  // satisfies both layers.
  const openAffordance = panel.getByTestId('detail-open-page');
  await expect(openAffordance).toBeVisible();
  await openAffordance.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:\\?|$)`));
  await expect(page.getByTestId('project-detail-page')).toBeVisible();

  return projectId;
}

test.describe('Attachment happy-path upload (worker on assigned project)', () => {
  test('photo upload renders a thumbnail in the gallery', async ({ page }) => {
    await openProjectDetailViaPanel(page);

    // Upload surface is gated on `attachment:write`; worker holds it per
    // the default matrix. `project-detail-upload-cta` is the section
    // wrapper. The `Foto aufnehmen` CTA (ui/project-detail.md §8.15.4)
    // plus a drag-drop zone live inside it; either entry point lands in
    // the same presigned-POST init flow.
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();

    // Drag-drop zones expose a hidden file input for Playwright to
    // target directly — matches the pattern used elsewhere in the suite
    // (e.g. data-exchange.spec.ts for the import file input).
    const photoInput = uploadCta.getByTestId('attachment-photo-input');
    await photoInput.setInputFiles(JPG_FIXTURE);

    // After init → POST to storage → complete resolves, the gallery row
    // flips from "uploading" to a thumbnail rendered via a presigned-GET
    // URL (ui/project-detail.md §8.15.4).
    const gallery = page.getByTestId('project-detail-photos');
    await expect(gallery.getByTestId('attachment-thumbnail').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('PDF upload renders in the binary list and can be downloaded', async ({ page }) => {
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await expect(uploadCta).toBeVisible();

    const binaryInput = uploadCta.getByTestId('attachment-binary-input');
    await binaryInput.setInputFiles(PDF_FIXTURE);

    // The PDF lands in the binary list with filename, label, uploader,
    // timestamp, and a download action (ui/project-detail.md §8.15.5).
    const binaryList = page.getByTestId('project-detail-binaries');
    // Each row has `data-testid="attachment-binary-row-<id>"`, so
    // `getByTestId('attachment-binary-row')` would require an exact
    // match and never hit. Use a CSS prefix selector and filter by
    // the filename text. `.first()` tolerates leftover sample.pdf
    // rows from earlier runs in the same mutating-test file — the
    // describe block's TRUNCATE only runs once at auth-setup time,
    // so upload fixtures accumulate within a single Playwright run.
    const pdfRow = binaryList
      .locator('[data-testid^="attachment-binary-row-"]')
      .filter({ hasText: 'sample.pdf' })
      .first();
    await expect(pdfRow).toBeVisible({ timeout: 15_000 });

    // Exercise the download action — pin that the browser actually
    // receives the file, not just that the action renders. Download is
    // the browser-level observable and `waitForEvent('download')` is
    // Playwright's native hook for it.
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await pdfRow.getByTestId('attachment-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('sample.pdf');
  });

  test('worker can delete their own photo within the grace window', async ({ page }) => {
    // The worker who authored the attachment may delete it within the
    // configured self-delete grace window (default 15 min). The click
    // path goes through the row-level delete affordance + a Yes/No
    // confirmation dialog (ui/project-detail.md §8.15.6).
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // Row-level delete affordance — only rendered for the caller who
    // authored the row, within the grace window.
    const deleteButton = thumb.getByTestId('attachment-delete');
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Confirmation dialog — generic `confirm-dialog` testid matches the
    // pattern used by the transition + archive flows.
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await page.getByTestId('confirm-ok').click();

    await expect(thumb).toHaveCount(0);
  });
});

test.describe('Attachment upload preserves EXIF / GPS through the pipeline', () => {
  test('photo lightbox blob retains the source APP1 segment and Make tag', async ({
    page,
    request,
  }) => {
    // Regression guard for #126. The previous library
    // (`browser-image-compression@2.0.2`) had an EXIF copier that
    // rejected JPEGs whose Orientation tag was encoded as LONG; our
    // fallback dropped the entire APP1 segment, breaking the worker-
    // view promise that GPS survives the upload pipeline. The
    // replacement (`@uploadcare/image-shrink`) byte-splices APP1
    // back into the re-encoded blob — this test pins that guarantee
    // end-to-end against a real upload + presigned GET.
    //
    // The fixture's APP1 segment contains an EXIF magic ("Exif\\0\\0"),
    // a Make tag with the ASCII bytes "vitest-fixture", and a GPSIFD
    // pointer (tag 0x8825). Asserting both magic + Make in the served
    // bytes proves the segment survived re-encode byte-for-byte; if a
    // future regression strips EXIF, both checks fail together.
    await openProjectDetailViaPanel(page);

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    const gallery = page.getByTestId('project-detail-photos');
    const thumb = gallery.getByTestId('attachment-thumbnail').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });

    // Open the lightbox — that's the only surface that loads the
    // original (full-EXIF) blob; the gallery tile is a stripped WebP
    // thumbnail by design.
    await thumb.locator('button').first().click();
    const lightbox = page.getByTestId('photo-lightbox');
    await expect(lightbox).toBeVisible();
    const originalUrl = await lightbox.locator('img').getAttribute('src');
    expect(originalUrl).toBeTruthy();

    // Fetch the bytes the worker would see. Presigned-GET URLs are
    // time-limited but unauth'd — Playwright's `request` context can
    // fetch them directly without a session cookie.
    const response = await request.get(originalUrl!);
    expect(response.ok()).toBe(true);
    const body = await response.body();
    // EXIF magic — the 6-byte "Exif\\0\\0" header at the start of any
    // APP1/EXIF segment. Present in the fixture; must survive re-encode.
    expect(body.includes(Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]))).toBe(true);
    // The fixture's Make tag — a recognisable ASCII string inside the
    // APP1 segment. Surviving the re-encode proves the segment was
    // copied verbatim, not just that some EXIF magic exists somewhere.
    expect(body.includes(Buffer.from('vitest-fixture', 'ascii'))).toBe(true);

    // Dimension regression guard. `@uploadcare/image-shrink`'s `size`
    // setting is a target *pixel area*, not a longest-edge dimension —
    // a previous build passed `imageMaxDimension` (2560) directly,
    // which the library interpreted as ~50×40 pixels and shipped
    // unusable thumbnails as the "original". The fixture is 3840×2160
    // (16:9), so the re-encoded longest edge should land near
    // imageMaxDimension. Assert it's at least half — anything below
    // means the area/edge confusion regressed. Decoding via the page's
    // own Image constructor avoids pulling a Node JPEG decoder into
    // the e2e bundle.
    const dims = await page.evaluate(async (url: string) => {
      const blob = await fetch(url).then((r) => r.blob());
      const objectUrl = URL.createObjectURL(blob);
      try {
        return await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error('decode failed'));
          img.src = objectUrl;
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }, originalUrl!);
    const longest = Math.max(dims.width, dims.height);
    // Floor rather than equality — the library's sqrt-based rounding
    // can shave a pixel or two off the configured edge. 1280 is the
    // half-baseEdge floor; anything below means the size parameter is
    // being misinterpreted as an area again (~58×43 for a 4:3 photo).
    expect(longest).toBeGreaterThanOrEqual(1280);
  });
});
