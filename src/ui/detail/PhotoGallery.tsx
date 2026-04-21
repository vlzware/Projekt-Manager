/**
 * Photo gallery — ready photos rendered via presigned-thumbnail URLs,
 * lightbox on click (original variant), lazy "Datei fehlt" placeholder
 * when a thumbnail or original 404s (spec §8.15.4, §8.15.7).
 *
 * List fetching and download-URL plumbing go through the attachment
 * store; this component is a thin renderer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import type { Attachment } from '@/domain/types';
import { canDeleteAttachment } from '@/domain/attachments';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import styles from './ProjectDetail.module.css';

interface PhotoGalleryProps {
  projectId: string;
}

export function PhotoGallery({ projectId }: PhotoGalleryProps) {
  // Select the raw per-project slice then filter in useMemo so the
  // selector output is referentially stable across renders — a new
  // filtered array each render confuses Zustand's snapshot cache and
  // triggers React's "getSnapshot should be cached" warning.
  const rows = useAttachmentStore((s) => s.byProject[projectId]);
  const photos = useMemo<Attachment[]>(
    () => (rows ?? []).filter((a) => a.status === 'ready' && a.kind === 'photo'),
    [rows],
  );
  const fetchForProject = useAttachmentStore((s) => s.fetchForProject);
  const requestDownloadUrl = useAttachmentStore((s) => s.requestDownloadUrl);
  const deleteAttachment = useAttachmentStore((s) => s.deleteAttachment);
  const authUser = useAuthStore((s) => s.authUser);

  const handleDelete = async (photo: Attachment) => {
    const ok = await useConfirmStore.getState().request(STRINGS.attachments.deleteConfirmMessage, {
      title: STRINGS.attachments.deleteConfirmTitle,
    });
    if (!ok) return;
    await deleteAttachment(projectId, photo.id);
  };

  // Thumbnail URL cache keyed by attachment id. `null` entry means a 404
  // was observed (lazy detection — spec §8.15.7) so the row flips to the
  // "Datei fehlt" placeholder.
  const [thumbUrls, setThumbUrls] = useState<Record<string, string | null>>({});
  const [lightbox, setLightbox] = useState<{ attachmentId: string; url: string } | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void fetchForProject(projectId);
  }, [fetchForProject, projectId]);

  useEffect(() => {
    // Request a thumbnail presigned URL for each ready photo once. A
    // subsequent list refetch that adds new rows triggers fresh fetches;
    // already-observed rows keep their cached URL (or their null missing-
    // file verdict, which is re-checked lazily on the next click).
    for (const p of photos) {
      if (loadedRef.current.has(p.id)) continue;
      loadedRef.current.add(p.id);
      void (async () => {
        const url = await requestDownloadUrl(projectId, p.id, 'thumbnail');
        setThumbUrls((prev) => ({ ...prev, [p.id]: url }));
      })();
    }
  }, [photos, projectId, requestDownloadUrl]);

  const handleOpenLightbox = async (photo: Attachment) => {
    const url = await requestDownloadUrl(projectId, photo.id, 'original');
    if (!url) {
      // A missing original flips the row to the placeholder, same as a
      // thumbnail 404.
      setThumbUrls((prev) => ({ ...prev, [photo.id]: null }));
      return;
    }
    setLightbox({ attachmentId: photo.id, url });
  };

  const handleImgError = (photoId: string) => {
    // Treat an <img> error event the same as a 404 — the backing object
    // was there at URL-request time but the provider refused the GET.
    setThumbUrls((prev) => ({ ...prev, [photoId]: null }));
  };

  return (
    <section
      aria-label={STRINGS.attachments.photoGallery}
      data-testid="project-detail-photos"
      className={styles.photoSection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.photoGallery}</h3>
      {photos.length === 0 ? (
        <div className={styles.emptyState}>{STRINGS.ui.noResults}</div>
      ) : (
        <ul className={styles.photoGrid}>
          {photos.map((photo) => {
            const url = thumbUrls[photo.id];
            const missing = url === null;
            if (missing) {
              return (
                <li
                  key={photo.id}
                  className={styles.photoMissing}
                  data-testid={`photo-missing-${photo.id}`}
                >
                  {STRINGS.attachments.fileMissing}
                </li>
              );
            }
            const canDelete =
              authUser !== null &&
              canDeleteAttachment(photo, authUser, ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes);
            return (
              <li key={photo.id} className={styles.photoItem} data-testid="attachment-thumbnail">
                <button
                  type="button"
                  className={styles.photoThumb}
                  data-testid={`photo-thumb-${photo.id}`}
                  onClick={() => void handleOpenLightbox(photo)}
                >
                  {url ? (
                    <img src={url} alt={photo.fileName} onError={() => handleImgError(photo.id)} />
                  ) : (
                    <span className={styles.photoLoading}>{STRINGS.ui.loading}</span>
                  )}
                </button>
                {canDelete && (
                  <button
                    type="button"
                    data-testid="attachment-delete"
                    className={styles.deleteButton}
                    onClick={() => void handleDelete(photo)}
                    aria-label={STRINGS.ui.delete}
                  >
                    {STRINGS.ui.delete}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {lightbox && (
        <div
          className={styles.lightbox}
          data-testid="photo-lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label={STRINGS.attachments.photoGallery}
        >
          <img src={lightbox.url} alt="" />
        </div>
      )}
    </section>
  );
}
