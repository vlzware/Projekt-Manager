/**
 * Attachment state — per-project list cache, pending-upload tracking,
 * and orchestration of the client-side upload pipeline.
 *
 * Surface (ui/project-detail.md §8.15):
 *   - `byProject[projectId]` caches the `status = 'ready'` list the
 *     gallery and binary list render from.
 *   - `pendingUploads[clientId]` tracks in-flight or failed uploads so
 *     the UI can show per-row progress + the failure banner + retry.
 *   - `error` carries the last mutation error as a German string so
 *     the page shell can surface it via the project-level banner
 *     (behavior.md §9.5).
 *
 * Upload orchestration (`uploadFile` + `retryUpload`) runs the full
 * happy-path: pipeline → init → POST original → POST thumbnail →
 * complete → refetch. Any failure marks the pending row `failed` with
 * a German message — the UI reads that state to render the banner.
 * Retries are always deliberate user actions (spec §8.15.8: "No
 * silent retry").
 */

import { create } from 'zustand';
import { attachmentApi, type PresignedPost } from '@/api/client';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import { runImagePipeline } from '@/domain/imagePipeline';
import { handleSessionExpired } from './sessionExpired';

export interface PendingUpload {
  clientId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  status: 'initializing' | 'uploading' | 'completing' | 'failed';
  attachmentId: string | null;
  progress: number;
  errorMessage: string | null;
}

interface AttachmentState {
  byProject: Record<string, Attachment[]>;
  pendingUploads: Record<string, PendingUpload>;
  error: string | null;

  fetchForProject: (projectId: string) => Promise<void>;
  uploadFile: (
    projectId: string,
    file: File,
    input: { label: AttachmentLabel; hasThumbnail: boolean },
  ) => Promise<void>;
  retryUpload: (clientId: string) => Promise<void>;
  dismissUpload: (clientId: string) => void;
  deleteAttachment: (projectId: string, attachmentId: string) => Promise<void>;
  requestDownloadUrl: (
    projectId: string,
    attachmentId: string,
    variant: 'original' | 'thumbnail',
  ) => Promise<string | null>;
  requestBulkDownloadUrl: (projectId: string, attachmentIds: string[]) => Promise<string | null>;
  clearError: () => void;
}

/**
 * Side-map from `clientId` → the original `File` object and the
 * thumbnail flag. Kept out of Zustand state because `File` is not
 * serialisable and the store must survive being JSON-stringified in
 * devtools / persistence adapters.
 *
 * Lifecycle: populated on `uploadFile`; cleared on successful complete
 * or `dismissUpload`. A page reload drops the map entirely, so
 * `retryUpload` without a backing file cannot resume — that's the
 * spec's expected behaviour ("A page reload cancels an in-flight
 * upload cleanly" — ui/project-detail.md §8.15.4).
 */
interface PendingFileSlot {
  file: File;
  hasThumbnail: boolean;
}
const FILES_BY_CLIENT_ID = new Map<string, PendingFileSlot>();

/**
 * Generate a client-side id for a new upload. `crypto.randomUUID()` is
 * available in every modern browser and Node 20+. Falls back to a
 * Math.random-based id only to survive legacy test harnesses.
 */
function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'upload-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * POST a blob to object storage using the presigned-POST descriptor.
 * The standard S3 / MinIO POST form echoes each `fields` entry and
 * then the file itself. A non-2xx response is surfaced as a failure
 * so the caller marks the pending row `failed`.
 */
