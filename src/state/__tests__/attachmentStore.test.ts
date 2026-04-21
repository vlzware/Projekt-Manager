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
const initMock = vi.fn<(projectId: string, input: InitInput) => Promise<InitResult>>();
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
    createdBy: 'u-1',
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
          progress: 0,
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
