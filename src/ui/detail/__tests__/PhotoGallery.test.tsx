/**
 * PhotoGallery — thumbnail rendering + "Datei fehlt" lazy detection.
 *
 * Covers AC-222 (gallery renders `status = 'ready'` photos via
 * presigned thumbnail URLs; binaries never appear) and the photo side
 * of AC-224 (a thumbnail 404 flips the affected row to a neutral
 * `"Datei fehlt"` placeholder, and the row is excluded from the
 * lightbox).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult, AttachmentDownloadUrlResponse } from '@/api/client';
import type { Attachment } from '@/domain/types';

type ListResult = ApiResult<{ data: Attachment[] }>;
type DownloadUrlResult = ApiResult<AttachmentDownloadUrlResponse>;

const listMock = vi.fn<(projectId: string) => Promise<ListResult>>();
const downloadUrlMock =
  vi.fn<
    (
      projectId: string,
      attachmentId: string,
      variant: 'original' | 'thumbnail',
    ) => Promise<DownloadUrlResult>
  >();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      downloadUrl: (...args: unknown[]) =>
        downloadUrlMock(...(args as Parameters<typeof downloadUrlMock>)),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
      bulkDownloadUrl: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { PhotoGallery } = await import('@/ui/detail/PhotoGallery');
const { useAuthStore } = await import('@/state/authStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');

function makePhoto(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'ph-1',
    projectId: 'p-42',
    status: 'ready',
    kind: 'photo',
    label: 'foto',
    fileName: 'photo-1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 200_000,
    originalKey: 'proj/p-42/att/ph-1/o.jpg',
    thumbKey: 'proj/p-42/att/ph-1/thumb.webp',
    hasThumbnail: true,
    hiddenAt: null,
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: { id: 'u-w1', displayName: 'Anna Arbeiter' },
    ...overrides,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  listMock.mockReset();
  downloadUrlMock.mockReset();
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
  useAttachmentStore.setState({ byProject: {}, pendingUploads: {}, error: null });

  // Default list: one ready photo + one binary + one pending photo.
  listMock.mockResolvedValue(
    ok({
      data: [
        makePhoto({ id: 'ph-ready', fileName: 'ready.jpg' }),
        makePhoto({
          id: 'bin-1',
          kind: 'binary',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          hasThumbnail: false,
          thumbKey: null,
          label: 'rechnung',
        }),
        makePhoto({ id: 'ph-pending', status: 'pending', fileName: 'pending.jpg' }),
      ],
    }),
  );

  downloadUrlMock.mockResolvedValue(
    ok({ url: 'https://storage.example/thumb-url', expiresAt: '2026-04-20T10:05:00Z' }),
  );
});

describe('PhotoGallery — renders ready photo thumbnails (AC-222)', () => {
  it('renders one thumbnail per ready photo attachment', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    // Thumbnail image source is a presigned URL requested at render time.
    const img = thumb.querySelector('img');
    expect(img).not.toBeNull();
    await waitFor(() => {
      expect(img?.getAttribute('src')).toContain('thumb-url');
    });
  });

  it('does not render a thumbnail for binary or pending attachments', async () => {
    render(<PhotoGallery projectId="p-42" />);

    // The ready photo is rendered — wait for that so we know the list
    // settled before asserting absences.
    await screen.findByTestId('photo-thumb-ph-ready');

    expect(screen.queryByTestId('photo-thumb-bin-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('photo-thumb-ph-pending')).not.toBeInTheDocument();
  });

  it('requests the thumbnail variant, not the original, at gallery render', async () => {
    render(<PhotoGallery projectId="p-42" />);

    await waitFor(() => {
      expect(downloadUrlMock).toHaveBeenCalled();
    });
    const calls = downloadUrlMock.mock.calls as unknown as Array<
      [projectId: string, attId: string, variant: string]
    >;
    const variants = calls.map((c) => c[2]);
    // Every gallery-render call is for the thumbnail variant. Original
    // URLs are requested only on lightbox open.
    expect(variants.every((v) => v === 'thumbnail')).toBe(true);
  });
});

describe('PhotoGallery — lightbox requests the original variant (AC-222)', () => {
  it('fetches a new presigned URL for the original when a thumbnail is clicked', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    downloadUrlMock.mockClear();
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage.example/original-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );

    await userEvent.click(thumb);

    await waitFor(() => {
      expect(downloadUrlMock).toHaveBeenCalled();
    });
    const [, , variant] = downloadUrlMock.mock.calls[0] as unknown as [string, string, string];
    expect(variant).toBe('original');
    expect(await screen.findByTestId('photo-lightbox')).toBeInTheDocument();
  });
});

describe('PhotoGallery — lightbox a11y', () => {
  it('closes the lightbox on Escape', async () => {
    downloadUrlMock.mockImplementationOnce(async () =>
      ok({ url: 'https://storage.example/thumb-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );

    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage.example/original-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );
    await userEvent.click(thumb);

    expect(await screen.findByTestId('photo-lightbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
  });

  it('closes the lightbox when the X close button is clicked', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage.example/original-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );
    await userEvent.click(thumb);

    await screen.findByTestId('photo-lightbox');
    await userEvent.click(screen.getByTestId('photo-lightbox-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
  });

  it('keeps the lightbox open when the backdrop or the photo itself is clicked', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage.example/original-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );
    await userEvent.click(thumb);

    const lightbox = await screen.findByTestId('photo-lightbox');
    await userEvent.click(lightbox);
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();

    const innerImg = lightbox.querySelector('img');
    expect(innerImg).not.toBeNull();
    await userEvent.click(innerImg!);
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
  });

  it('restores focus to the thumbnail that opened the lightbox on close', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    downloadUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://storage.example/original-url', expiresAt: '2026-04-20T10:05:00Z' }),
    );
    await userEvent.click(thumb);

    await screen.findByTestId('photo-lightbox');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
    // Focus returns to the thumbnail that opened the lightbox so keyboard
    // users stay anchored to their point of entry instead of dropping to
    // document root.
    expect(document.activeElement).toBe(thumb);
  });
});

describe('PhotoGallery — missing-thumbnail re-fetch on list refresh', () => {
  it('re-attempts the thumbnail fetch when a list refresh re-emits a previously-missing row', async () => {
    // First list fetch returns the photo; the thumbnail URL resolves to
    // null (verdict: missing). Spec §8.15.7 forbids caching that verdict
    // — a later list refetch that re-emits the same row must re-probe.
    downloadUrlMock.mockImplementation(async (_projectId: unknown, attId: unknown) => {
      if (attId === 'ph-ready') {
        return {
          ok: false as const,
          error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
          category: 'not_found' as const,
          sessionExpired: false,
        };
      }
      return ok({ url: 'https://x', expiresAt: '2026-04-20T10:05:00Z' });
    });

    render(<PhotoGallery projectId="p-42" />);

    // Placeholder appears => first probe landed as "missing".
    await screen.findByTestId('photo-missing-ph-ready');
    const firstCount = downloadUrlMock.mock.calls.filter(
      (c) => (c as unknown as [string, string, string])[1] === 'ph-ready',
    ).length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Flip the mock to return a working URL on the next probe so a
    // successful refetch is observable as the row leaving the placeholder
    // state. Then simulate a list refresh — the store replaces the
    // per-project slice with a new array reference, which re-runs the
    // gallery's effect.
    downloadUrlMock.mockImplementation(async (_projectId: unknown, attId: unknown) => {
      if (attId === 'ph-ready') {
        return ok({
          url: 'https://storage.example/thumb-refreshed',
          expiresAt: '2026-04-20T10:05:00Z',
        });
      }
      return ok({ url: 'https://x', expiresAt: '2026-04-20T10:05:00Z' });
    });

    // Trigger a list-refresh by re-writing the per-project slice with a
    // fresh object identity. The existing `photos` filter produces a new
    // array, re-running the thumbnail-request effect for any row whose
    // cached entry is `null` (missing verdict).
    useAttachmentStore.setState((s) => ({
      byProject: {
        ...s.byProject,
        'p-42': (s.byProject['p-42'] ?? []).map((a) => ({ ...a })),
      },
    }));

    await waitFor(() => {
      const calls = downloadUrlMock.mock.calls.filter(
        (c) => (c as unknown as [string, string, string])[1] === 'ph-ready',
      );
      expect(calls.length).toBeGreaterThan(firstCount);
    });
  });
});

describe('PhotoGallery — "Datei fehlt" on thumbnail 404 (AC-224 photo side)', () => {
  it('renders the placeholder when the thumbnail fetch returns NOT_FOUND', async () => {
    // Lazy detection: the list endpoint does not probe storage. The UI
    // learns bytes are missing only when the browser follows the
    // presigned URL and the provider responds with a 404 — modelled here
    // as the backing object-storage fetch failing (a real 404 surfacing
    // as an `<img>` error event or a failed GET). The store surface
    // translates that into a per-row missing-file state.
    downloadUrlMock.mockImplementation(async (_projectId: unknown, attId: unknown) => {
      if (attId === 'ph-ready') {
        return {
          ok: false as const,
          error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
          category: 'not_found' as const,
          sessionExpired: false,
        };
      }
      return ok({ url: 'https://x', expiresAt: '2026-04-20T10:05:00Z' });
    });

    render(<PhotoGallery projectId="p-42" />);

    const placeholder = await screen.findByTestId('photo-missing-ph-ready');
    expect(placeholder.textContent).toContain('Datei fehlt');
  });

  it('excludes a missing-file row from the lightbox (clicking the placeholder does not open it)', async () => {
    downloadUrlMock.mockImplementation(async (_projectId: unknown, attId: unknown) => {
      if (attId === 'ph-ready') {
        return {
          ok: false as const,
          error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
          category: 'not_found' as const,
          sessionExpired: false,
        };
      }
      return ok({ url: 'https://x', expiresAt: '2026-04-20T10:05:00Z' });
    });

    render(<PhotoGallery projectId="p-42" />);

    const placeholder = await screen.findByTestId('photo-missing-ph-ready');
    await userEvent.click(placeholder);

    expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
  });
});
