/**
 * Upload CTA — file picker + closed-enum label dropdown + per-attempt
 * failure banner with "Erneut versuchen" (spec §8.15.4, §8.15.8).
 *
 * The store owns upload orchestration; this component dispatches
 * `uploadFile` on pick and `retryUpload` on the banner action. No silent
 * retry (AC-225) — retry only fires when the user clicks the action.
 */

import { useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_LABELS, ATTACHMENT_MIME_WHITELIST } from '@/domain/attachments';
import type { AttachmentLabel } from '@/domain/types';
import { useAttachmentStore } from '@/state/attachmentStore';
import styles from './ProjectDetail.module.css';

interface UploadCtaProps {
  projectId: string;
}

const PHOTO_MIME_ACCEPT = ATTACHMENT_MIME_WHITELIST.filter((m) => m.startsWith('image/')).join(',');
const BINARY_MIME_ACCEPT = ATTACHMENT_MIME_WHITELIST.filter((m) => !m.startsWith('image/')).join(
  ',',
);

function mimeIsPhoto(mime: string): boolean {
  return mime.startsWith('image/');
}

function defaultLabelFor(mime: string): AttachmentLabel {
  return mimeIsPhoto(mime) ? 'foto' : 'sonstiges';
}

export function UploadCta({ projectId }: UploadCtaProps) {
  const pendingUploads = useAttachmentStore((s) => s.pendingUploads);
  const uploadFile = useAttachmentStore((s) => s.uploadFile);
  const retryUpload = useAttachmentStore((s) => s.retryUpload);
  // `dismissUpload` already aborts the transport. Calling it from the
  // banner's dismiss is the explicit-dismiss path required by the
  // AbortController contract.
  const dismissUpload = useAttachmentStore((s) => s.dismissUpload);

  const [label, setLabel] = useState<AttachmentLabel>('foto');
  // Drag-drop visual state. Simple boolean — the drop handler resolves
  // the MIME whitelist against the dropped file, so we don't need to
  // disable the zone per drag item. The counter guards against
  // nested-dragenter/leave thrashing (a drag that enters a child fires
  // a second enter before the parent gets its leave).
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  // Client ids whose banner has been acknowledged while the retry is
  // in flight. The ack suppresses the "previous failure" banner during
  // the brief window between user-clicks-retry and the retry attempt
  // reaching its next terminal state. It is dropped again the moment
  // retry is dispatched (see `handleRetry`) so a second failure
  // re-surfaces the banner — the previous behaviour of a permanent ack
  // silently swallowed repeated failures.
  const [ackedClientIds, setAckedClientIds] = useState<Set<string>>(new Set());
  // Validation banner — set when the user picks / drops an unsupported
  // MIME (e.g., HEIC from an iPhone camera roll). The banner names the
  // supported set so the user knows how to proceed. Cleared on a fresh
  // pick or via explicit dismiss.
  const [validationError, setValidationError] = useState<string | null>(null);

  const myPending = useMemo(() => {
    return Object.values(pendingUploads).filter((p) => p.projectId === projectId);
  }, [pendingUploads, projectId]);

  const failed = myPending.find((p) => p.status === 'failed' && !ackedClientIds.has(p.clientId));

  const isAllowedMime = (mime: string): boolean =>
    (ATTACHMENT_MIME_WHITELIST as readonly string[]).includes(mime);

  const dispatchUpload = (file: File): void => {
    if (!isAllowedMime(file.type)) {
      // Server enforces the same whitelist, but the UX goal is to tell
      // the user *before* a round-trip why their file was refused — in
      // particular HEIC needs an explicit nudge since iPhone cameras
      // save HEIC by default and the user may not know.
      setValidationError(STRINGS.attachments.uploadMimeNotAllowed);
      return;
    }
    setValidationError(null);
    const pickedLabel = mimeIsPhoto(file.type) ? label : defaultLabelFor(file.type);
    void uploadFile(projectId, file, {
      label: pickedLabel,
      hasThumbnail: mimeIsPhoto(file.type),
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    dispatchUpload(file);
    e.target.value = '';
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // `preventDefault` on dragover is required for the subsequent drop
    // event to fire. Without it the browser rejects the drop.
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    // Let `dispatchUpload` handle MIME validation so the drag-drop path
    // and the picker path surface the same German banner instead of
    // silently swallowing unsupported files.
    dispatchUpload(file);
  };

  const handleRetry = () => {
    if (!failed) return;
    // Drop any stale ack for this clientId so a second failure on the
    // retried attempt re-surfaces the banner. Without this, `ackedClientIds`
    // would swallow repeated failures silently.
    setAckedClientIds((prev) => {
      if (!prev.has(failed.clientId)) return prev;
      const next = new Set(prev);
      next.delete(failed.clientId);
      return next;
    });
    void retryUpload(failed.clientId);
  };

  const handleDismiss = () => {
    if (failed) dismissUpload(failed.clientId);
  };

  const bannerMessage = failed?.errorMessage ?? null;

  return (
    <section
      aria-label={STRINGS.attachments.upload}
      data-testid="project-detail-upload-cta"
      className={styles.uploadSection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.upload}</h3>

      <div
        className={`${styles.uploadDropZone}${dragActive ? ' ' + styles.uploadDropZoneActive : ''}`}
        data-testid="upload-drop-zone"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className={styles.uploadDropHint}>{STRINGS.attachments.uploadDrop}</p>
        <div className={styles.uploadControls}>
          <label className={styles.fileLabel}>
            {STRINGS.attachments.uploadPickPhoto}
            <input
              type="file"
              data-testid="attachment-photo-input"
              accept={PHOTO_MIME_ACCEPT}
              onChange={handleFileChange}
              className={styles.fileInput}
            />
          </label>

          {/* Camera-capture affordance (spec §8.15.4). `capture="environment"`
              is a browser hint to prefer the rear camera on mobile. On desktop
              the browser ignores the attribute and the control degrades to a
              plain file picker — acceptable per spec. */}
          <label className={styles.fileLabel}>
            {STRINGS.attachments.takePhoto}
            <input
              type="file"
              data-testid="attachment-photo-capture"
              accept={PHOTO_MIME_ACCEPT}
              capture="environment"
              onChange={handleFileChange}
              className={styles.fileInput}
            />
          </label>

          <label className={styles.fileLabel}>
            {STRINGS.attachments.uploadPickBinary}
            <input
              type="file"
              data-testid="attachment-binary-input"
              accept={BINARY_MIME_ACCEPT}
              onChange={handleFileChange}
              className={styles.fileInput}
            />
          </label>

          <label className={styles.labelWrapper}>
            <span>{STRINGS.attachments.uploadLabel}</span>
            <select
              data-testid="upload-label-select"
              value={label}
              onChange={(e) => setLabel(e.target.value as AttachmentLabel)}
              className={styles.labelSelect}
            >
              {ATTACHMENT_LABELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* ARIA live region — status transitions (Vorbereiten → Hochladen → …)
          are announced to screen-reader users as they happen. `polite`
          waits for the user to pause; `role="status"` is a shortcut for
          `aria-live="polite"` with a status landmark. Both are set to
          keep older AT that doesn't map one to the other happy. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="upload-progress-region"
        className={styles.progressRegion}
      >
        {myPending
          .filter((p) => p.status !== 'failed')
          .map((p) => (
            <div key={p.clientId} className={styles.progressRow}>
              {progressLabel(p.status)} — {p.fileName}
            </div>
          ))}
      </div>

      {validationError && (
        <div className={styles.errorBanner} data-testid="upload-validation-banner" role="alert">
          <span>{validationError}</span>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={() => setValidationError(null)}
            aria-label={STRINGS.attachments.uploadDismiss}
          >
            ×
          </button>
        </div>
      )}

      {bannerMessage && (
        <div className={styles.errorBanner} data-testid="upload-error-banner" role="alert">
          <span>{bannerMessage}</span>
          <button
            type="button"
            className={styles.retryButton}
            data-testid="upload-retry"
            onClick={handleRetry}
          >
            {STRINGS.attachments.uploadRetry}
          </button>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label={STRINGS.attachments.uploadDismiss}
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

function progressLabel(status: 'initializing' | 'uploading' | 'completing' | 'failed'): string {
  switch (status) {
    case 'initializing':
      return STRINGS.attachments.uploadProgressInit;
    case 'uploading':
      return STRINGS.attachments.uploadProgressUpload;
    case 'completing':
      return STRINGS.attachments.uploadProgressComplete;
    default:
      return '';
  }
}
