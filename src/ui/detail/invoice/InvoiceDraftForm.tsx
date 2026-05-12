/**
 * Inline invoice-draft form (ui/invoices.md §8.16.2).
 *
 * Mounted from `InvoiceSection` when the user clicks `+ Neue Rechnung` on
 * a project in `rechnung_faellig`. The form drives a two-call sequence:
 * first `createDraft` to mint the row server-side (which pre-fills the
 * `recipient` snapshot from the project's customer), then `updateDraft`
 * on every save while the form is open. The split keeps the recipient
 * snapshot under server control — the client never has to copy the
 * customer fields out of `project.customer` and risk a stale read.
 *
 * Editing an existing draft: the form mounts with that draft's id and
 * skips the create step.
 *
 * Line totals are computed client-side as a UX preview only; the server
 * re-derives `lineTotal` + the totals block on every PATCH and POST
 * /issue (AC-286).
 */

import { useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import {
  TAX_MODES,
  round2,
  type Invoice,
  type InvoiceLine,
  type InvoiceRecipientSnapshot,
  type TaxMode,
} from '@/domain/invoice';
import { useInvoiceStore } from '@/state/invoiceStore';
import { dateInputValue } from '../dateInputValue';
import styles from './InvoiceSection.module.css';

interface Props {
  projectId: string;
  /**
   * Existing draft to edit. `null` means we are creating a fresh draft —
   * on first save the store dispatches `createDraft` to mint it server-
   * side; the response carries the server-allocated id which subsequent
   * saves use to PATCH.
   */
  draft: Invoice | null;
  /** Project planned-end ISO date — pre-fills the performance date input. */
  defaultPerformanceDate: string | null;
  /** Customer snapshot for the recipient block when no draft is loaded yet. */
  fallbackRecipient: { name: string; street: string; zip: string; city: string };
  onClose: () => void;
}

interface LineDraft {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
}

interface RecipientDraft {
  name: string;
  street: string;
  zip: string;
  city: string;
}

function emptyLine(): LineDraft {
  return { description: '', quantity: '1', unit: '', unitPrice: '', taxRate: '19' };
}

function linesFromInvoice(inv: Invoice): LineDraft[] {
  if (inv.lines.length === 0) return [emptyLine()];
  return inv.lines.map((l) => ({
    description: l.description,
    quantity: String(l.quantity),
    unit: l.unit,
    unitPrice: String(l.unitPrice),
    taxRate: String(l.taxRate),
  }));
}

function recipientFromInvoice(inv: Invoice): RecipientDraft {
  return {
    name: inv.recipient.name,
    street: inv.recipient.address?.street ?? '',
    zip: inv.recipient.address?.zip ?? '',
    city: inv.recipient.address?.city ?? '',
  };
}

function parseNumber(value: string): number {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function toWireLines(lines: LineDraft[]): InvoiceLine[] {
  return lines
    .filter((l) => l.description.trim().length > 0 || parseNumber(l.unitPrice) !== 0)
    .map((l) => {
      const quantity = parseNumber(l.quantity);
      const unitPrice = parseNumber(l.unitPrice);
      const taxRate = parseNumber(l.taxRate);
      return {
        description: l.description.trim(),
        quantity,
        unit: l.unit.trim(),
        unitPrice,
        lineTotal: round2(quantity * unitPrice),
        taxRate,
      };
    });
}

function toWireRecipient(r: RecipientDraft): InvoiceRecipientSnapshot {
  const street = r.street.trim();
  const zip = r.zip.trim();
  const city = r.city.trim();
  const hasAddress = street.length > 0 || zip.length > 0 || city.length > 0;
  return {
    name: r.name.trim(),
    address: hasAddress ? { street, zip, city } : null,
    ustId: null,
  };
}

export function InvoiceDraftForm({
  projectId,
  draft,
  defaultPerformanceDate,
  fallbackRecipient,
  onClose,
}: Props) {
  const createDraft = useInvoiceStore((s) => s.createDraft);
  const updateDraft = useInvoiceStore((s) => s.updateDraft);

  const [recipient, setRecipient] = useState<RecipientDraft>(
    draft ? recipientFromInvoice(draft) : fallbackRecipient,
  );
  const [lines, setLines] = useState<LineDraft[]>(draft ? linesFromInvoice(draft) : [emptyLine()]);
  const [taxMode, setTaxMode] = useState<TaxMode>(draft?.taxMode ?? 'standard');
  const [performanceDate, setPerformanceDate] = useState<string>(
    dateInputValue(draft?.performanceDate ?? defaultPerformanceDate),
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Track the server-assigned id so consecutive saves PATCH the same row
  // rather than POSTing a fresh one. `useRef` (not `useState`) because the
  // value is read inside `handleSave` and we don't need a re-render on
  // update; a setState here would have to be flushed before the next
  // `handleSave` call could see it.
  const draftIdRef = useRef<string | null>(draft?.id ?? null);

  const handleSave = async () => {
    if (submitting) return;
    setErrorMessage(null);
    setSubmitting(true);

    const wireLines = toWireLines(lines);
    const wireRecipient = toWireRecipient(recipient);
    const wirePerformanceDate = performanceDate ? performanceDate : null;

    const currentDraftId = draftIdRef.current;
    const outcome = currentDraftId
      ? await updateDraft(currentDraftId, projectId, {
          lines: wireLines,
          recipient: wireRecipient,
          taxMode,
          performanceDate: wirePerformanceDate,
        })
      : await createDraft(projectId, {
          lines: wireLines,
          recipient: wireRecipient,
          taxMode,
          performanceDate: wirePerformanceDate,
        });

    setSubmitting(false);

    if (outcome.status === 'ok') {
      // Capture the server-assigned id so if the user somehow re-opens
      // the same form instance the next save PATCHes; in the current UI
      // the form closes immediately on success, but the ref hand-off
      // is correct either way.
      if (outcome.invoice && !draftIdRef.current) {
        draftIdRef.current = outcome.invoice.id;
      }
      onClose();
      return;
    }
    setErrorMessage(outcome.errorMessage);
  };

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (idx: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)));
  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  return (
    <div className={styles.formOverlay} data-testid="invoice-form-overlay">
      <form
        className={styles.formPanel}
        data-testid="invoice-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <h2 className={styles.formTitle}>{STRINGS.invoices.newInvoice}</h2>

        <section className={styles.formSection}>
          <h3 className={styles.formSectionHeading}>{STRINGS.invoices.formRecipientHeading}</h3>
          <p className={styles.formHint}>{STRINGS.invoices.formRecipientFrozenHint}</p>
          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-recipient-name">
                {STRINGS.invoices.formRecipientName}
              </label>
              <input
                id="invoice-recipient-name"
                className={styles.formInput}
                value={recipient.name}
                onChange={(e) => setRecipient((r) => ({ ...r, name: e.target.value }))}
                disabled={submitting}
                data-testid="invoice-recipient-name-input"
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-recipient-street">
                {STRINGS.invoices.formRecipientStreet}
              </label>
              <input
                id="invoice-recipient-street"
                className={styles.formInput}
                value={recipient.street}
                onChange={(e) => setRecipient((r) => ({ ...r, street: e.target.value }))}
                disabled={submitting}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-recipient-zip">
                {STRINGS.invoices.formRecipientZip}
              </label>
              <input
                id="invoice-recipient-zip"
                className={styles.formInput}
                value={recipient.zip}
                onChange={(e) => setRecipient((r) => ({ ...r, zip: e.target.value }))}
                disabled={submitting}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="invoice-recipient-city">
                {STRINGS.invoices.formRecipientCity}
              </label>
              <input
                id="invoice-recipient-city"
                className={styles.formInput}
                value={recipient.city}
                onChange={(e) => setRecipient((r) => ({ ...r, city: e.target.value }))}
                disabled={submitting}
              />
            </div>
          </div>
        </section>

        <section className={styles.formSection}>
          <h3 className={styles.formSectionHeading}>{STRINGS.invoices.formLinesHeading}</h3>
          <div className={styles.lineTableScroll}>
            <table className={styles.lineTable}>
              <thead>
                <tr>
                  <th>{STRINGS.invoices.formLineDescription}</th>
                  <th>{STRINGS.invoices.formLineQuantity}</th>
                  <th>{STRINGS.invoices.formLineUnit}</th>
                  <th>{STRINGS.invoices.formLineUnitPrice}</th>
                  <th>{STRINGS.invoices.formLineTaxRate}</th>
                  <th className={styles.lineActions} aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  // Row 0 carries the un-suffixed testids the E2E pins
                  // (`invoice-line-description-input`, etc.); subsequent
                  // rows carry the `-${idx}` suffix.
                  const suffix = idx === 0 ? '' : `-${idx}`;
                  return (
                    <tr key={idx}>
                      <td>
                        <input
                          className={styles.formInput}
                          value={line.description}
                          onChange={(e) => updateLine(idx, { description: e.target.value })}
                          disabled={submitting}
                          data-testid={`invoice-line-description-input${suffix}`}
                        />
                      </td>
                      <td>
                        <input
                          className={styles.formInput}
                          value={line.quantity}
                          onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                          disabled={submitting}
                          inputMode="decimal"
                          data-testid={`invoice-line-quantity-input${suffix}`}
                        />
                      </td>
                      <td>
                        <input
                          className={styles.formInput}
                          value={line.unit}
                          onChange={(e) => updateLine(idx, { unit: e.target.value })}
                          disabled={submitting}
                          data-testid={`invoice-line-unit-input${suffix}`}
                        />
                      </td>
                      <td>
                        <input
                          className={styles.formInput}
                          value={line.unitPrice}
                          onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                          disabled={submitting}
                          inputMode="decimal"
                          data-testid={`invoice-line-unit-price-input${suffix}`}
                        />
                      </td>
                      <td>
                        <input
                          className={styles.formInput}
                          value={line.taxRate}
                          onChange={(e) => updateLine(idx, { taxRate: e.target.value })}
                          disabled={submitting}
                          inputMode="decimal"
                          data-testid={`invoice-line-tax-rate-input${suffix}`}
                        />
                      </td>
                      <td className={styles.lineActions}>
                        <button
                          type="button"
                          className={styles.lineRemoveButton}
                          onClick={() => removeLine(idx)}
                          disabled={submitting || lines.length === 1}
                          aria-label={STRINGS.invoices.formRemoveLine}
                          title={STRINGS.invoices.formRemoveLine}
                        >
                          {'×'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={styles.addLineButton}
            onClick={addLine}
            disabled={submitting}
          >
            {STRINGS.invoices.formAddLine}
          </button>
        </section>

        <div className={styles.formGrid}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="invoice-tax-mode">
              {STRINGS.invoices.formTaxMode}
            </label>
            <select
              id="invoice-tax-mode"
              className={styles.formSelect}
              value={taxMode}
              onChange={(e) => setTaxMode(e.target.value as TaxMode)}
              disabled={submitting}
              data-testid="invoice-tax-mode-select"
            >
              {TAX_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode === 'standard'
                    ? STRINGS.companyProfile.taxModeStandard
                    : mode === 'kleinunternehmer'
                      ? STRINGS.companyProfile.taxModeKleinunternehmer
                      : STRINGS.companyProfile.taxModeReverseCharge}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="invoice-performance-date">
              {STRINGS.invoices.formPerformanceDate}
            </label>
            <input
              id="invoice-performance-date"
              type="date"
              className={styles.formInput}
              value={performanceDate}
              onChange={(e) => setPerformanceDate(e.target.value)}
              disabled={submitting}
              data-testid="invoice-performance-date-input"
            />
          </div>
        </div>

        {errorMessage && (
          <div className={styles.errorBanner} role="status">
            {errorMessage}
          </div>
        )}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onClose}
            disabled={submitting}
          >
            {STRINGS.ui.cancel}
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={submitting}
            data-testid="invoice-form-save"
          >
            {STRINGS.invoices.saveAction}
          </button>
        </div>
      </form>
    </div>
  );
}
