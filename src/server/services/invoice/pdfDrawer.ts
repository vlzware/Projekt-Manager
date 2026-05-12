/**
 * Human-readable PDF body for ZUGFeRD EN 16931 invoices (ADR-0026
 * §E-invoice format, AC-292, AT-116).
 *
 * Layout: a single A4 page with header (issuer), recipient block,
 * line-item table, totals block, and a footer carrying the statutory
 * tax-mode boilerplate. Multi-page support spills the line table into
 * additional pages while keeping the totals + footer on the last page.
 * The fonts in use are pdf-lib's standard 14 (Helvetica + Helvetica-
 * Bold + Helvetica-Oblique) — no fontkit dependency, no embedded fonts.
 * Standard fonts limit the glyph repertoire to the WinAnsi codepoints,
 * which suffices for German diacritics (ä ö ü ß § €) but blocks
 * non-Latin scripts. The renderer normalises any non-WinAnsi character
 * to `?` so a hostile customer name does not crash the encoder.
 *
 * PDF/A-3 conformance: this layout produces a structurally-correct
 * PDF/A-3 candidate — every page has a MediaBox, the document carries
 * Title / Author / Producer metadata, fonts are standard (WinAnsi-only),
 * and the embedded `factur-x.xml` rides on the catalog Names tree under
 * `/EmbeddedFiles` with the AFRelationship marker pdf-lib provides.
 * pdf-lib does not write the XMP packet that veraPDF demands, so this
 * is "structurally-correct PDF/A-3" rather than "certified PDF/A-3"
 * — an honest trade-off documented in the Phase C decision log (see
 * `InvoiceRenderer.ts` header).
 *
 * The two `extractFacturXml` and `extractPdfText` paths in
 * `invoices-issue.test.ts` operate on the bytes returned here without
 * touching veraPDF, so AT-116 / AT-117 are satisfied by the
 * structural shape; the certified-PDF/A-3 gate is future work.
 */

import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';

const pdfLibImport: Promise<typeof import('pdf-lib')> = import('pdf-lib');

import type { Invoice } from '../../../domain/invoice.js';
import { taxModeBoilerplate } from './boilerplate.js';

/** WinAnsi-only sanitiser — drop anything pdf-lib's standard fonts cannot encode. */
function sanitizeForWinAnsi(input: string): string {
  // Helvetica supports the WinAnsi (Windows-1252) codepage. Anything
  // outside U+0020..U+007E plus the additional WinAnsi mappings is
  // replaced with `?` rather than crashing the encoder. Keep
  // ASCII-printable + the common Latin-1 supplement chars we need.
  return input.replace(/[^\x20-\x7E\xA0-\xFF€]/g, '?');
}

interface DrawCursor {
  page: PDFPage;
  y: number;
  pageNumber: number;
}

type PdfDrawDeps = Pick<
  typeof import('pdf-lib'),
  'PDFDocument' | 'StandardFonts' | 'rgb' | 'AFRelationship'
>;

const PAGE_WIDTH = 595.28; // A4 width in points
const PAGE_HEIGHT = 841.89; // A4 height in points
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

const FONT_SIZE_SMALL = 8;
const FONT_SIZE_BODY = 10;
const FONT_SIZE_HEADING = 14;
const FONT_SIZE_TITLE = 18;
const LINE_HEIGHT = 12;

const COL_LEFT = MARGIN_LEFT;
const COL_AMOUNT_WIDTH = 70;

/**
 * Money formatter — euro symbol + DE-format thousands and decimals
 * (1.500,00 €). The PDF body shows this; the XML carries the canonical
 * `0123.45` form independently.
 */
