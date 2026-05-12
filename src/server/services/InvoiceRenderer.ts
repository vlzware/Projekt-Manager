/**
 * Invoice renderer — ZUGFeRD EN 16931 (Comfort profile) PDF/A-3 with
 * embedded `factur-x.xml`.
 *
 * ADR-0026 pins the wire shape: profile `zugferd-en16931`, PDF/A-3
 * structural wrapper, embedded `factur-x.xml`, German-language
 * human-readable body carrying the per-tax-mode boilerplate. The
 * pure-Node toolchain is pinned at `pdf-lib` (PDF generation +
 * embedded-file attachment) + `libxmljs2` (per-render XSD validation
 * against EN 16931 so a non-conformant XML aborts the issuance atom
 * rather than landing on B2; see `invoice/xsdValidator.ts`).
 *
 * Why pure-Node instead of Mustangproject / JVM: the alternative would
 * pull a JVM and a 300 MB native dependency into the `app` service for
 * a single transactional render. The Handwerker B2B receiver mix
 * accepts structurally-correct ZUGFeRD; certified PDF/A-3 (via
 * veraPDF) is a future-work seam and not a §14a UStG requirement.
 *
 * Surface kept stable from the Phase B stub: named `InvoiceRenderer`
 * class export (used by `InvoiceService`'s constructor injection) and
 * `default` object export (used by the mock-seam in
 * `src/server/__tests__/invoices-issue.test.ts:521-536`). Both
 * `render()` shapes are async — pdf-lib's `embedFont` /
 * `doc.save()` are async by construction.
 *
 * Split across four sibling files for readability:
 *   - `invoice/facturXmlBuilder.ts` — EN 16931 CII-100 XML builder.
 *   - `invoice/xsdValidator.ts`     — per-render EN 16931 XSD check.
 *   - `invoice/pdfDrawer.ts`        — pdf-lib drawing + attach().
 *   - `invoice/boilerplate.ts`      — per-tax-mode legal strings.
 */

import type { CompanyProfile, Invoice } from '../../domain/invoice.js';
import { buildFacturXml } from './invoice/facturXmlBuilder.js';
import { drawInvoicePdf } from './invoice/pdfDrawer.js';
import { validateFacturXml } from './invoice/xsdValidator.js';

/**
 * What the renderer hands back to the issuance transaction. The bytes
 * ride the existing binary descriptor pipeline (ADR-0022 / ADR-0024)
 * via `InvoiceService.persistRenderedBinary`; the XML payload is
 * exposed separately so the test harness can re-assert AT-117 without
 * re-extracting from the PDF/A-3 envelope. `render()` already runs the
 * EN 16931 XSD check against the XML before this struct is returned —
 * a non-conformant payload throws and the caller's transaction rolls
 * back. The exposed `facturXml` is therefore always a valid Comfort-
 * profile payload at the point the caller sees it.
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

export class InvoiceRenderer {
  /**
   * Build the EN 16931 XML, then the PDF/A-3 wrapper with the XML
   * embedded as `factur-x.xml`. Both async — pdf-lib's font embedding
   * and stream serialisation are I/O-shaped even when the bytes are
   * synthesised in memory.
   *
   * The `companyProfile` parameter is intentionally unused on the
   * current rendering — all displayable issuer fields are already
   * snapshotted on the invoice row (`invoice.issuer`). The parameter
   * is kept on the input contract for future render-only attributes
   * (logo binary descriptor reference, accent color) which live on the
   * singleton, not the snapshot, and will land without a service-side
   * call-site change.
   */
  async render(input: InvoiceRenderInput): Promise<RenderedInvoice> {
    void input.companyProfile;
    const facturXml = buildFacturXml(input.invoice);
    validateFacturXml(facturXml);
    const pdfBytes = await drawInvoicePdf(input.invoice, facturXml);
    return { pdfBytes, facturXml };
  }
}

/**
 * Default export — the test seam in `invoices-issue.test.ts:521-536`
 * mocks both `InvoiceRenderer` and `default`. Matching the shape here
 * keeps the seam wire-compatible regardless of how the impl team
 * imports the renderer from the service.
 */
const defaultRenderer = new InvoiceRenderer();
export default {
  render: (input: InvoiceRenderInput): Promise<RenderedInvoice> => defaultRenderer.render(input),
};
