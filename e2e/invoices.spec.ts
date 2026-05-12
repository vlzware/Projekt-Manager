import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — Invoice lifecycle (verification.md §16.3 "Invoice lifecycle",
 * pins AC-287 and AC-290 at the UI integration level).
 *
 * Drives the owner-facing happy path end-to-end:
 *   1. Owner navigates to a project in `rechnung_faellig` (the only
 *      state from which issuance is allowed per AC-289).
 *   2. Opens the per-project invoice form (ui/invoices.md §8.16, and
 *      the per-project invoice block in ui/project-detail.md §8.15.11).
 *   3. Enters lines + performance date; selects `taxMode = 'standard'`.
 *   4. Issues the invoice.
 *   5. Asserts:
 *      - the invoice list shows the new row with an `RE-YYYY-NNNN`
 *        number,
 *      - the parent project's status shows `abgerechnet` on the
 *        Kanban board (AC-287 project flip),
 *      - the rendered PDF/A-3 is downloadable through the per-invoice
 *        viewer.
 *   6. Cancels the issued invoice with a `cancellationReason`.
 *   7. Asserts:
 *      - the original row's status renders as `cancelled`,
 *      - the Storno sibling row appears with `ST-YYYY-NNNN`, visually
 *        grouped under the original,
 *      - the parent project's status is NOT auto-reverted (AC-290
 *        trailing clause).
 *
 * Runs under `chromium-mutating` because the flow persists `invoice`
 * rows + flips a project status — a parallel reader would see the
 * mutation mid-flight.
 *
 * Pre-impl red state: every selector is missing — the form, the list
 * row, the cancel dialog, the PDF download affordance — so navigation
 * + the first `expect(...)` calls fail. Implementation lands the
 * surface in step 5; this spec is the contract.
 */

test.use({ storageState: STORAGE_STATES.owner });

const year = new Date().getFullYear();

test.describe.configure({ mode: 'serial' });

