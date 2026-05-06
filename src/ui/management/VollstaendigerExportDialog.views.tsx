/**
 * Phase-specific render branches for `VollstaendigerExportDialog`.
 *
 * Extracted to keep the dialog file under the C-SIZE ceiling. Each
 * phase view renders the shared `DialogShell` with its phase-specific
 * body and actions; the shell itself owns the overlay + dialog chrome
 * and the a11y attributes (role, aria-modal, aria-labelledby,
 * aria-describedby).
 *
 * Notes on size: this file runs slightly over 200 LOC because each of
 * the four phase views carries a few `data-testid` / `aria-*` /
 * `data-*` attributes the E2E spec scopes its assertions to; merging
 * any two of them would force phase branching back inside a single
 * function. Argued exception accepted.
 *
 * Kept local to `src/ui/management/` rather than promoted to
 * `src/ui/common/`: `ConfirmDialog` has a structurally similar shell
 * but its body is a single `<p>` (not a div carrying multiple row
 * children), so collapsing the two would force a needless slot
 * abstraction. If a third dialog with the same body shape lands, lift
 * `DialogShell` into a shared module.
 */

import { type ReactNode, type RefObject } from 'react';
import { STRINGS } from '@/config/strings';
import type { PreflightPhase, ProgressPhase, SummaryPhase, ErrorPhase } from './useExportAllRunner';
import styles from './VollstaendigerExportDialog.module.css';

/**
 * Format a byte count for human display. Decimal SI (KB/MB) — matches
 * what download UIs typically render (Chrome, Firefox both surface
 * decimal byte counts in their downloads UI). Two decimal places at the
 * MB+ tier; integer at B/KB.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface DialogShellProps {
  dialogRef: RefObject<HTMLDivElement | null>;
  testId: string;
  titleId: string;
  bodyId: string;
  title: string;
  body: ReactNode;
  actions: ReactNode;
}

/**
 * Phase-agnostic overlay + dialog wrapper. The `data-testid` on the
 * outer overlay is constant across phases (the E2E spec scopes mobile-
 * warning queries to the overlay), the phase-specific testId lands on
 * the inner dialog div.
 */
function DialogShell(props: DialogShellProps) {
  const { dialogRef, testId, titleId, bodyId, title, body, actions } = props;
  return (
    <div className={styles.overlay} data-testid="export-all-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={testId}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div id={bodyId} className={styles.body}>
          {body}
        </div>
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}

export interface PreflightViewProps {
  phase: PreflightPhase;
  isMobile: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreflightView(props: PreflightViewProps) {
  const { phase, isMobile, dialogRef, initialFocusRef, onCancel, onConfirm } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="export-all-preflight"
      titleId="export-all-preflight-title"
      bodyId="export-all-preflight-body"
      title={STRINGS.dataExchange.exportPreflightTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="export-all-preflight-count">
            {STRINGS.dataExchange.exportPreflightCount(phase.firstPage.totalCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="export-all-preflight-size"
            data-bytes-total={phase.firstPage.totalSizeBytes}
          >
            {STRINGS.dataExchange.exportPreflightSize(formatBytes(phase.firstPage.totalSizeBytes))}
          </div>
          {isMobile && (
            <div
              className={styles.mobileWarning}
              data-testid="export-all-preflight-mobile-warning"
              role="note"
            >
              {STRINGS.dataExchange.exportMobileWarning}
            </div>
          )}
        </>
      }
      actions={
        <>
          <button
            type="button"
            className={`${styles.button} ${styles.cancel}`}
            onClick={onCancel}
            data-testid="export-all-preflight-cancel"
          >
            {STRINGS.dataExchange.exportPreflightCancel}
          </button>
          <button
            ref={initialFocusRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={onConfirm}
            data-testid="export-all-preflight-confirm"
          >
            {STRINGS.dataExchange.exportPreflightConfirm}
          </button>
        </>
      }
    />
  );
}

export interface ProgressViewProps {
  phase: ProgressPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}

export function ProgressView(props: ProgressViewProps) {
  const { phase, dialogRef, initialFocusRef, onCancel } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="export-all-progress"
      titleId="export-all-progress-title"
      bodyId="export-all-progress-body"
      title={STRINGS.dataExchange.exportProgressTitle}
      body={
        <>
          <div
            className={styles.readoutLine}
            data-testid="export-all-progress-counter"
            data-files-total={phase.totalCount}
            data-files-done={phase.filesDone}
          >
            {STRINGS.dataExchange.exportProgressCounter(phase.filesDone, phase.totalCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="export-all-progress-bytes"
            data-bytes-total={phase.totalSizeBytes}
            data-bytes-done={phase.bytesDone}
          >
            {STRINGS.dataExchange.exportProgressBytes(
              formatBytes(phase.bytesDone),
              formatBytes(phase.totalSizeBytes),
            )}
          </div>
          <div className={styles.currentFile} data-testid="export-all-progress-current-file">
            {STRINGS.dataExchange.exportProgressCurrentFile(phase.currentFile || '—')}
          </div>
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onCancel}
          data-testid="export-all-cancel"
        >
          {STRINGS.dataExchange.exportCancel}
        </button>
      }
    />
  );
}

export interface SummaryViewProps {
  phase: SummaryPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function SummaryView(props: SummaryViewProps) {
  const { phase, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="export-all-summary"
      titleId="export-all-summary-title"
      bodyId="export-all-summary-body"
      title={STRINGS.dataExchange.exportSummaryTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="export-all-summary-filename">
            {STRINGS.dataExchange.exportSummaryFile(phase.filename)}
          </div>
          {phase.skippedCount > 0 && (
            <div className={styles.skippedLine} data-testid="export-all-summary-skipped">
              {STRINGS.dataExchange.exportSummarySkipped(phase.skippedCount)}
            </div>
          )}
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="export-all-summary-close"
        >
          {STRINGS.dataExchange.exportSummaryClose}
        </button>
      }
    />
  );
}

export interface ErrorViewProps {
  phase: ErrorPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function ErrorView(props: ErrorViewProps) {
  const { phase, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="export-all-error"
      titleId="export-all-error-title"
      bodyId="export-all-error-body"
      title={STRINGS.dataExchange.exportError}
      body={<div className={styles.readoutLine}>{phase.message}</div>}
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="export-all-error-close"
        >
          {STRINGS.dataExchange.exportSummaryClose}
        </button>
      }
    />
  );
}
