/**
 * Invoice renderer — STUB.
 *
 * Phase C (the next iteration) wires the ZUGFeRD EN 16931 implementation:
 * PDF/A-3 + embedded `factur-x.xml`. Until then `render()` throws — the
 * issuance transaction (`InvoiceService.issueDraft`) reaches step 6 and
 * surfaces the failure. AT-116 (per-mode boilerplate) and AT-117
 * (XSD validation against EN 16931) remain red by construction.
 *
 * The seam is intentional. The mocking pattern in
 * `src/server/__tests__/invoices-issue.test.ts:521-536` uses `vi.doMock`
 * against this exact module path and replaces the renderer with a
 * sentinel-throwing implementation to drive the rollback / gapless-
 * sequence test (AC-288). Both the named `InvoiceRenderer` class export
 * AND the `default` export with a `render` method are mocked, so this
 * module exposes both shapes for parity.
 *
 * ADR-0026 §E-invoice format pins the contract:
 *   - profile: `'zugferd-en16931'` (Comfort) in v1
 *   - PDF/A-3 wrapper, embedded `factur-x.xml` conforming to EN 16931
 *   - rendering boilerplate per-tax-mode (§19 UStG / §13b UStG strings)
 */

import type { CompanyProfile, Invoice } from '../../domain/invoice.js';

/**
 * What the renderer hands back to the issuance transaction. The bytes
 * ride the existing binary descriptor pipeline (ADR-0022 / ADR-0024)
 * once Phase C delivers; the XML payload is exposed separately so test
 * harnesses can XSD-validate it without re-extracting from the PDF/A-3
 * envelope (AT-117 has its own pdf-lib extraction path; this is the
 * convenience seam for any pre-storage pipeline step that needs the XML).
 */
export interface RenderedInvoice {
  pdfBytes: Uint8Array;
  facturXml: string;
}

/**
 * Render-time input — the issuance service passes the snapshotted
 * invoice row (issuer / recipient / lines already frozen on the row by
 * the time `render()` is called) plus the live `company_profile` row
 * for non-snapshotted concerns (logo descriptor reference, accent color
 * — both are render-only and live on the singleton, not the snapshot).
 *
 * No live customer reference is needed: the recipient block is part of
 * the snapshot.
 */
export interface InvoiceRenderInput {
  invoice: Invoice;
  companyProfile: CompanyProfile;
}

/**
 * The stub raises at every call site. Phase C replaces the body with
 * the real ZUGFeRD pipeline (Mustangproject / equivalent — pinned in
 * ADR-0026 §Operational). The signature is intentionally synchronous
 * here so the issuance transaction holds the `FOR UPDATE` lock for the
 * minimum window; if the production implementation needs async I/O
 * (logo fetch, font loading), it returns `Promise<RenderedInvoice>` and
 * the issuance service `await`s it.
 */
export class InvoiceRenderer {
  render(_input: InvoiceRenderInput): RenderedInvoice {
    throw new Error(
      'InvoiceRenderer.render(): stub — Phase C delivers the ZUGFeRD EN 16931 implementation',
    );
  }
}

/**
 * Default export — the test seam in `invoices-issue.test.ts:521-536`
 * mocks both `InvoiceRenderer` and `default`. Matching the shape here
 * keeps the seam wire-compatible regardless of how the impl team
 * eventually imports the renderer from the service.
 */
const defaultRenderer = new InvoiceRenderer();
export default {
  render: (input: InvoiceRenderInput): RenderedInvoice => defaultRenderer.render(input),
};