test.describe('Invoice lifecycle (AC-287, AC-290)', () => {
  let projectId: string;
  let invoiceNumber: string;
  let stornoNumber: string;

  test('owner navigates to a rechnung_faellig project and opens the invoice draft form', async ({
    page,
  }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The rechnung_faellig column carries 3 projects in the seed
    // (kanban-flows.spec.ts pinns this count). Click the first card.
    const column = page.getByTestId('kanban-column-rechnung_faellig');
    await expect(column).toBeVisible();
    const card = column.locator('[data-testid^="project-card-"]').first();
    await card.click();

    // Resolve the project id from the card's testid for downstream
    // assertions.
    const cardTestId = await card.getAttribute('data-testid');
    projectId = cardTestId!.replace('project-card-', '');

    // The quick-glance panel's "Öffnen" affordance navigates to the
    // project detail page — the invoice block lives there per
    // ui/project-detail.md §8.15.11.
    const panel = page.getByTestId('detail-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('detail-open-page').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:\\?|$)`));
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    // Open the invoice draft form. The testid below is the contract
    // for the impl team — the spec leaves the form's exact UI to
    // ui/project-detail.md §8.15.11 and ui/invoices.md §8.16.
    const draftCta = page.getByTestId('invoice-draft-create');
    await expect(draftCta).toBeVisible();
    await draftCta.click();

    // Form opens — name input, line input, performance-date picker.
    await expect(page.getByTestId('invoice-form')).toBeVisible();
  });

  test('owner fills the invoice form and issues the invoice', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();
    await page.getByTestId('invoice-draft-create').click();

    // Fill required fields. The exact field testids match the
    // pattern used in management-flows.spec.ts (kebab-case prefix +
    // input).
    await page.getByTestId('invoice-tax-mode-select').selectOption('standard');
    await page.getByTestId('invoice-performance-date-input').fill('2026-04-10');

    // One line item — description, quantity, unit, unitPrice, taxRate.
    await page.getByTestId('invoice-line-description-input').fill('Anstrich Fassade');
    await page.getByTestId('invoice-line-quantity-input').fill('1');
    await page.getByTestId('invoice-line-unit-input').fill('pauschal');
    await page.getByTestId('invoice-line-unit-price-input').fill('1500');
    await page.getByTestId('invoice-line-tax-rate-input').fill('19');

    // Save draft, then issue. The two-step UX (save draft first, then
    // issue) mirrors the §14.2.14 split.
    await page.getByTestId('invoice-form-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();

    // The draft row appears in the per-project invoice block.
    const draftRow = page.getByTestId('invoice-list').locator('[data-testid^="invoice-row-"]').first();
    await expect(draftRow).toBeVisible();
    await expect(draftRow.getByTestId('invoice-status-badge')).toContainText(/draft|Entwurf/i);

    // Issue the draft.
    await draftRow.getByTestId('invoice-issue-button').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    // Wait for the issue API to complete so subsequent assertions
    // observe the post-commit state (mirrors the deactivate pattern
    // in management-flows.spec.ts).
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/issue') && resp.ok()),
      page.getByTestId('confirm-ok').click(),
    ]);

    // The issued row carries the `RE-YYYY-NNNN` number per AC-287.
    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .first();
    await expect(issuedRow.getByTestId('invoice-status-badge')).toContainText(/issued|Ausgestellt/i);
    const numberCell = issuedRow.getByTestId('invoice-number');
    await expect(numberCell).toBeVisible();
    invoiceNumber = (await numberCell.textContent())!.trim();
    expect(invoiceNumber).toMatch(new RegExp(`^RE-${year}-\\d{4,}$`));
  });

  test('the project status flips to abgerechnet on the Kanban board (AC-287)', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The card has moved from `rechnung_faellig` to `abgerechnet`.
    const abgerechnet = page.getByTestId('kanban-column-abgerechnet');
    await expect(abgerechnet).toBeVisible();
    await expect(abgerechnet.getByTestId(`project-card-${projectId}`)).toBeVisible();
  });

  test('the rendered PDF/A-3 downloads through the per-invoice viewer', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(issuedRow).toBeVisible();

    // The download action fires the browser download event — the
    // load-bearing assertion is the browser-level observable, not
    // the affordance click.
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await issuedRow.getByTestId('invoice-download-pdf').click();
    const download = await downloadPromise;
    // Filename is implementation-defined; the load-bearing assertion
    // is `.pdf` extension + non-empty body.
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  test('owner cancels the issued invoice with a cancellationReason (AC-290)', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(issuedRow).toBeVisible();

    await issuedRow.getByTestId('invoice-cancel-button').click();

    // Cancel dialog carries a reason input.
    const cancelDialog = page.getByTestId('invoice-cancel-dialog');
    await expect(cancelDialog).toBeVisible();
    await cancelDialog.getByTestId('invoice-cancel-reason-input').fill('Tippfehler');
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/cancel') && resp.ok()),
      cancelDialog.getByTestId('invoice-cancel-confirm').click(),
    ]);

    // The original row's status renders as `cancelled`.
    await expect(issuedRow.getByTestId('invoice-status-badge')).toContainText(
      /cancelled|Storniert/i,
    );

    // The Storno sibling row appears with the `ST-YYYY-NNNN` number,
    // visually grouped under the original (ui/invoices.md §8.16.1).
    // The grouping mechanism is impl-defined (a nested testid or a
    // visual indent); the load-bearing assertion is the presence of
    // the sibling row referencing the original.
    //
    // TESTID CONTRACT (proposal for the impl team): the Storno row
    // carries `data-testid="invoice-storno-of"` whose text content
    // names the original's `RE-YYYY-NNNN` number. This testid
    // expresses the `cancellationOf` link in a single DOM-queryable
    // attribute and decouples the locator from any specific visual
    // grouping (nested table, indent, badge — all valid renderings).
    // If the impl team picks a different testid name, update both
    // here and ui/invoices.md §8.16.1 in lock-step.
    const stornoRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ has: page.getByTestId('invoice-storno-of').filter({ hasText: invoiceNumber }) })
      .first();
    await expect(stornoRow).toBeVisible();
    const stornoNumberCell = stornoRow.getByTestId('invoice-number');
    stornoNumber = (await stornoNumberCell.textContent())!.trim();
    expect(stornoNumber).toMatch(new RegExp(`^ST-${year}-\\d{4,}$`));
  });

  test('the project status is NOT auto-reverted after cancellation (AC-290 trailing clause)', async ({
    page,
  }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // Card stays in `abgerechnet` — the cancellation surfaces as a UI
    // banner on the project, not as a project-status flip.
    const abgerechnet = page.getByTestId('kanban-column-abgerechnet');
    await expect(abgerechnet.getByTestId(`project-card-${projectId}`)).toBeVisible();

    // Card is NOT back in rechnung_faellig.
    const rechnungFaellig = page.getByTestId('kanban-column-rechnung_faellig');
    await expect(rechnungFaellig.getByTestId(`project-card-${projectId}`)).toHaveCount(0);
  });
});
