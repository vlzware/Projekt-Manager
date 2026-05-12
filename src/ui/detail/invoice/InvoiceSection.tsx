/**
 * Per-project invoice block (ui/project-detail.md §8.15.11, ADR-0026).
 *
 * Surfaces the project's invoices as a list with row-level actions
 * (issue / cancel / PDF), the `Neue Rechnung` CTA, the inline draft
 * form, and the Storno confirmation dialog. Mounted from
 * `ProjectDetailPage` between the Attachments section and the Activity
 * Feed; the page never holds invoice state directly.
 *
 * Permission gating: the whole section is hidden for callers without
 * `invoice:read` (workers — server is authoritative via the repository
 * scope predicate). The `Neue Rechnung` CTA is additionally gated on
 * `invoice:write` AND `project.status === 'rechnung_faellig'` per
 * spec §8.15.11.
 *
 * Realtime: a global `invoice_changed` SSE subscription
 * (state/invoiceSseSubscription.ts) refreshes every project's invoice
 * list when another session issues / cancels.
 */

import { useEffect, useMemo, useState } from 'react';
import { STRINGS } from '@/config/strings';
import type { WorkflowState } from '@/config/stateConfig';
import type { Invoice } from '@/domain/invoice';
import { orderInvoicesWithStornoGrouping } from '@/domain/invoiceGrouping';
import { formatCurrencyDE, formatDateDE } from '@/domain/dateFormat';
import { useInvoiceStore } from '@/state/invoiceStore';
import { useProjectStore } from '@/state/projectStore';
import { useConfirmStore } from '@/state/confirmStore';
import { usePermission } from '@/hooks/usePermission';
import { InvoiceDraftForm } from './InvoiceDraftForm';
import { InvoiceCancelDialog } from './InvoiceCancelDialog';
import styles from './InvoiceSection.module.css';

interface Props {
  projectId: string;
  projectStatus: WorkflowState;
}

export function InvoiceSection({ projectId, projectStatus }: Props) {
  const canRead = usePermission('invoice:read');
  const canWrite = usePermission('invoice:write');

  const invoices = useInvoiceStore((s) => s.byProject[projectId]);
  const loading = useInvoiceStore((s) => s.loadingByProject[projectId] ?? false);
  const error = useInvoiceStore((s) => s.errorByProject[projectId] ?? null);
  const fetchByProject = useInvoiceStore((s) => s.fetchByProject);
  const issueInvoice = useInvoiceStore((s) => s.issue);
  const cancelInvoice = useInvoiceStore((s) => s.cancel);
  const deleteDraft = useInvoiceStore((s) => s.deleteDraft);

  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const requestConfirm = useConfirmStore((s) => s.request);

  const [formOpen, setFormOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState<Invoice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Invoice | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    void fetchByProject(projectId);
  }, [canRead, fetchByProject, projectId]);

  // The Storno row's display number lookup. Map id -> Invoice so the
  // row can render `Storno zu RE-YYYY-NNNN` even when the original sits
  // elsewhere in the array.
  const invoicesById = useMemo(() => {
    const map = new Map<string, Invoice>();
    for (const inv of invoices ?? []) {
      map.set(inv.id, inv);
    }
    return map;
  }, [invoices]);

  // Storno grouping rule (ui/invoices.md §8.16.1) — see helper docstring.
  const orderedInvoices = useMemo(
    () => orderInvoicesWithStornoGrouping(invoices ?? []),
    [invoices],
  );

  if (!canRead) return null;

  const showCreateCta = canWrite && projectStatus === 'rechnung_faellig';

  const handleIssue = async (invoice: Invoice) => {
    setActionError(null);
    const ok = await requestConfirm(STRINGS.invoices.issueConfirmBody, {
      title: STRINGS.invoices.issueConfirmTitle,
      confirmLabel: STRINGS.invoices.issueConfirmOk,
    });
    if (!ok) return;
    const outcome = await issueInvoice(invoice.id, projectId);
    if (outcome.status !== 'ok') {
      setActionError(outcome.errorMessage);
      return;
    }
    // The issue path flips the project status server-side (AC-287). Refresh
    // the project so the Kanban / detail header reflect the new state without
    // requiring a manual reload.
    void useProjectStore.getState().fetchProject(projectId);
  };

  const handleDeleteDraft = async (invoice: Invoice) => {
    setActionError(null);
    const ok = await requestConfirm(STRINGS.invoices.deleteDraftConfirm);
    if (!ok) return;
    const outcome = await deleteDraft(invoice.id, projectId);
    if (outcome.status !== 'ok') {
      setActionError(outcome.errorMessage);
    }
  };

  const handleCancelConfirm = async (reason: string) => {
    if (!cancelTarget) return;
    setCancelSubmitting(true);
    setCancelError(null);
    const outcome = await cancelInvoice(cancelTarget.id, projectId, reason);
    setCancelSubmitting(false);
    if (outcome.status !== 'ok') {
      setCancelError(outcome.errorMessage);
      return;
    }
    setCancelTarget(null);
  };

  const downloadPdf = (invoice: Invoice) => {
    // Use a programmatic <a download> click so the browser's download
    // observer (the E2E's `page.waitForEvent('download')`) fires.
    const anchor = document.createElement('a');
    anchor.href = `/api/invoices/${invoice.id}/pdf`;
    anchor.download = `${invoice.number ?? invoice.id}.pdf`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const renderEmpty = !loading && (invoices ?? []).length === 0;

  return (
    <section
      className={styles.section}
      aria-label={STRINGS.invoices.sectionHeading}
      data-testid="project-invoice-section"
    >
      <div className={styles.header}>
        <h3 className={styles.heading}>{STRINGS.invoices.sectionHeading}</h3>
        {showCreateCta && (
          <button
            type="button"
            className={styles.createButton}
            onClick={() => {
              setEditingDraft(null);
              setFormOpen(true);
            }}
            data-testid="invoice-draft-create"
          >
            {STRINGS.invoices.newInvoice}
          </button>
        )}
      </div>

      {error && (
        <div className={styles.errorBanner} role="status">
          {error}
        </div>
      )}
      {actionError && (
        <div className={styles.errorBanner} role="status">
          {actionError}
        </div>
      )}

      {renderEmpty ? (
        <div className={styles.empty} data-testid="invoice-list-empty">
          {STRINGS.invoices.empty}
        </div>
      ) : (
        <div className={styles.list} data-testid="invoice-list">
          {orderedInvoices.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              originalNumber={
                invoice.cancellationOf
                  ? (invoicesById.get(invoice.cancellationOf)?.number ?? null)
                  : null
              }
              canWrite={canWrite}
              onIssue={() => void handleIssue(invoice)}
              onEditDraft={() => {
                setEditingDraft(invoice);
                setFormOpen(true);
              }}
              onDeleteDraft={() => void handleDeleteDraft(invoice)}
              onCancel={() => {
                setCancelError(null);
                setCancelTarget(invoice);
              }}
              onDownloadPdf={() => downloadPdf(invoice)}
            />
          ))}
        </div>
      )}

      {formOpen && (
        <InvoiceDraftForm
          projectId={projectId}
          draft={editingDraft}
          defaultPerformanceDate={project?.plannedEnd ?? null}
          fallbackRecipient={{
            name: project?.customer?.name ?? '',
            street: project?.customer?.address?.street ?? '',
            zip: project?.customer?.address?.zip ?? '',
            city: project?.customer?.address?.city ?? '',
          }}
          onClose={() => {
            setFormOpen(false);
            setEditingDraft(null);
          }}
        />
      )}

      <InvoiceCancelDialog
        isOpen={cancelTarget !== null}
        submitting={cancelSubmitting}
        errorMessage={cancelError}
        onConfirm={(reason) => void handleCancelConfirm(reason)}
        onClose={() => {
          if (cancelSubmitting) return;
          setCancelTarget(null);
          setCancelError(null);
        }}
      />
    </section>
  );
}

