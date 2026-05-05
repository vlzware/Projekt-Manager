/**
 * Phase-specific render branches for `VollstaendigerImportDialog`.
 *
 * Mirrors `VollstaendigerExportDialog.views.tsx` — extracted to keep
 * the dialog file under the C-SIZE ceiling. Each phase view renders
 * the shared `DialogShell` with its phase-specific body and actions.
 */

import { type ReactNode, type RefObject, type ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { RESTORE_CONFIRMATION_PHRASE } from '@/config/dataExchangeConfig';
import type { PreflightPhase, ProgressPhase, SummaryPhase, ErrorPhase } from './useImportAllRunner';
import styles from './VollstaendigerImportDialog.module.css';

/** Decimal-SI byte count formatter. Matches the export-side dialog. */
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

function DialogShell(props: DialogShellProps) {
  const { dialogRef, testId, titleId, bodyId, title, body, actions } = props;
  return (
    <div className={styles.overlay} data-testid="import-all-overlay">
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

export interface AwaitingFileViewProps {
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
  onCancel: () => void;
}

export function AwaitingFileView(props: AwaitingFileViewProps) {
  const { dialogRef, initialFocusRef, onFile, onCancel } = props;
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  };
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-awaiting-file"
      titleId="import-all-awaiting-file-title"
      bodyId="import-all-awaiting-file-body"
      title={STRINGS.dataExchange.importAllPreflightTitle}
      body={
        <>
          <div className={styles.readoutLine}>{STRINGS.dataExchange.importAllPickFile}</div>
          <input
            ref={initialFocusRef}
            type="file"
            accept=".zip,application/zip"
            onChange={handleChange}
            className={styles.fileInput}
            data-testid="import-all-file-input"
          />
        </>
      }
      actions={
        <button
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onCancel}
          data-testid="import-all-awaiting-cancel"
        >
          {STRINGS.dataExchange.importAllPreflightCancel}
        </button>
      }
    />
  );
}

export interface PreflightViewProps {
  phase: PreflightPhase;
  isMobile: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  phraseInput: string;
  onPhraseInputChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreflightView(props: PreflightViewProps) {
  const {
    phase,
    isMobile,
    dialogRef,
    initialFocusRef,
    phraseInput,
    onPhraseInputChange,
    onCancel,
    onConfirm,
  } = props;
  const customers = (phase.envelope.customers ?? []).length;
  const projects = (phase.envelope.projects ?? []).length;
  const assignments = (phase.envelope.project_workers ?? []).length;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-preflight"
      titleId="import-all-preflight-title"
      bodyId="import-all-preflight-body"
      title={STRINGS.dataExchange.importAllPreflightTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="import-all-preflight-customer-count">
            {STRINGS.dataExchange.importAllPreflightCustomers(customers)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-project-count">
            {STRINGS.dataExchange.importAllPreflightProjects(projects)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-assignment-count">
            {STRINGS.dataExchange.importAllPreflightAssignments(assignments)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-attachment-count">
            {STRINGS.dataExchange.importAllPreflightAttachmentCount(phase.attachmentCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="import-all-preflight-size"
            data-bytes-total={phase.totalBytes}
          >
            {STRINGS.dataExchange.importAllPreflightSize(formatBytes(phase.totalBytes))}
          </div>
          {phase.targetNonEmpty && (
            <>
              <div
                className={styles.destructiveNotice}
                data-testid="import-all-preflight-destructive-notice"
                role="note"
              >
                {STRINGS.dataExchange.restoreDestructiveNotice}
              </div>
              <label className={styles.readoutLine} htmlFor="import-all-phrase-input">
                {STRINGS.dataExchange.restorePhrasePrompt(RESTORE_CONFIRMATION_PHRASE)}
              </label>
              <input
                id="import-all-phrase-input"
                type="text"
                className={styles.phraseInput}
                value={phraseInput}
                onChange={(e) => onPhraseInputChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="import-all-phrase-input"
              />
            </>
          )}
          {isMobile && (
            <div
              className={styles.mobileWarning}
              data-testid="import-all-preflight-mobile-warning"
              role="note"
            >
              {STRINGS.dataExchange.importAllMobileWarning}
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
            data-testid="import-all-preflight-cancel"
          >
            {STRINGS.dataExchange.importAllPreflightCancel}
          </button>
          <button
            ref={initialFocusRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={onConfirm}
            data-testid="import-all-preflight-confirm"
          >
            {STRINGS.dataExchange.importAllPreflightConfirm}
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
      testId="import-all-progress"
      titleId="import-all-progress-title"
      bodyId="import-all-progress-body"
      title={STRINGS.dataExchange.importAllProgressTitle}
      body={
        <>
          <div
            className={styles.readoutLine}
            data-testid="import-all-progress-counter"
            data-files-total={phase.totalCount}
            data-files-done={phase.filesDone}
          >
            {STRINGS.dataExchange.importAllProgressCounter(phase.filesDone, phase.totalCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="import-all-progress-bytes"
            data-bytes-total={phase.totalSizeBytes}
            data-bytes-done={phase.bytesDone}
          >
            {STRINGS.dataExchange.importAllProgressBytes(
              formatBytes(phase.bytesDone),
              formatBytes(phase.totalSizeBytes),
            )}
          </div>
          <div className={styles.currentFile} data-testid="import-all-progress-current-file">
            {STRINGS.dataExchange.importAllProgressCurrentFile(phase.currentFile || '—')}
          </div>
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onCancel}
          data-testid="import-all-cancel"
        >
          {STRINGS.dataExchange.importAllCancel}
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
      testId="import-all-summary"
      titleId="import-all-summary-title"
      bodyId="import-all-summary-body"
      title={STRINGS.dataExchange.importAllSummaryTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="import-all-summary-committed">
            {STRINGS.dataExchange.importAllSummaryCommitted(phase.committedCount)}
          </div>
          {phase.failures.length > 0 && (
            <>
              <div className={styles.skippedLine} data-testid="import-all-summary-skipped">
                {STRINGS.dataExchange.importAllSummarySkipped(phase.failures.length)}
              </div>
              <ul className={styles.failureList} data-testid="import-all-summary-failures">
                {phase.failures.map((f) => (
                  <li key={f.attachmentId}>
                    <code>{f.zipPath || f.attachmentId}</code>: {f.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-all-summary-close"
        >
          {STRINGS.dataExchange.importAllSummaryClose}
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
      testId="import-all-error"
      titleId="import-all-error-title"
      bodyId="import-all-error-body"
      title={STRINGS.dataExchange.importAllError}
      body={<div className={styles.readoutLine}>{phase.message}</div>}
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-all-error-close"
        >
          {STRINGS.dataExchange.importAllSummaryClose}
        </button>
      }
    />
  );
}
