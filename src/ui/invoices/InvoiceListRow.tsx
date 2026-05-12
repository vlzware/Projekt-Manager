/**
 * Single row on the standalone /rechnungen list (ui/invoices.md §8.16.1).
 *
 * Click anywhere on the row → navigate to the per-project detail page
 * (the per-invoice viewer route is deferred — see Chunk C report). The
 * PDF anchor lives inside the row; its click is stopped from bubbling so
 * a download click does not double-fire navigation.
 */

import { useNavigate } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import type { Invoice } from '@/domain/invoice';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import styles from './InvoiceListView.module.css';

interface RowAttrs {
  label: string;
  className: string;
  rowClassName: string;
}

function statusAttrs(invoice: Invoice): RowAttrs {
  if (invoice.cancellationOf) {
    return {
      label: STRINGS.invoices.statusStorno,
      className: `${styles.statusBadge} ${styles.statusStorno}`,
      rowClassName: `${styles.row} ${styles.rowStorno}`,
    };
  }
  switch (invoice.status) {
    case 'draft':
      return {
        label: STRINGS.invoices.statusDraft,
        className: styles.statusBadge,
        rowClassName: styles.row,
      };
    case 'issued':
      return {
        label: STRINGS.invoices.statusIssued,
        className: `${styles.statusBadge} ${styles.statusIssued}`,
        rowClassName: styles.row,
      };
    case 'cancelled':
      return {
        label: STRINGS.invoices.statusCancelled,
        className: `${styles.statusBadge} ${styles.statusCancelled}`,
        rowClassName: `${styles.row} ${styles.rowCancelled}`,
      };
  }
}

interface Props {
  invoice: Invoice;
  /** Original's `number`, when this row is a Storno sibling. */
  originalNumber: string | null;
}

export function InvoiceListRow({ invoice, originalNumber }: Props) {
  const navigate = useNavigate();
  const attrs = statusAttrs(invoice);
  const showDownload = invoice.status !== 'draft';

  return (
    <button
      type="button"
      className={attrs.rowClassName}
      onClick={() => navigate(`/projects/${invoice.projectId}`)}
      data-testid={`invoice-row-${invoice.id}`}
    >
      <div>
        <div className={styles.cellNumber} data-testid="invoice-number">
          {invoice.number ?? '—'}
        </div>
        {invoice.cancellationOf && originalNumber && (
          <div className={styles.stornoOfHint} data-testid="invoice-storno-of">
            {STRINGS.invoices.stornoOfLabel(originalNumber)}
          </div>
        )}
      </div>
      <div>
        <span className={attrs.className} data-testid="invoice-status-badge">
          {attrs.label}
        </span>
      </div>
      <div>{invoice.issueDate ? formatDateDE(invoice.issueDate) : '—'}</div>
      <div className={styles.cellRecipient}>{invoice.recipient.name}</div>
      <div className={styles.cellTotal}>{formatCurrencyDE(invoice.totals.grossGrandTotal)}</div>
      <div className={styles.rowActions}>
        {showDownload && (
          <a
            className={styles.downloadLink}
            href={`/api/invoices/${invoice.id}/pdf`}
            download={`${invoice.number ?? invoice.id}.pdf`}
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            data-testid="invoice-download-pdf"
          >
            {STRINGS.invoices.downloadPdfAction}
          </a>
        )}
      </div>
    </button>
  );
}