interface InvoiceRowProps {
  invoice: Invoice;
  /** Cancellation original's `number`, when this row is a Storno sibling. */
  originalNumber: string | null;
  canWrite: boolean;
  onIssue: () => void;
  onEditDraft: () => void;
  onDeleteDraft: () => void;
  onCancel: () => void;
  onDownloadPdf: () => void;
}

function statusLabelClass(invoice: Invoice): {
  label: string;
  className: string;
  rowClassName: string;
} {
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

function InvoiceRow({
  invoice,
  originalNumber,
  canWrite,
  onIssue,
  onEditDraft,
  onDeleteDraft,
  onCancel,
  onDownloadPdf,
}: InvoiceRowProps) {
  const status = statusLabelClass(invoice);
  const isStorno = invoice.cancellationOf !== null;
  const isDraft = invoice.status === 'draft';
  const isIssued = invoice.status === 'issued' && !isStorno;
  // Storno rows are status='issued' with a non-null cancellationOf; they
  // should not expose Cancel (the cancellation atom would create a Storno
  // of a Storno — not a thing). PDF download remains.
  // Cancelled originals expose PDF only.

  return (
    <div className={status.rowClassName} data-testid={`invoice-row-${invoice.id}`}>
      <div>
        <div className={styles.cellNumber} data-testid="invoice-number">
          {invoice.number ?? '—'}
        </div>
        {isStorno && originalNumber && (
          <div className={styles.stornoOfHint} data-testid="invoice-storno-of">
            {STRINGS.invoices.stornoOfLabel(originalNumber)}
          </div>
        )}
      </div>
      <div>
        <span className={status.className} data-testid="invoice-status-badge">
          {status.label}
        </span>
      </div>
      <div>{invoice.issueDate ? formatDateDE(invoice.issueDate) : '—'}</div>
      <div className={styles.cellRecipient}>{invoice.recipient.name}</div>
      <div className={styles.cellTotal}>{formatCurrencyDE(invoice.totals.grossGrandTotal)}</div>
      <div className={styles.actions}>
        {isDraft && canWrite && (
          <>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onEditDraft}
              data-testid="invoice-draft-edit"
            >
              {STRINGS.invoices.editDraftAction}
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onIssue}
              data-testid="invoice-issue-button"
            >
              {STRINGS.invoices.issueAction}
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionDanger}`}
              onClick={onDeleteDraft}
              data-testid="invoice-draft-delete"
              aria-label={STRINGS.invoices.deleteDraftAction}
              title={STRINGS.invoices.deleteDraftAction}
            >
              {'×'}
            </button>
          </>
        )}
        {!isDraft && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onDownloadPdf}
            data-testid="invoice-download-pdf"
          >
            {STRINGS.invoices.downloadPdfAction}
          </button>
        )}
        {isIssued && canWrite && (
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionDanger}`}
            onClick={onCancel}
            data-testid="invoice-cancel-button"
          >
            {STRINGS.invoices.cancelAction}
          </button>
        )}
      </div>
    </div>
  );
}
