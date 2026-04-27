/**
 * Papierkorb round-trip — upload → hide → trash list → restore (#45 / ADR-0022).
 *
 * Closes the issue's "smoke" deliverable: end-to-end, browser-driven
 * exercise of the soft-hide + restore loop, against the real app
 * (versioned MinIO bucket, presigned-POST upload, server-side
 * `copyFromVersion` on restore). Two arms — photo (two version_ids:
 * original + thumb) and binary (one version_id, thumb null) — pin both
 * shapes the issue promises.
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
 *
 * Pinning strategy (H7 fix): the spec captures the set of attachment
 * IDs visible in the gallery / binary list BEFORE upload, then waits
 * for a NEW id to appear after upload. That id is the load-bearing
 * anchor — every subsequent step (hide, locate-in-trash, restore,
 * verify-back-in-list) uses it directly. The previous `.first()` shape
 * silently matched whatever row happened to be at index 0, including
 * stale rows from earlier mutating specs.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/config/strings';
import { STORAGE_STATES } from './storage-states';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JPG_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.jpg');
const PDF_FIXTURE = path.resolve(__dirname, 'fixtures', 'sample.pdf');

/**
 * The Papierkorb-row "vor X gelöscht" label is composed of a relative-
 * time prefix + a fixed German suffix (see strings.ts
 * `attachments.hiddenAtLabel`). Derive the suffix from the formatter
 * itself so a label rename in source surfaces here as a fail.
 */
const HIDDEN_AT_KEYWORD = STRINGS.attachments.hiddenAtLabel('').trim();

test.use({ storageState: STORAGE_STATES.owner });

/**
 * Open any owner-visible project's detail page via /kanban → first card.
 * Owner sees every card; the spec doesn't depend on a specific seed
 * project.
 */
async function openProjectDetail(page: Page): Promise<void> {
  await page.goto('/kanban');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  const firstCard = page.locator('[data-testid^="project-card-"]').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('detail-open-page').click();

  await expect(page.getByTestId('project-detail-page')).toBeVisible();
}

/**
 * Snapshot the set of attachment IDs currently rendered under
 * `prefix-<id>` testids inside `container`. Used to compute the
 * NEW-id delta after an upload — the new id is the spec's anchor for
 * every subsequent assertion.
 *
 * Reads attribute values in-page rather than via `evaluate` so the
 * locator API's auto-wait semantics still apply (no dangling promises
 * if the container is mid-mount).
 */
async function captureExistingIds(container: Locator, prefix: string): Promise<Set<string>> {
  const handles = await container.locator(`[data-testid^="${prefix}"]`).all();
  const ids = new Set<string>();
  for (const handle of handles) {
    const testId = await handle.getAttribute('data-testid');
    if (testId) ids.add(testId.slice(prefix.length));
  }
  return ids;
}

/**
 * Poll the container until exactly one new `prefix-<id>` testid appears
 * that wasn't in `before`, returning the new id. The poll is bounded
 * by Playwright's expect timeout (default 5 s, here lifted to 15 s to
 * cover the full upload pipeline: client image-resize → init → POST
 * original → POST thumb → complete → list refetch).
 */
async function waitForNewId(
  container: Locator,
  prefix: string,
  before: Set<string>,
  timeout = 15_000,
): Promise<string> {
  let newId: string | null = null;
  await expect
    .poll(
      async () => {
        const handles = await container.locator(`[data-testid^="${prefix}"]`).all();
        for (const handle of handles) {
          const testId = await handle.getAttribute('data-testid');
          if (!testId) continue;
          const id = testId.slice(prefix.length);
          if (!before.has(id)) {
            newId = id;
            return true;
          }
        }
        return false;
      },
      {
        message: `expected a new ${prefix}<id> not present in baseline of ${before.size} ids`,
        timeout,
      },
    )
    .toBe(true);
  // The poll returned true only after newId was assigned.
  return newId!;
}

