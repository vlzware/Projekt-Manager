/**
 * Photo gallery — ready photos rendered via presigned-thumbnail URLs,
 * lightbox on click (original variant), lazy "Datei fehlt" placeholder
 * when a thumbnail or original 404s (spec §8.15.4, §8.15.7).
 *
 * List fetching and download-URL plumbing go through the attachment
 * store; this component is a thin renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import type { Attachment } from '@/domain/types';
import { canDeleteAttachment } from '@/domain/attachments';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import { formatDateDE } from '@/domain/dateFormat';
import styles from './ProjectDetail.module.css';

interface PhotoGalleryProps {
  projectId: string;
  /** Archived project — suppresses the per-row delete control. */
  archived?: boolean;
}

export function PhotoGallery({ projectId, archived = false }: PhotoGalleryProps) {
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
  const hideAttachment = useAttachmentStore((s) => s.hideAttachment);
  const authUser = useAuthStore((s) => s.authUser);

  const handleDelete = async (photo: Attachment) => {
    const ok = await useConfirmStore.getState().request(STRINGS.attachments.deleteConfirmMessage, {
      title: STRINGS.attachments.deleteConfirmTitle,
    });
    if (!ok) return;
    await hideAttachment(projectId, photo.id);
  };

  // Thumbnail URL cache keyed by attachment id. `null` entry means a 404
  // was observed (lazy detection — spec §8.15.7) so the row flips to the
  // "Datei fehlt" placeholder.
  const [thumbUrls, setThumbUrls] = useState<Record<string, string | null>>({});
  const [lightbox, setLightbox] = useState<{ attachmentId: string; url: string } | null>(null);
  // Focus-restore target: the thumbnail button that opened the lightbox.
  // Captured at open-time; restored when the lightbox closes so keyboard
  // users don't get dropped at document root.
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void fetchForProject(projectId);
  }, [fetchForProject, projectId]);

  useEffect(() => {
    // Request a thumbnail presigned URL for each ready photo that does
    // not already have a working URL cached. Rows with a `null` verdict
    // (previously observed missing) are re-attempted on the next effect
    // run — spec §8.15.7 forbids caching the missing verdict, so a list
    // refetch that re-emits the same row must re-probe storage. HTTP-
    // layer caching absorbs the cost for thumbnails that still exist.
    for (const p of photos) {
      if (thumbUrls[p.id]) continue;
      void (async () => {
        const url = await requestDownloadUrl(projectId, p.id, 'thumbnail');
        setThumbUrls((prev) => ({ ...prev, [p.id]: url }));
      })();
    }
    // `thumbUrls` is intentionally omitted from the dep array: including
    // it would re-run the effect after each per-row setState and fire
    // parallel fetches for still-pending rows. The effect's trigger is
    // `photos` changing (list refetch), which is the spec's re-observe
    // point; within a single run, the local `thumbUrls` read above
    // prevents duplicate work for rows whose URL is already cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, projectId, requestDownloadUrl]);

  const handleOpenLightbox = async (
    photo: Attachment,
    trigger: HTMLElement | null,
  ): Promise<void> => {
    const url = await requestDownloadUrl(projectId, photo.id, 'original');
    if (!url) {
      // A missing original flips the row to the placeholder, same as a
      // thumbnail 404.
      setThumbUrls((prev) => ({ ...prev, [photo.id]: null }));
      return;
    }
    // Capture the trigger so focus can return on close.
    lightboxOpenerRef.current = trigger;
    setLightbox({ attachmentId: photo.id, url });
  };

  const handleImgError = (photoId: string) => {
    // Treat an <img> error event the same as a 404 — the backing object
    // was there at URL-request time but the provider refused the GET.
    setThumbUrls((prev) => ({ ...prev, [photoId]: null }));
  };

  const closeLightbox = useCallback((): void => {
    setLightbox(null);
  }, []);

  // Esc-to-close + focus management. Document-level key listener is
  // installed only while the lightbox is open, avoiding background
  // interference with the rest of the page (form inputs, etc.).
  useEffect(() => {
    if (!lightbox) {
      // Restore focus to the trigger on close.
      const opener = lightboxOpenerRef.current;
      if (opener && typeof opener.focus === 'function') {
        opener.focus();
      }
      lightboxOpenerRef.current = null;
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
      }
    };
    document.addEventListener('keydown', onKey);
    // Pull focus into the dialog so Tab and screen-reader cursors stay
    // inside the modal surface.
    lightboxRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [lightbox, closeLightbox]);

  /**
   * Accessible label for the thumbnail button. AC-image is the filename,
   * which is noise for screen-reader users. Prefer the date (human-readable)
   * and fall back to the German label; the filename is suppressed.
   */
  const thumbButtonLabel = (photo: Attachment): string => {
    const dateText = formatDateDE(photo.createdAt);
    return `${STRINGS.attachments.photoGallery} — ${dateText}`;
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
              !archived &&
              canDeleteAttachment(photo, authUser, ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes);
            return (
              <li key={photo.id} className={styles.photoItem} data-testid="attachment-thumbnail">
                <button
                  type="button"
                  className={styles.photoThumb}
                  data-testid={`photo-thumb-${photo.id}`}
                  aria-label={thumbButtonLabel(photo)}
                  onClick={(e) => void handleOpenLightbox(photo, e.currentTarget as HTMLElement)}
                >
                  {url ? (
                    // alt="" because the button's aria-label carries the
                    // accessible name; a non-empty alt would double-announce.
                    <img src={url} alt="" onError={() => handleImgError(photo.id)} />
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
          ref={lightboxRef}
          className={styles.lightbox}
          data-testid="photo-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={STRINGS.attachments.photoGallery}
          // Negative-tab-index makes the container programmatically
          // focusable so the open-effect can pull focus inside; Tab
          // cycles through the close button and wraps within the container.
          tabIndex={-1}
        >
          <button
            type="button"
            className={styles.previewClose}
            onClick={closeLightbox}
            aria-label={STRINGS.ui.close}
            data-testid="photo-lightbox-close"
          >
            ×
          </button>
          <img src={lightbox.url} alt="" />
        </div>
      )}
    </section>
  );
}
