/**
 * BinaryList — tabular list of non-photo attachments + bulk-download
 * selection + "Datei fehlt" on download-click.
 *
 * Covers AC-223 (rows render filename/label/uploader/timestamp/
 * download; a `Auswahl als ZIP` action respects client-side caps and
 * the client message names both caps) and the binary side of AC-224
 * (on a download 404 the row flips to `"Datei fehlt"` and the download
 * action is disabled; the row is excluded from bulk-download).
 *
 * The bulk-download cap numbers live in config **[C]**; the test pins
 * the cap names (file count + byte size) and asserts the client's
 * German validation message references both, without hard-coding the
 * numeric values a config edit can move.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult, AttachmentDownloadUrlResponse } from '@/api/client';
import type { Attachment, User } from '@/domain/types';

type ListResult = ApiResult<{ data: Attachment[] }>;
type DownloadUrlResult = ApiResult<AttachmentDownloadUrlResponse>;
type UserListResult = ApiResult<{ users: User[]; total: number }>;

const listMock = vi.fn<(projectId: string) => Promise<ListResult>>();
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
const userListMock =
  vi.fn<(params?: { offset?: number; limit?: number }) => Promise<UserListResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      downloadUrl: (...args: unknown[]) =>
        downloadUrlMock(...(args as Parameters<typeof downloadUrlMock>)),
      bulkDownloadUrl: (...args: unknown[]) =>
        bulkDownloadUrlMock(...(args as Parameters<typeof bulkDownloadUrlMock>)),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
    },
    userApi: {
      list: (...args: unknown[]) => userListMock(...(args as Parameters<typeof userListMock>)),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { BinaryList } = await import('@/ui/detail/BinaryList');
const { useAuthStore } = await import('@/state/authStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');

function makeBinary(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'bin-1',
    projectId: 'p-42',
    status: 'ready',
    kind: 'binary',
    label: 'rechnung',
    fileName: 'rechnung.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 200_000,
    originalKey: 'proj/p-42/bin-1/o.pdf',
    thumbKey: null,
    hasThumbnail: false,
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: 'u-w1',
    ...overrides,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  listMock.mockReset();
  downloadUrlMock.mockReset();
  bulkDownloadUrlMock.mockReset();
  userListMock.mockReset();

  useAttachmentStore.setState({ byProject: {}, pendingUploads: {}, error: null });
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

  // Default list: two ready binaries + one ready photo (excluded from
  // binary list) + one pending binary (excluded until ready).
  listMock.mockResolvedValue(
    ok({
      data: [
        makeBinary({
          id: 'bin-pdf',
          fileName: 'angebot.pdf',
          label: 'angebot',
          sizeBytes: 120_000,
          createdBy: 'u-w1',
        }),
        makeBinary({
          id: 'bin-docx',
          fileName: 'auftrag.docx',
          label: 'auftragsbestaetigung',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 80_000,
          createdBy: 'u-w2',
        }),
        makeBinary({
          id: 'ph-1',
          kind: 'photo',
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          label: 'foto',
          hasThumbnail: true,
          thumbKey: 'proj/p-42/ph-1/thumb.webp',
        }),
        makeBinary({ id: 'bin-pending', status: 'pending', fileName: 'pending.pdf' }),
      ],
    }),
  );

  downloadUrlMock.mockResolvedValue(
    ok({ url: 'https://storage/dl', expiresAt: '2026-04-20T10:05:00Z' }),
  );
  bulkDownloadUrlMock.mockResolvedValue(
    ok({ url: 'https://storage/zip', expiresAt: '2026-04-20T10:05:00Z' }),
  );
  userListMock.mockResolvedValue(
    ok({
      users: [
        { id: 'u-w1', username: 'anna', displayName: 'Anna Arbeiter', roles: ['worker'] } as User,
        { id: 'u-w2', username: 'bernd', displayName: 'Bernd Bauer', roles: ['worker'] } as User,
      ],
      total: 2,
    }),
  );
});

describe('BinaryList — row rendering (AC-223)', () => {
  it('renders one row per ready binary with filename/label/uploader/download', async () => {
    render(<BinaryList projectId="p-42" />);

    await screen.findByText('angebot.pdf');
    const rows = screen.getAllByTestId('attachment-binary-row');
    // Fixture has 2 ready binaries (pdf + docx); photo + pending are excluded.
    expect(rows).toHaveLength(2);
    const pdfRow = rows.find((r) => r.textContent?.includes('angebot.pdf'))!;
    expect(pdfRow).toBeDefined();
    expect(pdfRow.textContent?.toLowerCase()).toContain('angebot');
    expect(pdfRow.textContent).toContain('Anna Arbeiter');
    expect(within(pdfRow).getByTestId('attachment-download')).toBeInTheDocument();
  });

  it('excludes photo attachments from the binary list', async () => {
    render(<BinaryList projectId="p-42" />);
    await screen.findByText('angebot.pdf');
    expect(screen.queryByText('photo.jpg')).not.toBeInTheDocument();
  });

  it('excludes pending binary attachments from the list', async () => {
    render(<BinaryList projectId="p-42" />);
    await screen.findByText('angebot.pdf');
    expect(screen.queryByText('pending.pdf')).not.toBeInTheDocument();
  });
});

describe('BinaryList — bulk selection + caps (AC-223)', () => {
  it('shows Auswahl als ZIP only once at least one row is selected', async () => {
    render(<BinaryList projectId="p-42" />);
    const pdfRow = (await screen.findByText('angebot.pdf')).closest('tr')!;

    expect(screen.queryByTestId('binary-bulk-download')).not.toBeInTheDocument();

    await userEvent.click(within(pdfRow).getByRole('checkbox'));

    expect(await screen.findByTestId('binary-bulk-download')).toBeInTheDocument();
  });

  it('blocks a selection above the caps with a German message naming both caps', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeBinary({ id: `bin-${i}`, fileName: `file-${i}.pdf`, sizeBytes: 1_000_000 }),
    );
    listMock.mockResolvedValue(ok({ data: many }));

    render(<BinaryList projectId="p-42" />);
    await screen.findByText('file-0.pdf');

    await userEvent.click(screen.getByTestId('binary-select-all'));
    await userEvent.click(screen.getByTestId('binary-bulk-download'));

    const block = await screen.findByTestId('binary-bulk-limit-error');
    // The German validation message names BOTH caps (files + bytes).
    expect(block.textContent?.toLowerCase()).toMatch(/datei/);
    expect(block.textContent?.toLowerCase()).toMatch(/mb|byte|gr[oö]ße/);

    // Client-side block — no network call to the server.
    expect(bulkDownloadUrlMock).not.toHaveBeenCalled();
  });
});

describe('BinaryList — "Datei fehlt" on download-click 404 (AC-224 binary side)', () => {
  it('flips the row to "Datei fehlt" and disables the download when the fetch fails', async () => {
    // Lazy detection: the list endpoint does not probe storage; the
    // UI learns bytes are missing only when the user clicks download
    // and the presigned-GET resolves to a 404.
    downloadUrlMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
      category: 'not_found',
      sessionExpired: false,
    });

    render(<BinaryList projectId="p-42" />);

    const pdfRow = (await screen.findByText('angebot.pdf')).closest('tr')!;
    await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

    await waitFor(() => {
      expect(within(pdfRow).getByText(/datei fehlt/i)).toBeInTheDocument();
    });

    expect(within(pdfRow).getByTestId('attachment-download')).toBeDisabled();
  });

  it('excludes a missing-file row from bulk-download selection', async () => {
    downloadUrlMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Datei nicht gefunden.' },
      category: 'not_found',
      sessionExpired: false,
    });

    render(<BinaryList projectId="p-42" />);

    const pdfRow = (await screen.findByText('angebot.pdf')).closest('tr')!;
    await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

    await waitFor(() => {
      expect(within(pdfRow).getByText(/datei fehlt/i)).toBeInTheDocument();
    });

    const checkbox = within(pdfRow).queryByRole('checkbox');
    if (checkbox) expect(checkbox).toBeDisabled();
  });
});