test.describe('Papierkorb — hide → trash → restore round-trip', () => {
  test('owner hides a photo, finds it in Papierkorb, restores it back to the gallery', async ({
    page,
    request,
  }) => {
    await openProjectDetail(page);

    // The tab strip is visible for owner (canTrash). Workers never see
    // it; the unit tests pin that branch.
    const anhaengeTab = page.getByTestId('attachment-tab-anhaenge');
    const papierkorbTab = page.getByTestId('attachment-tab-papierkorb');
    await expect(anhaengeTab).toBeVisible();
    await expect(papierkorbTab).toBeVisible();

    // Snapshot the gallery's pre-upload state. The photo we're about to
    // upload is the only row we will subsequently touch — every
    // assertion below pins to the id we extract from the new thumbnail,
    // not to whatever happens to be at index 0.
    const gallery = page.getByTestId('project-detail-photos');
    const before = await captureExistingIds(gallery, 'photo-thumb-');

    // Upload a photo — owner has `attachment:write`. Same drag-drop
    // input the worker spec uses; the file lands in the gallery via
    // init → POST → complete.
    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);

    // Anchor: the id of the just-uploaded photo. This is the spec's
    // load-bearing handle for the rest of the round-trip.
    const attachmentId = await waitForNewId(gallery, 'photo-thumb-', before);
    const ourThumbButton = gallery.getByTestId(`photo-thumb-${attachmentId}`);
    await expect(ourThumbButton).toBeVisible();

    // Hide via the row-level delete affordance + confirm dialog. The
    // confirm copy is "in den Papierkorb verschoben" (the action is
    // reversible from this commit on); the dialog itself uses the
    // shared `confirm-dialog` testid. Scope `attachment-delete` to the
    // <li> wrapping our pinned thumbnail so we don't accidentally hit a
    // sibling photo's delete button. The `has`-locator must be
    // expressible relative to the candidate `<li>`, so build it from
    // `page` (not from `gallery`) — chaining through `gallery` bakes a
    // `project-detail-photos` ancestor requirement into the lookup that
    // no descendant of the `<li>` can satisfy.
    const ourThumbItem = gallery
      .getByTestId('attachment-thumbnail')
      .filter({ has: page.getByTestId(`photo-thumb-${attachmentId}`) });
    await ourThumbItem.getByTestId('attachment-delete').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(STRINGS.attachments.tabPapierkorb);
    await page.getByTestId('confirm-ok').click();
    await expect(ourThumbButton).toHaveCount(0);

    // Switch to the Papierkorb tab. The hidden row appears with a
    // "Wiederherstellen" button — pinned by the same attachmentId.
    await papierkorbTab.click();
    const papierkorb = page.getByTestId('project-detail-papierkorb');
    await expect(papierkorb).toBeVisible();
    const trashRow = papierkorb.getByTestId(`papierkorb-row-${attachmentId}`);
    await expect(trashRow).toBeVisible({ timeout: 10_000 });
    // Relative-time label — "vor X gelöscht". Asserts the German suffix
    // landed on this specific row, not just somewhere on the page.
    await expect(trashRow).toContainText(HIDDEN_AT_KEYWORD);

    // Restore — single-click, no confirm dialog. Targeted by the same
    // id, so the assertion below pins the round-trip to one row, not a
    // bulk effect.
    await trashRow.getByTestId(`papierkorb-restore-${attachmentId}`).click();
    await expect(trashRow).toHaveCount(0);

    // Back on the Anhänge tab the SAME attachment row is in the gallery
    // again (server-side `copyFromVersion` produced fresh VersionIds in
    // the DB, but `attachment.id` is preserved). The photo arm's
    // distinguishing feature — restoring BOTH the original AND the
    // thumb version — is implicit in the thumbnail rendering: the
    // gallery img tag fetches the thumb variant, so a thumbnail
    // appearing for our id proves both copyFromVersion calls succeeded.
    await anhaengeTab.click();
    await expect(gallery.getByTestId(`photo-thumb-${attachmentId}`)).toBeVisible({
      timeout: 15_000,
    });

    // Audit assertion — the restore action wrote an `attachment:restore`
    // row scoped to this attachment. Pins the data-layer guarantee that
    // #45 promises (every restore is auditable). Owner holds
    // `audit:read` so the request context (sharing the test's storage
    // state) can fetch the entry.
    const auditUrl = `/api/audit?entityType=attachment&entityId=${attachmentId}&action=attachment:restore`;
    const auditResp = await request.get(auditUrl);
    expect(auditResp.ok(), `GET ${auditUrl} returned ${auditResp.status()}`).toBe(true);
    const auditBody = (await auditResp.json()) as {
      data: Array<{ action: string; entityId: string }>;
    };
    expect(
      auditBody.data.some(
        (entry) => entry.action === 'attachment:restore' && entry.entityId === attachmentId,
      ),
      'expected an attachment:restore audit row for the round-tripped attachment',
    ).toBe(true);
  });

  test('owner hides a binary, finds it in Papierkorb, restores it back to the binary list', async ({
    page,
  }) => {
    // Binary path covers the second restore shape (#45): one version_id
    // (original) + null thumb_version_id. The server's `copyFromVersion`
    // skip on the thumb branch and the null-thumb DB write are exercised
    // here for the first time end-to-end — unit tests pin the branch,
    // this spec pins the wired-up integration.
    await openProjectDetail(page);

    const anhaengeTab = page.getByTestId('attachment-tab-anhaenge');
    const papierkorbTab = page.getByTestId('attachment-tab-papierkorb');
    await expect(anhaengeTab).toBeVisible();
    await expect(papierkorbTab).toBeVisible();

    // Snapshot binary IDs pre-upload. Same delta-pinning approach as
    // the photo arm — the new id is the spec's anchor.
    const binaryList = page.getByTestId('project-detail-binaries');
    const before = await captureExistingIds(binaryList, 'attachment-binary-row-');

    const uploadCta = page.getByTestId('project-detail-upload-cta');
    await uploadCta.getByTestId('attachment-binary-input').setInputFiles(PDF_FIXTURE);

    const attachmentId = await waitForNewId(binaryList, 'attachment-binary-row-', before);
    const ourRow = binaryList.getByTestId(`attachment-binary-row-${attachmentId}`);
    await expect(ourRow).toBeVisible();
    // Sanity: the row carries the fixture's filename. If a future change
    // ever regressed the new-row pinning to point at someone else's row,
    // this assertion would surface the mismatch immediately.
    await expect(ourRow).toContainText('sample.pdf');

    // Hide via the row-level delete affordance + confirm dialog.
    await ourRow.getByTestId('attachment-delete').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(STRINGS.attachments.tabPapierkorb);
    await page.getByTestId('confirm-ok').click();
    await expect(ourRow).toHaveCount(0);

    // Switch to Papierkorb. Pinned by attachmentId — independent of
    // any other rows this run may have left in the trash.
    await papierkorbTab.click();
    const papierkorb = page.getByTestId('project-detail-papierkorb');
    await expect(papierkorb).toBeVisible();
    const trashRow = papierkorb.getByTestId(`papierkorb-row-${attachmentId}`);
    await expect(trashRow).toBeVisible({ timeout: 10_000 });
    // Filename in the Papierkorb row's first column — the same
    // sample.pdf the upload above produced. Confirms the trash listing
    // surfaces the binary's identity, not just a UUID.
    await expect(trashRow).toContainText('sample.pdf');
    await expect(trashRow).toContainText(HIDDEN_AT_KEYWORD);

    await trashRow.getByTestId(`papierkorb-restore-${attachmentId}`).click();
    await expect(trashRow).toHaveCount(0);

    // Back on the Anhänge tab, the binary row is in the list again with
    // the same id. For binaries this proves `copyFromVersion` produced
    // a fresh original-version-id and the row's `thumb_version_id`
    // stayed null (the binary list renders without a thumb fetch — its
    // appearance after restore is the visible signal that the binary
    // path's null-thumb branch worked).
    await anhaengeTab.click();
    await expect(binaryList.getByTestId(`attachment-binary-row-${attachmentId}`)).toBeVisible({
      timeout: 15_000,
    });
  });
});