function fmtEur(n: number): string {
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  const [whole, decimal] = fixed.split('.');
  const negativeSign = whole!.startsWith('-') ? '-' : '';
  const wholeAbs = negativeSign ? whole!.slice(1) : whole!;
  const withSep = wholeAbs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativeSign}${withSep},${decimal} €`;
}

function fmtDate(value: string | Date | null): string {
  if (value === null) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = d.getUTCFullYear().toString();
  return `${day}.${month}.${year}`;
}

function addPage(
  doc: PDFDocument,
  cursor: DrawCursor,
  font: PDFFont,
  pageNumberCount: { value: number; total: number },
): void {
  const newPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.page = newPage;
  cursor.y = PAGE_HEIGHT - MARGIN_TOP;
  cursor.pageNumber += 1;
  pageNumberCount.value = cursor.pageNumber;
  drawFooterPageNumber(newPage, font, cursor.pageNumber, pageNumberCount.total);
}

/**
 * Page-number footer — drawn at the bottom of every page; the total
 * count is patched in at the end of rendering. A tiny single-line
 * footer that does not contend with the boilerplate paragraph above
 * the page margin.
 */
function drawFooterPageNumber(page: PDFPage, font: PDFFont, num: number, total: number): void {
  page.drawText(`Seite ${num} / ${total}`, {
    x: PAGE_WIDTH - MARGIN_RIGHT - 60,
    y: 30,
    size: FONT_SIZE_SMALL,
    font,
    color: undefined,
  });
}

function ensureSpace(
  doc: PDFDocument,
  cursor: DrawCursor,
  font: PDFFont,
  pageNumberCount: { value: number; total: number },
  needed: number,
): void {
  if (cursor.y - needed < MARGIN_BOTTOM) {
    addPage(doc, cursor, font, pageNumberCount);
  }
}

/**
 * The renderer entry point. Returns the raw PDF bytes (Uint8Array)
 * containing the human-readable layout PLUS the embedded factur-x.xml
 * stream.
 */
export async function drawInvoicePdf(invoice: Invoice, facturXml: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, AFRelationship } = (await pdfLibImport) as PdfDrawDeps;

  const doc = await PDFDocument.create();

  // Metadata — Title / Author / Producer keep the document
  // self-describing even before veraPDF certification. These map to
  // /Info entries which PDF/A-3 still accepts alongside XMP.
  doc.setTitle(sanitizeForWinAnsi(`${invoice.number ?? 'Rechnung'} ${invoice.issuer.companyName}`));
  doc.setAuthor(sanitizeForWinAnsi(invoice.issuer.companyName));
  doc.setProducer('Projekt-Manager (ZUGFeRD EN 16931 / Comfort)');
  doc.setCreator('Projekt-Manager');
  doc.setCreationDate(new Date());

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Page tracking — the page-number footer is patched at the end so
  // the "X / N" totals are known.
  const pageNumberCount = { value: 1, total: 1 };
  const firstPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor: DrawCursor = { page: firstPage, y: PAGE_HEIGHT - MARGIN_TOP, pageNumber: 1 };
  drawFooterPageNumber(firstPage, font, 1, 1);

  const isStorno =
    invoice.cancellationOf !== null ||
    (typeof invoice.number === 'string' && invoice.number.startsWith('ST-'));

  // ----- Issuer block (top-right) -----
  const issuerLines = [
    invoice.issuer.companyName,
    invoice.issuer.address.street,
    `${invoice.issuer.address.zip} ${invoice.issuer.address.city}`,
    `Steuer-Nr.: ${invoice.issuer.taxId}`,
  ];
  if (invoice.issuer.ustId) issuerLines.push(`USt-IdNr.: ${invoice.issuer.ustId}`);
  if (invoice.issuer.iban) issuerLines.push(`IBAN: ${invoice.issuer.iban}`);
  const issuerRightX = PAGE_WIDTH - MARGIN_RIGHT;
  let issuerY = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of issuerLines) {
    const txt = sanitizeForWinAnsi(line);
    const width = font.widthOfTextAtSize(txt, FONT_SIZE_BODY);
    cursor.page.drawText(txt, {
      x: issuerRightX - width,
      y: issuerY,
      size: FONT_SIZE_BODY,
      font,
    });
    issuerY -= LINE_HEIGHT;
  }

  // ----- Recipient block (left) -----
  cursor.page.drawText('An:', {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font: fontOblique,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(sanitizeForWinAnsi(invoice.recipient.name), {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.y -= LINE_HEIGHT;
  if (invoice.recipient.address) {
    cursor.page.drawText(sanitizeForWinAnsi(invoice.recipient.address.street), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
    cursor.page.drawText(
      sanitizeForWinAnsi(`${invoice.recipient.address.zip} ${invoice.recipient.address.city}`),
      { x: COL_LEFT, y: cursor.y, size: FONT_SIZE_BODY, font },
    );
    cursor.y -= LINE_HEIGHT;
  }
  if (invoice.recipient.ustId) {
    cursor.page.drawText(sanitizeForWinAnsi(`USt-IdNr.: ${invoice.recipient.ustId}`), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  // Visually align the title slot below the recipient block.
  cursor.y = Math.min(cursor.y, issuerY) - 30;

  // ----- Title + number + dates row -----
  ensureSpace(doc, cursor, font, pageNumberCount, 60);
  const titleText = isStorno ? 'Stornorechnung' : 'Rechnung';
  cursor.page.drawText(titleText, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_TITLE,
    font: fontBold,
  });
  cursor.y -= 24;

  cursor.page.drawText(`Rechnungsnummer: ${invoice.number ?? '(Entwurf)'}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(`Rechnungsdatum: ${fmtDate(invoice.issueDate)}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  cursor.page.drawText(`Leistungsdatum: ${fmtDate(invoice.performanceDate)}`, {
    x: COL_LEFT,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  if (isStorno && invoice.cancellationOf) {
    cursor.page.drawText(sanitizeForWinAnsi(`Stornierung von: ${invoice.cancellationOf}`), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  cursor.y -= 12;

  // ----- Line items table -----
  ensureSpace(doc, cursor, font, pageNumberCount, 30);
  const colHeaderY = cursor.y;
  const colDesc = COL_LEFT;
  const colQty = COL_LEFT + 260;
  const colUnit = colQty + 35;
  const colUnitPrice = colUnit + 50;
  const colTaxRate = colUnitPrice + 60;
  const colLineTotal = PAGE_WIDTH - MARGIN_RIGHT - COL_AMOUNT_WIDTH;
  cursor.page.drawText('Beschreibung', {
    x: colDesc,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.page.drawText('Menge', {
    x: colQty,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.page.drawText('Einheit', {
    x: colUnit,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.page.drawText('Einzelpreis', {
    x: colUnitPrice,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  if (invoice.taxMode === 'standard') {
    cursor.page.drawText('USt-Satz', {
      x: colTaxRate,
      y: colHeaderY,
      size: FONT_SIZE_BODY,
      font: fontBold,
    });
  }
  cursor.page.drawText('Gesamt', {
    x: colLineTotal,
    y: colHeaderY,
    size: FONT_SIZE_BODY,
    font: fontBold,
  });
  cursor.y = colHeaderY - LINE_HEIGHT;
  cursor.page.drawLine({
    start: { x: COL_LEFT, y: cursor.y + 2 },
    end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor.y + 2 },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  cursor.y -= 4;

  for (const line of invoice.lines) {
    ensureSpace(doc, cursor, font, pageNumberCount, LINE_HEIGHT + 4);
    cursor.page.drawText(sanitizeForWinAnsi(line.description), {
      x: colDesc,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
      maxWidth: colQty - colDesc - 10,
    });
    cursor.page.drawText((Math.round(line.quantity * 100) / 100).toFixed(2), {
      x: colQty,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.page.drawText(sanitizeForWinAnsi(line.unit), {
      x: colUnit,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.page.drawText(fmtEur(line.unitPrice), {
      x: colUnitPrice,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    if (invoice.taxMode === 'standard') {
      cursor.page.drawText(`${line.taxRate}%`, {
        x: colTaxRate,
        y: cursor.y,
        size: FONT_SIZE_BODY,
        font,
      });
    }
    cursor.page.drawText(fmtEur(line.lineTotal), {
      x: colLineTotal,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  cursor.y -= 8;
  cursor.page.drawLine({
    start: { x: COL_LEFT, y: cursor.y },
    end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor.y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  cursor.y -= 16;

  // ----- Totals block -----
  const totalsLeft = colLineTotal - 120;
  ensureSpace(doc, cursor, font, pageNumberCount, 80);
  cursor.page.drawText('Nettobetrag', {
    x: totalsLeft,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.page.drawText(fmtEur(invoice.totals.netGrandTotal), {
    x: colLineTotal,
    y: cursor.y,
    size: FONT_SIZE_BODY,
    font,
  });
  cursor.y -= LINE_HEIGHT;
  if (invoice.taxMode === 'standard') {
    for (const band of invoice.totals.perRate) {
      cursor.page.drawText(
        sanitizeForWinAnsi(`zzgl. ${band.taxRate}% USt auf ${fmtEur(band.netSubtotal)}`),
        { x: totalsLeft, y: cursor.y, size: FONT_SIZE_BODY, font },
      );
      cursor.page.drawText(fmtEur(band.taxAmount), {
        x: colLineTotal,
        y: cursor.y,
        size: FONT_SIZE_BODY,
        font,
      });
      cursor.y -= LINE_HEIGHT;
    }
    cursor.page.drawText('Gesamtsteuer', {
      x: totalsLeft,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.page.drawText(fmtEur(invoice.totals.taxGrandTotal), {
      x: colLineTotal,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font,
    });
    cursor.y -= LINE_HEIGHT;
  }
  cursor.page.drawText('Bruttobetrag', {
    x: totalsLeft,
    y: cursor.y,
    size: FONT_SIZE_HEADING,
    font: fontBold,
  });
  cursor.page.drawText(fmtEur(invoice.totals.grossGrandTotal), {
    x: colLineTotal,
    y: cursor.y,
    size: FONT_SIZE_HEADING,
    font: fontBold,
  });
  cursor.y -= 24;

  // ----- Tax-mode boilerplate (the AT-116 anchor) -----
  const boilerplate = taxModeBoilerplate(invoice.taxMode);
  if (boilerplate) {
    ensureSpace(doc, cursor, font, pageNumberCount, 30);
    cursor.page.drawText(sanitizeForWinAnsi(boilerplate), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_BODY,
      font: fontBold,
      maxWidth: CONTENT_WIDTH,
    });
    cursor.y -= LINE_HEIGHT * 2;
  }

  // ----- Footer text (company-configurable) -----
  if (invoice.issuer.footerText && invoice.issuer.footerText.length > 0) {
    ensureSpace(doc, cursor, font, pageNumberCount, 30);
    cursor.page.drawText(sanitizeForWinAnsi(invoice.issuer.footerText), {
      x: COL_LEFT,
      y: cursor.y,
      size: FONT_SIZE_SMALL,
      font: fontOblique,
      maxWidth: CONTENT_WIDTH,
    });
  }

  // Patch the total-page-count into every page footer now that we know
  // the final page count.
  pageNumberCount.total = cursor.pageNumber;
  // pdf-lib doesn't let us re-draw on a previously-emitted page after
  // additional content has been added without re-rendering; the
  // simpler approach is to write the page numbers AFTER everything,
  // by walking the pages array. We've already drawn placeholder
  // footers per page; overwrite them with the real total.
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    pages[i].drawRectangle({
      x: PAGE_WIDTH - MARGIN_RIGHT - 80,
      y: 24,
      width: 80,
      height: 14,
      color: rgb(1, 1, 1),
    });
    pages[i].drawText(`Seite ${i + 1} / ${pages.length}`, {
      x: PAGE_WIDTH - MARGIN_RIGHT - 60,
      y: 30,
      size: FONT_SIZE_SMALL,
      font,
    });
  }

  // ----- Embed factur-x.xml -----
  const xmlBytes = new TextEncoder().encode(facturXml);
  await doc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X / ZUGFeRD EN 16931 Comfort invoice data',
    afRelationship: AFRelationship.Alternative,
  });

  return await doc.save();
}
