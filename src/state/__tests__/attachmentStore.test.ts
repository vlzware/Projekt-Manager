/**
 * attachmentStore — state-shape + action-behavior tests.
 *
 * Covers the store contract the project-detail page depends on:
 *   - `byProject` caches the list keyed by project id.
 *   - `pendingUploads` is keyed by a stable client-generated id so the
 *     UI can render per-row progress and retry without waiting for a
 *     server-assigned attachmentId.
 *   - `error` captures the last mutation error in the German canonical
 *     form (or the server-supplied German message when present), cleared
 *     by `clearError`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ApiResult,
  AttachmentInitResponse,
  AttachmentDownloadUrlResponse,
} from '@/api/client';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import type { ProcessedUpload } from '@/domain/imagePipeline';

type ListResult = ApiResult<{ data: Attachment[] }>;
type InitResult = ApiResult<AttachmentInitResponse>;
type CompleteResult = ApiResult<Attachment>;
type DownloadUrlResult = ApiResult<AttachmentDownloadUrlResponse>;
type DeleteResult = ApiResult<null>;

type InitInput = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
};

const listMock = vi.fn<(projectId: string) => Promise<ListResult>>();
const initMock =
  vi.fn<(projectId: string, input: InitInput, signal?: AbortSignal) => Promise<InitResult>>();
const completeMock = vi.fn<(projectId: string, attachmentId: string) => Promise<CompleteResult>>();
const deleteMock = vi.fn<(projectId: string, attachmentId: string) => Promise<DeleteResult>>();
const downloadUrlMock =
  vi.fn<
    (
      projectId: string,
      attachmentId: string,
      variant: 'original' | 'thumbnail',
    ) => Promise<DownloadUrlResult>
  >();
const bulkDownloadUrlMock =
  vi.fn<(projectId: string, attachmentIds: string[]) => Promise<DownloadUrlResult>>();

// Pipeline mock — observable so the retry-cache test can assert the
// canvas-heavy work runs at most once across a failed-then-retried
// upload. The real pipeline touches `document.createElement('canvas')`,
// which adds nothing to store-behaviour coverage and confuses failure
// attribution; a passthrough mock keeps the store's orchestration in
// focus.
const runImagePipelineMock =
  vi.fn<(file: File, opts: { hasThumbnail: boolean }) => Promise<ProcessedUpload>>();

vi.mock('@/domain/imagePipeline', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    runImagePipeline: (...args: Parameters<typeof runImagePipelineMock>) =>
      runImagePipelineMock(...args),
  };
});

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      initUpload: (...args: unknown[]) => initMock(...(args as Parameters<typeof initMock>)),
      completeUpload: (...args: unknown[]) =>
        completeMock(...(args as Parameters<typeof completeMock>)),
      delete: (...args: unknown[]) => deleteMock(...(args as Parameters<typeof deleteMock>)),
      downloadUrl: (...args: unknown[]) =>
        downloadUrlMock(...(args as Parameters<typeof downloadUrlMock>)),
      bulkDownloadUrl: (...args: unknown[]) =>
        bulkDownloadUrlMock(...(args as Parameters<typeof bulkDownloadUrlMock>)),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
      changePassword: vi.fn(),
    },
  };
});

const { useAttachmentStore } = await import('@/state/attachmentStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function makeAttachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'att-1',
    projectId: 'proj-1',
    status: 'ready',
    kind: 'photo',
    label: 'foto',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    originalKey: 'attachments/proj-1/att-1/original.jpg',
    thumbKey: 'attachments/proj-1/att-1/thumb.webp',
    hasThumbnail: true,
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: { id: 'u-1', displayName: 'Test User' },
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
  initMock.mockReset();
  completeMock.mockReset();
  deleteMock.mockReset();
  downloadUrlMock.mockReset();
  bulkDownloadUrlMock.mockReset();
  runImagePipelineMock.mockReset();
  // Default: passthrough — echo the input file's bytes. Tests that want
  // to observe re-encoding override per-call with `mockImplementationOnce`.
  runImagePipelineMock.mockImplementation(async (file) => ({
    original: file,
    thumbnail: null,
    mimeType: file.type,
    sizeBytes: file.size,
  }));
  useAttachmentStore.setState({
    byProject: {},
    pendingUploads: {},
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachmentStore — per-project list cache', () => {
  it('populates byProject[projectId] after a successful list fetch', async () => {
    const rows = [
      makeAttachment({ id: 'a1', projectId: 'proj-1', fileName: 'one.jpg' }),
      makeAttachment({ id: 'a2', projectId: 'proj-1', fileName: 'two.pdf', kind: 'binary' }),
    ];
    listMock.mockResolvedValue(ok({ data: rows }));

    await useAttachmentStore.getState().fetchForProject('proj-1');

    const cached = useAttachmentStore.getState().byProject['proj-1'];
    expect(cached).toBeDefined();
    expect(cached).toHaveLength(2);
    expect(cached?.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('isolates caches per project — fetching one does not clobber another', async () => {
    listMock.mockImplementation(async (projectId: unknown) => {
      if (projectId === 'proj-1') return ok({ data: [makeAttachment({ id: 'a1' })] });
      if (projectId === 'proj-2') return ok({ data: [makeAttachment({ id: 'b1' })] });
      return ok({ data: [] });
    });

    await useAttachmentStore.getState().fetchForProject('proj-1');
    await useAttachmentStore.getState().fetchForProject('proj-2');

    const state = useAttachmentStore.getState();
    expect(state.byProject['proj-1']?.map((a) => a.id)).toEqual(['a1']);
    expect(state.byProject['proj-2']?.map((a) => a.id)).toEqual(['b1']);
  });
});

describe('attachmentStore — pending uploads keyed by client id', () => {
  it('records an initializing entry the moment uploadFile is invoked', async () => {
    // Hold init open so we can observe the initializing state before
    // the flow progresses.
    let resolveInit!: (value: InitResult) => void;
    initMock.mockImplementation(
      () =>
        new Promise<InitResult>((resolve) => {
          resolveInit = resolve;
        }),
    );

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    void useAttachmentStore
      .getState()
      .uploadFile('proj-1', file, { label: 'foto', hasThumbnail: true });

    // Microtask flush so the store's synchronous initializing-write lands.
    await Promise.resolve();

    const pending = Object.values(useAttachmentStore.getState().pendingUploads);
    expect(pending).toHaveLength(1);
    expect(pending[0].projectId).toBe('proj-1');
    expect(pending[0].fileName).toBe('photo.jpg');
    expect(pending[0].status).toBe('initializing');
    expect(pending[0].attachmentId).toBeNull();
    // The key is the client-generated id — it must be stable and match
    // the entry's own clientId.
    const [key] = Object.keys(useAttachmentStore.getState().pendingUploads);
    expect(key).toBe(pending[0].clientId);

    // Release the hanging promise so the test runner doesn't hold it.
    resolveInit({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'stop' },
      category: 'server_error',
      sessionExpired: false,
    });
  });

  it('removes a pending entry when the user dismisses it', async () => {
    useAttachmentStore.setState({
      pendingUploads: {
        'client-1': {
          clientId: 'client-1',
          projectId: 'proj-1',
          fileName: 'broken.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          label: 'foto',
          status: 'failed',
          attachmentId: null,
          errorMessage: 'Netzwerkfehler.',
        },
      },
    });

    useAttachmentStore.getState().dismissUpload('client-1');

    expect(useAttachmentStore.getState().pendingUploads['client-1']).toBeUndefined();
  });
});

describe('attachmentStore — error state', () => {
  it('sets error to the server-supplied German message on failed list', async () => {
    listMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Ein interner Fehler ist aufgetreten.' },
      category: 'server_error',
      sessionExpired: false,
    });

    await useAttachmentStore.getState().fetchForProject('proj-1');

    expect(useAttachmentStore.getState().error).toBe('Ein interner Fehler ist aufgetreten.');
  });

  it('falls back to the canonical German mutation-failed message on network rejection', async () => {
    listMock.mockRejectedValue(new Error('fetch failed'));

    await useAttachmentStore.getState().fetchForProject('proj-1');

    expect(useAttachmentStore.getState().error).toBe(
      'Änderung fehlgeschlagen. Bitte erneut versuchen.',
    );
  });

  it('clearError resets the error slot to null without touching caches', async () => {
    useAttachmentStore.setState({
      byProject: { 'proj-1': [makeAttachment({})] },
      error: 'Netzwerkfehler. Bitte Verbindung überprüfen.',
    });

    useAttachmentStore.getState().clearError();

    const state = useAttachmentStore.getState();
    expect(state.error).toBeNull();
    expect(state.byProject['proj-1']).toHaveLength(1);
  });
});

describe('attachmentStore — retry and download URL plumbing', () => {
  it('retryUpload re-runs init for the retained client id (no caching of failure)', async () => {
    // Drive a real upload through the store so the internal file map is
    // populated — retryUpload depends on it per the store's contract.
    initMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'stop' },
      category: 'server_error',
      sessionExpired: false,
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', {
      type: 'image/jpeg',
    });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: true,
    });

    const clientId = Object.keys(useAttachmentStore.getState().pendingUploads)[0];
    expect(clientId).toBeDefined();
    expect(initMock).toHaveBeenCalledTimes(1);

    await useAttachmentStore.getState().retryUpload(clientId!);

    // init must fire again — no silent caching of the prior failure.
    expect(initMock).toHaveBeenCalledTimes(2);
  });

  it('retry reuses the cached pipeline output so the canvas work runs exactly once', async () => {
    // The store caches the ProcessedUpload on `FILES_BY_CLIENT_ID` after
    // a first successful pipeline run so a network-level failure at init
    // / POST / complete does NOT force a re-encode on retry. Force `init`
    // to fail on both attempts; assert the pipeline mock fires only once.
    initMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'server busy' },
      category: 'server_error',
      sessionExpired: false,
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', {
      type: 'image/jpeg',
    });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: true,
    });

    const clientId = Object.keys(useAttachmentStore.getState().pendingUploads)[0];
    expect(clientId).toBeDefined();
    expect(runImagePipelineMock).toHaveBeenCalledTimes(1);

    await useAttachmentStore.getState().retryUpload(clientId!);

    // Pipeline stays at one invocation across both attempts — the second
    // run pulls the cached `ProcessedUpload` from the side-map.
    expect(runImagePipelineMock).toHaveBeenCalledTimes(1);
    // Init did fire twice — the retry actually ran, it just skipped the
    // expensive pipeline step.
    expect(initMock).toHaveBeenCalledTimes(2);
  });

  it('requestDownloadUrl returns the server URL on success and null on failure', async () => {
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage/thumb', expiresAt: '2026-04-20T10:05:00Z' }),
    );
    const urlOk = await useAttachmentStore
      .getState()
      .requestDownloadUrl('proj-1', 'att-1', 'thumbnail');
    expect(urlOk).toBe('https://storage/thumb');

    downloadUrlMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
      category: 'not_found',
      sessionExpired: false,
    });
    const urlFail = await useAttachmentStore
      .getState()
      .requestDownloadUrl('proj-1', 'att-1', 'original');
    expect(urlFail).toBeNull();
  });
});

/**
 * Deferred-promise helper — lets a test hold a mock call open at a chosen
 * point in the orchestrator, so the surrounding orchestration can be
 * observed (cancelled, retried, etc.) mid-flight. Preferred over timer
 * hacks because it produces deterministic tests.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('attachmentStore — cancellation', () => {
  it('cancelUpload aborts the in-flight transport and drops the pending row', async () => {
    // Hold `initUpload` open so the orchestrator is mid-flight when we
    // fire `cancelUpload`. Capture the `AbortSignal` passed by the store
    // so we can assert `abort()` landed on it.
    const init = deferred<InitResult>();
    let capturedSignal: AbortSignal | undefined;
    initMock.mockImplementation(async (_projectId, _input, signal) => {
      capturedSignal = signal;
      return init.promise;
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    const uploadPromise = useAttachmentStore
      .getState()
      .uploadFile('proj-1', file, { label: 'foto', hasThumbnail: false });

    // Let the synchronous insert + pipeline microtasks settle so the
    // AbortController is installed and `initUpload` is awaiting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const clientId = Object.keys(useAttachmentStore.getState().pendingUploads)[0];
    expect(clientId).toBeDefined();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    useAttachmentStore.getState().cancelUpload(clientId!);

    expect(capturedSignal!.aborted).toBe(true);
    // Pending row is dropped immediately so the UI reflects the cancel
    // without waiting for the transport to finish unwinding.
    expect(useAttachmentStore.getState().pendingUploads[clientId!]).toBeUndefined();

    // Release the hanging init so vitest doesn't hold an open promise.
    init.resolve({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'late' },
      category: 'server_error',
      sessionExpired: false,
    });
    await uploadPromise;
  });

  it('cancelUploadsForProject aborts only the target project, leaves others untouched', async () => {
    // Three in-flight uploads: two on proj-A, one on proj-B. Hold every
    // `initUpload` open so they all sit at the init step when cancel fires.
    const deferredByOrder: Array<{
      promise: Promise<InitResult>;
      resolve: (v: InitResult) => void;
    }> = [deferred<InitResult>(), deferred<InitResult>(), deferred<InitResult>()];
    const signalsByProject: Record<string, AbortSignal[]> = { 'proj-A': [], 'proj-B': [] };

    let callIndex = 0;
    initMock.mockImplementation(async (projectId, _input, signal) => {
      if (projectId === 'proj-A' || projectId === 'proj-B') {
        signalsByProject[projectId].push(signal!);
      }
      const d = deferredByOrder[callIndex];
      callIndex += 1;
      return d.promise;
    });

    const files = [
      new File([new Uint8Array([1])], 'a1.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'a2.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([3])], 'b1.jpg', { type: 'image/jpeg' }),
    ];
    const pending = [
      useAttachmentStore
        .getState()
        .uploadFile('proj-A', files[0], { label: 'foto', hasThumbnail: false }),
      useAttachmentStore
        .getState()
        .uploadFile('proj-A', files[1], { label: 'foto', hasThumbnail: false }),
      useAttachmentStore
        .getState()
        .uploadFile('proj-B', files[2], { label: 'foto', hasThumbnail: false }),
    ];

    // Let the three orchestrators advance to the init step.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(signalsByProject['proj-A']).toHaveLength(2);
    expect(signalsByProject['proj-B']).toHaveLength(1);

    useAttachmentStore.getState().cancelUploadsForProject('proj-A');

    // Every proj-A transport is cancelled.
    for (const s of signalsByProject['proj-A']) expect(s.aborted).toBe(true);
    // proj-B is not touched.
    expect(signalsByProject['proj-B'][0].aborted).toBe(false);

    // Pending rows for proj-A are gone; proj-B's row is still in the map.
    const remaining = Object.values(useAttachmentStore.getState().pendingUploads);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].projectId).toBe('proj-B');

    // Release all hanging inits so the uploads finish cleanly.
    for (const d of deferredByOrder) {
      d.resolve({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'late' },
        category: 'server_error',
        sessionExpired: false,
      });
    }
    await Promise.all(pending);
  });
});

describe('attachmentStore — image processing failures and stale-row sweep', () => {
  it('emits a structured console diagnostic when an upload fails (developer triage)', async () => {
    // The user-facing toast / banner is intentionally generic, but a
    // developer triaging an upload failure must see WHICH stage tripped
    // and the underlying server error. Without this hook every failure
    // surfaces as opaque "Bildbearbeitung fehlgeschlagen" or "Änderung
    // fehlgeschlagen", and the developer has nothing to grep for in the
    // browser console.
    initMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'init exploded' },
      category: 'server_error',
      sessionExpired: false,
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: false,
    });

    expect(warn).toHaveBeenCalledWith(
      '[upload] failed',
      expect.objectContaining({
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        stage: 'init',
        userMessage: 'init exploded',
        details: expect.objectContaining({ code: 'SERVER_ERROR' }),
      }),
    );
  });

  it('marks the upload failed with uploadImageProcessingFailed when the pipeline throws the tagged error', async () => {
    // The pipeline surfaces a distinct IMAGE_PROCESSING_FAILED tag for
    // compression crashes (canvas OOM, worker crash, decoder bug) so
    // they can be diagnosed separately from size-cap failures. The
    // store must map it to the German "Bildbearbeitung fehlgeschlagen"
    // message — collapsing it into mutationFailed would hide the
    // specific cause from the user and from log triage.
    runImagePipelineMock.mockImplementationOnce(async () => {
      throw new Error('IMAGE_PROCESSING_FAILED');
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: true,
    });

    const rows = Object.values(useAttachmentStore.getState().pendingUploads);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorMessage).toBe('Bildbearbeitung fehlgeschlagen.');
    // init must never have fired — the pipeline threw before the server
    // round-trip, so no phantom attachment rows are created.
    expect(initMock).not.toHaveBeenCalled();
  });

  it('a successful upload sweeps prior failed rows for the same project', async () => {
    // Bug: a failed upload leaves a `status: 'failed'` row in the
    // pending map that renders the inline "Datei zu groß" banner
    // indefinitely. When the user successfully uploads a different
    // file, the stale banner stays pinned. Fix: on success, drop any
    // failed rows for the same project.
    useAttachmentStore.setState({
      pendingUploads: {
        'stale-1': {
          clientId: 'stale-1',
          projectId: 'proj-1',
          fileName: 'huge.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          label: 'foto',
          status: 'failed',
          attachmentId: null,
          errorMessage: 'Datei zu groß.',
        },
      },
    });

    // Drive a real success through the full orchestrator: init → POST
    // original → complete. postPresignedForm is stubbed via fetch so
    // the store sees a 2xx and completes cleanly.
    initMock.mockResolvedValueOnce(
      ok({
        attachment: makeAttachment({ id: 'att-new', projectId: 'proj-1' }),
        originalUpload: {
          url: 'https://storage/orig',
          fields: {},
          expiresAt: '2026-04-23T10:05:00Z',
        },
      }),
    );
    completeMock.mockResolvedValueOnce(ok(makeAttachment({ id: 'att-new', projectId: 'proj-1' })));
    listMock.mockResolvedValueOnce(ok({ data: [] }));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const file = new File([new Uint8Array([1, 2, 3])], 'good.jpg', { type: 'image/jpeg' });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: false,
    });

    // Success removes its own row AND the stale failed row.
    expect(useAttachmentStore.getState().pendingUploads).toEqual({});

    fetchSpy.mockRestore();
  });

  it('a successful upload does NOT sweep failed rows in unrelated projects', async () => {
    // Scoping: a success on project A must not erase a failure on
    // project B — those are independent user flows.
    useAttachmentStore.setState({
      pendingUploads: {
        'other-proj-failed': {
          clientId: 'other-proj-failed',
          projectId: 'proj-other',
          fileName: 'broken.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          label: 'foto',
          status: 'failed',
          attachmentId: null,
          errorMessage: 'Netzwerkfehler.',
        },
      },
    });

    initMock.mockResolvedValueOnce(
      ok({
        attachment: makeAttachment({ id: 'att-new', projectId: 'proj-1' }),
        originalUpload: {
          url: 'https://storage/orig',
          fields: {},
          expiresAt: '2026-04-23T10:05:00Z',
        },
      }),
    );
    completeMock.mockResolvedValueOnce(ok(makeAttachment({ id: 'att-new', projectId: 'proj-1' })));
    listMock.mockResolvedValueOnce(ok({ data: [] }));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const file = new File([new Uint8Array([1, 2, 3])], 'good.jpg', { type: 'image/jpeg' });
    await useAttachmentStore.getState().uploadFile('proj-1', file, {
      label: 'foto',
      hasThumbnail: false,
    });

    // The other-project failure is untouched.
    const rows = Object.values(useAttachmentStore.getState().pendingUploads);
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe('proj-other');
    expect(rows[0].status).toBe('failed');

    fetchSpy.mockRestore();
  });
});
