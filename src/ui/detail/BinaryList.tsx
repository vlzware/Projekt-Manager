/**
 * Binary list — tabular view of ready non-photo attachments with
 * download, bulk-select (client-side cap enforcement), and the "Datei
 * fehlt" placeholder on download 404 (spec §8.15.5 and §8.15.7).
 *
 * Bulk-download caps live in `attachmentPipeline.ts` [C]; violation
 * produces a client-side message naming both caps (file count AND
 * summed bytes) per AC-223.
 */

import { useEffect, useMemo, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { ATTACHMENT_LABELS, canDeleteAttachment } from '@/domain/attachments';
import type { Attachment, AttachmentLabel, User } from '@/domain/types';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useUserStore } from '@/state/userStore';
import { formatDateDE } from '@/domain/dateFormat';
import styles from './ProjectDetail.module.css';

interface BinaryListProps {
  projectId: string;
}

const LABEL_BY_VALUE = new Map<AttachmentLabel, string>(
  ATTACHMENT_LABELS.map((l) => [l.value, l.label]),
);

/**
 * Programmatically trigger a browser download for a remote URL using a
 * transient `<a download>` anchor. Shared by the single-file and bulk
 * paths so both use the same user-gesture-friendly approach.
 */
function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function BinaryList({ projectId }: BinaryListProps) {
  // Select the raw per-project slice then filter in useMemo so the
  // selector output is referentially stable across renders.
  const rows = useAttachmentStore((s) => s.byProject[projectId]);
  const binaries = useMemo<Attachment[]>(
    () => (rows ?? []).filter((a) => a.status === 'ready' && a.kind === 'binary'),
    [rows],
  );
  const fetchForProject = useAttachmentStore((s) => s.fetchForProject);
  const requestDownloadUrl = useAttachmentStore((s) => s.requestDownloadUrl);
  const requestBulkDownloadUrl = useAttachmentStore((s) => s.requestBulkDownloadUrl);
  const deleteAttachment = useAttachmentStore((s) => s.deleteAttachment);
  const authUser = useAuthStore((s) => s.authUser);

  const handleDelete = async (bin: Attachment) => {
    const ok = await useConfirmStore.getState().request(STRINGS.attachments.deleteConfirmMessage, {
      title: STRINGS.attachments.deleteConfirmTitle,
    });
    if (!ok) return;
    await deleteAttachment(projectId, bin.id);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [capError, setCapError] = useState<string | null>(null);
  const users = useUserStore((s) => s.users);
  const fetchUsers = useUserStore((s) => s.fetchUsers);

  useEffect(() => {
    void fetchForProject(projectId);
  }, [fetchForProject, projectId]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const userById = useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  // Intersect the user's `selected` set with rows that are still
  // eligible (present + not missing). Derived on render so the set
  // never disagrees with the live table; a pure useMemo avoids the
  // setState-in-effect cascade the linter guards against.
  const effectiveSelected = useMemo(() => {
    const next = new Set<string>();
    for (const id of selected) {
      if (binaries.some((b) => b.id === id) && !missing.has(id)) next.add(id);
    }
    return next;
  }, [selected, binaries, missing]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableIds = binaries.filter((b) => !missing.has(b.id)).map((b) => b.id);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => effectiveSelected.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  };

  const handleDownload = async (attachmentId: string) => {
    const url = await requestDownloadUrl(projectId, attachmentId, 'original');
    if (!url) {
      setMissing((prev) => new Set(prev).add(attachmentId));
      return;
    }
    // Cross-origin downloads rely on the storage backend to send
    // `Content-Disposition: attachment` — the server does so (see
    // `storage/client.ts`). The `<a download>` attribute is a UX hint:
    // on same-origin it forces the download event; on cross-origin it
    // is advisory and acts primarily as a filename fallback when the
    // browser honours it. Either way, the server's header is the
    // authoritative source for attachment semantics.
    const row = binaries.find((b) => b.id === attachmentId);
    triggerDownload(url, row?.fileName ?? '');
  };

  const handleBulkDownload = async () => {
    const ids = Array.from(effectiveSelected);
    const selectedRows = binaries.filter((b) => ids.includes(b.id));
    const totalBytes = selectedRows.reduce((acc, r) => acc + r.sizeBytes, 0);
    const { bulkDownloadMaxFiles, bulkDownloadMaxBytes } = ATTACHMENT_PIPELINE;
    if (ids.length > bulkDownloadMaxFiles || totalBytes > bulkDownloadMaxBytes) {
      setCapError(
        STRINGS.attachments.bulkLimitExceeded(
          bulkDownloadMaxFiles,
          Math.round(bulkDownloadMaxBytes / (1024 * 1024)),
        ),
      );
      return;
    }
    setCapError(null);
    const url = await requestBulkDownloadUrl(projectId, ids);
    // Use the same `<a download>` pattern as the single-file path rather
    // than `window.open` — popup blockers treat post-`await` opens as
    // programmatic and frequently reject them. The anchor click is a
    // direct user-gesture continuation that browsers let through.
    if (url) triggerDownload(url, STRINGS.attachments.bulkZipFileName);
  };

  return (
    <section
      aria-label={STRINGS.attachments.binaryList}
      data-testid="project-detail-binaries"
      className={styles.binarySection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.binaryList}</h3>

      {capError && (
        <div className={styles.errorBanner} data-testid="binary-bulk-limit-error">
          {capError}
        </div>
      )}

      {binaries.length === 0 ? (
        <div className={styles.emptyState}>{STRINGS.ui.noResults}</div>
      ) : (
        <>
          <table className={styles.binaryTable}>
            <thead>
              <tr>
                <th>
                  <label>
                    <input
                      type="checkbox"
                      data-testid="binary-select-all"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label={STRINGS.attachments.selectAll}
                    />
                  </label>
                </th>
                <th>{STRINGS.attachments.colFileName}</th>
                <th>{STRINGS.attachments.colLabel}</th>
                <th>{STRINGS.attachments.colUploader}</th>
                <th>{STRINGS.attachments.colUploaded}</th>
                <th>{STRINGS.ui.actions}</th>
              </tr>
            </thead>
            <tbody>
              {binaries.map((bin) => {
                const isMissing = missing.has(bin.id);
                const uploader = bin.createdBy ? userById.get(bin.createdBy)?.displayName : null;
                const canDelete =
                  authUser !== null &&
                  canDeleteAttachment(
                    bin,
                    authUser,
                    ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes,
                  );
                return (
                  <tr
                    key={bin.id}
                    data-testid={`attachment-binary-row-${bin.id}`}
                    data-attachment-id={bin.id}
                  >
                    <td>
                      {isMissing ? (
                        <input
                          type="checkbox"
                          data-testid={`binary-select-${bin.id}`}
                          disabled
                          aria-label={bin.fileName}
                        />
                      ) : (
                        <input
                          type="checkbox"
                          data-testid={`binary-select-${bin.id}`}
                          checked={effectiveSelected.has(bin.id)}
                          onChange={() => toggleSelect(bin.id)}
                          aria-label={bin.fileName}
                        />
                      )}
                    </td>
                    <td>{bin.fileName}</td>
                    <td>{LABEL_BY_VALUE.get(bin.label) ?? bin.label}</td>
                    <td>{uploader ?? bin.createdBy ?? ''}</td>
                    <td>{formatDateDE(bin.createdAt)}</td>
                    <td>
                      {isMissing && (
                        <span
                          className={styles.missingBadge}
                          data-testid={`binary-missing-${bin.id}`}
                        >
                          {STRINGS.attachments.fileMissing}
                        </span>
                      )}
                      <button
                        type="button"
                        className={styles.downloadButton}
                        data-testid="attachment-download"
                        disabled={isMissing}
                        onClick={() => void handleDownload(bin.id)}
                      >
                        {STRINGS.attachments.download}
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          className={styles.deleteButton}
                          data-testid="attachment-delete"
                          onClick={() => void handleDelete(bin)}
                          aria-label={STRINGS.ui.delete}
                        >
                          {STRINGS.ui.delete}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {effectiveSelected.size > 0 && (
            <button
              type="button"
              className={styles.bulkDownloadButton}
              data-testid="binary-bulk-download"
              onClick={() => void handleBulkDownload()}
            >
              {STRINGS.attachments.bulkDownload}
            </button>
          )}
        </>
      )}
    </section>
  );
}
