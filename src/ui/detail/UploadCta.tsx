/**
 * Upload CTA — file picker + closed-enum label dropdown + per-attempt
 * failure banner with "Erneut versuchen" (spec §8.15.4, §8.15.8).
 *
 * The store owns upload orchestration; this component dispatches
 * `uploadFile` on pick and `retryUpload` on the banner action. No silent
 * retry (AC-225) — retry only fires when the user clicks the action.
 */

import { useMemo, useState } from 'react';
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
  const dismissUpload = useAttachmentStore((s) => s.dismissUpload);

  const [label, setLabel] = useState<AttachmentLabel>('foto');
  // Client ids whose banner has been acknowledged via "Erneut versuchen".
  // Once the user retried, the banner stays suppressed for that upload —
  // the retry is a deliberate action (spec §8.15.8 — no silent retry) and
  // a subsequent failure banner on the retry's own failure would clobber
  // the in-flight indicator the user is watching. A dismiss or successful
  // completion drops the pending row so the ack never needs an explicit
  // sweep — we intersect with live `pendingUploads` on read instead.
  const [ackedClientIds, setAckedClientIds] = useState<Set<string>>(new Set());

  const myPending = useMemo(() => {
    return Object.values(pendingUploads).filter((p) => p.projectId === projectId);
  }, [pendingUploads, projectId]);

  const failed = myPending.find((p) => p.status === 'failed' && !ackedClientIds.has(p.clientId));

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const pickedLabel = mimeIsPhoto(file.type) ? label : defaultLabelFor(file.type);
    void uploadFile(projectId, file, {
      label: pickedLabel,
      hasThumbnail: mimeIsPhoto(file.type),
    });
    e.target.value = '';
  };

  const handleRetry = () => {
    if (!failed) return;
    setAckedClientIds((prev) => {
      const next = new Set(prev);
      next.add(failed.clientId);
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

      <div className={styles.uploadControls}>
        <label className={styles.fileLabel}>
          {STRINGS.attachments.uploadPickPhoto}
          <input
            type="file"
            data-testid="attachment-photo-input"
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

      {myPending
        .filter((p) => p.status !== 'failed')
        .map((p) => (
          <div key={p.clientId} className={styles.progressRow}>
            {progressLabel(p.status)} — {p.fileName}
          </div>
        ))}

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