async function postPresignedForm(
  descriptor: PresignedPost,
  blob: Blob,
  fileName: string,
): Promise<{ ok: boolean; status: number }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(descriptor.fields)) {
    form.append(k, v);
  }
  // S3 form-upload contract: `file` must be the LAST field.
  form.append('file', blob, fileName);
  try {
    const res = await fetch(descriptor.url, { method: 'POST', body: form });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export const useAttachmentStore = create<AttachmentState>((set, get) => {
  // Helpers that close over `set` / `get` — defined inside the factory
  // so the zustand API is still exposed as a plain object of actions.

  function updatePending(clientId: string, patch: Partial<PendingUpload>): void {
    set((s) => {
      const current = s.pendingUploads[clientId];
      if (!current) return s;
      return {
        pendingUploads: {
          ...s.pendingUploads,
          [clientId]: { ...current, ...patch },
        },
      };
    });
  }

  function markFailed(clientId: string, message: string): void {
    updatePending(clientId, { status: 'failed', errorMessage: message });
  }

  function removePending(clientId: string): void {
    set((s) => {
      const { [clientId]: _removed, ...rest } = s.pendingUploads;
      return { pendingUploads: rest };
    });
    FILES_BY_CLIENT_ID.delete(clientId);
  }

  /**
   * Core upload orchestration — shared by `uploadFile` (fresh) and
   * `retryUpload` (same `clientId`, fresh run-through).
   */
  async function runUpload(clientId: string, projectId: string): Promise<void> {
    const slot = FILES_BY_CLIENT_ID.get(clientId);
    const pending = get().pendingUploads[clientId];
    if (!pending) return;
    if (!slot) {
      // No File backing — happens when retry is attempted after a reload
      // drops the side-map. We cannot re-upload without bytes; keep the
      // pending row but surface a clear failure for the user.
      markFailed(clientId, STRINGS.errors.mutationFailed);
      return;
    }

    const { file, hasThumbnail } = slot;
    const label = pending.label;

    try {
      // Step 1 — client image pipeline.
      const processed = await runImagePipeline(file, { hasThumbnail });

      // Step 2 — per-file size cap. Enforced server-side by the
      // presigned policy's `content-length-range`; mismatch here is a
      // client bug, not a security gap (ui/project-detail.md §8.15.4).
      if (processed.sizeBytes > ATTACHMENT_PIPELINE.perFileSizeCapBytes) {
        markFailed(clientId, STRINGS.attachments.uploadFileTooLarge);
        return;
      }

      // Step 3 — init (creates a `pending` row + presigned POST
      // descriptors).
      const initResult = await attachmentApi.initUpload(projectId, {
        fileName: file.name,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
        label,
        hasThumbnail: hasThumbnail && processed.thumbnail !== null,
      });
      if (!initResult.ok) {
        if (initResult.sessionExpired) {
          handleSessionExpired();
          return;
        }
        markFailed(clientId, initResult.error.message || STRINGS.errors.mutationFailed);
        return;
      }
      const initData = initResult.data;

      updatePending(clientId, {
        status: 'uploading',
        attachmentId: initData.attachment.id,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
      });

      // Step 4 — POST the original bytes to storage.
      const originalResp = await postPresignedForm(
        initData.originalUpload,
        processed.original,
        file.name,
      );
      if (!originalResp.ok) {
        markFailed(clientId, STRINGS.errors.mutationFailed);
        return;
      }

      // Step 5 — POST the thumbnail (when present).
      if (processed.thumbnail && initData.thumbnailUpload) {
        const thumbResp = await postPresignedForm(
          initData.thumbnailUpload,
          processed.thumbnail,
          file.name,
        );
        if (!thumbResp.ok) {
          markFailed(clientId, STRINGS.errors.mutationFailed);
          return;
        }
      }

      // Step 6 — complete (server verifies bytes via HEAD).
      updatePending(clientId, { status: 'completing' });
      const completeResult = await attachmentApi.completeUpload(projectId, initData.attachment.id);
      if (!completeResult || !completeResult.ok) {
        if (completeResult && completeResult.sessionExpired) {
          handleSessionExpired();
          return;
        }
        const message =
          (completeResult && completeResult.error?.message) || STRINGS.errors.mutationFailed;
        markFailed(clientId, message);
        return;
      }

      // Step 7 — success. Remove the pending entry and refresh the list.
      removePending(clientId);
      await get().fetchForProject(projectId);
    } catch {
      // Catches throws from the pipeline, fetch (rare — we caught inside
      // `postPresignedForm`), or any unexpected state transition.
      markFailed(clientId, STRINGS.errors.mutationFailed);
    }
  }

  return {
    byProject: {},
    pendingUploads: {},
    error: null,

    fetchForProject: async (projectId: string) => {
      let result;
      try {
        result = await attachmentApi.list(projectId);
      } catch {
        set({ error: STRINGS.errors.mutationFailed });
        return;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return;
        }
        set({ error: result.error.message || STRINGS.errors.mutationFailed });
        return;
      }
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: result.data.data },
        error: null,
      }));
    },

    uploadFile: async (projectId, file, input) => {
      const clientId = newClientId();
      // Synchronous insert — the UploadCta test relies on the pending
      // row being visible before the first microtask boundary (the test
      // calls `await Promise.resolve()` and asserts the initializing
      // state). Using a non-async insert keeps the contract clean.
      FILES_BY_CLIENT_ID.set(clientId, { file, hasThumbnail: input.hasThumbnail });
      set((s) => ({
        pendingUploads: {
          ...s.pendingUploads,
          [clientId]: {
            clientId,
            projectId,
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            label: input.label,
            status: 'initializing',
            attachmentId: null,
            progress: 0,
            errorMessage: null,
          },
        },
      }));

      await runUpload(clientId, projectId);
    },

    retryUpload: async (clientId) => {
      const pending = get().pendingUploads[clientId];
      if (!pending) return;
      // Clear the failed state synchronously so the UI's banner
      // disappears during the retry (spec §8.15.8 — retry restarts
      // from init).
      updatePending(clientId, { status: 'initializing', errorMessage: null, progress: 0 });
      await runUpload(clientId, pending.projectId);
    },

    dismissUpload: (clientId) => {
      removePending(clientId);
    },

    deleteAttachment: async (projectId, attachmentId) => {
      // Optimistic removal — roll back on failure.
      const before = get().byProject[projectId];
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((a) => a.id !== attachmentId),
        },
      }));

      let result;
      try {
        result = await attachmentApi.delete(projectId, attachmentId);
      } catch {
        set((s) => ({
          byProject: { ...s.byProject, [projectId]: before ?? [] },
          error: STRINGS.errors.mutationFailed,
        }));
        return;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return;
        }
        set((s) => ({
          byProject: { ...s.byProject, [projectId]: before ?? [] },
          error: result.error.message || STRINGS.errors.mutationFailed,
        }));
        return;
      }
    },

    requestDownloadUrl: async (projectId, attachmentId, variant) => {
      let result;
      try {
        result = await attachmentApi.downloadUrl(projectId, attachmentId, variant);
      } catch {
        return null;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return null;
        }
        // NOT_FOUND is the "Datei fehlt" signal (ui/project-detail.md
        // §8.15.7). Every other failure is also a "can't render this
        // row" for the caller, so the single null return covers both.
        return null;
      }
      return result.data.url;
    },

    requestBulkDownloadUrl: async (projectId, attachmentIds) => {
      let result;
      try {
        result = await attachmentApi.bulkDownloadUrl(projectId, attachmentIds);
      } catch {
        set({ error: STRINGS.errors.mutationFailed });
        return null;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return null;
        }
        set({ error: result.error.message || STRINGS.errors.mutationFailed });
        return null;
      }
      return result.data.url;
    },

    clearError: () => set({ error: null }),
  };
});
