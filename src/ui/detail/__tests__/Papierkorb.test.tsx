/**
 * Papierkorb — UI for hidden attachments. Covers ADR-0022 / phase 3.C:
 * fetch-on-mount, render the list, restore moves the row from
 * `hiddenByProject` back into `byProject`. Empty-state copy when no
 * hidden rows exist on the project.
 *
 * Mocks the attachmentApi at the boundary so the test exercises the
 * store's optimistic update path against fixed API responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '@/api/client';
import type { Attachment } from '@/domain/types';

type ListResult = ApiResult<{ data: Attachment[] }>;
type RestoreResult = ApiResult<Attachment>;

const listTrashMock = vi.fn<(projectId: string) => Promise<ListResult>>();
const restoreMock = vi.fn<(projectId: string, attachmentId: string) => Promise<RestoreResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: vi.fn(),
      listTrash: (...args: unknown[]) =>
        listTrashMock(...(args as Parameters<typeof listTrashMock>)),
      restore: (...args: unknown[]) => restoreMock(...(args as Parameters<typeof restoreMock>)),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
      downloadUrl: vi.fn(),
      bulkDownloadUrl: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { Papierkorb } = await import('@/ui/detail/Papierkorb');
const { useAttachmentStore } = await import('@/state/attachmentStore');
const { useToastStore } = await import('@/state/toastStore');
const { useAuthStore } = await import('@/state/authStore');

function makeHidden(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'att-1',
    projectId: 'p-42',
    status: 'hidden',
    kind: 'photo',
    label: 'foto',
    fileName: 'foto-1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 200_000,
    originalKey: 'proj/p-42/att/att-1/o.jpg',
    thumbKey: 'proj/p-42/att/att-1/t.webp',
    hasThumbnail: true,
    hiddenAt: new Date(Date.now() - 3600_000).toISOString(),
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: { id: 'u-1', displayName: 'Test User' },
    ...overrides,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  listTrashMock.mockReset();
  restoreMock.mockReset();
  useAttachmentStore.setState({
    byProject: {},
    hiddenByProject: {},
    pendingUploads: {},
    error: null,
  });
  useToastStore.setState({ toasts: [] });
});

describe('Papierkorb', () => {
  it('fetches the trash on mount and renders rows with hiddenAt label + restore button', async () => {
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));

    render(<Papierkorb projectId="p-42" />);

    expect(listTrashMock).toHaveBeenCalledWith('p-42');
    await waitFor(() => {
      expect(screen.getByText(item.fileName)).toBeInTheDocument();
    });
    // Restore button visible on the row, named per the German strings.
    expect(screen.getByTestId(`papierkorb-restore-${item.id}`)).toBeInTheDocument();
  });

  it('shows the empty-state copy when the trash is fetched-empty', async () => {
    listTrashMock.mockResolvedValue(ok({ data: [] }));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByText(/Keine gelöschten Dateien/)).toBeInTheDocument();
    });
  });

  it('restore moves the row out of the trash list and into the live list', async () => {
    const item = makeHidden({});
    const restored: Attachment = {
      ...item,
      status: 'ready',
      hiddenAt: null,
    };
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue(ok(restored));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    expect(restoreMock).toHaveBeenCalledWith('p-42', item.id);

    // Row leaves the trash list optimistically + after the API resolves.
    await waitFor(() => {
      expect(screen.queryByTestId(`papierkorb-row-${item.id}`)).not.toBeInTheDocument();
    });

    // Store: live list now carries the restored row; trash is empty.
    const { byProject, hiddenByProject } = useAttachmentStore.getState();
    expect(byProject['p-42']?.some((a) => a.id === item.id)).toBe(true);
    expect(hiddenByProject['p-42']?.some((a) => a.id === item.id)).toBe(false);
  });

  it('rolls the optimistic restore back and surfaces an error toast when the API fails', async () => {
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue({
      ok: false,
      error: { message: 'boom' },
    } as RestoreResult);

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    // After the failure the item is back in the trash; live list unchanged.
    await waitFor(() => {
      const { hiddenByProject, byProject } = useAttachmentStore.getState();
      expect(hiddenByProject['p-42']?.some((a) => a.id === item.id)).toBe(true);
      expect(byProject['p-42']?.some((a) => a.id === item.id)).toBe(false);
    });

    // Failure must surface to the user — silent rollback would leave
    // the row reappearing in the Papierkorb with no explanation.
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].message).toBe('boom');
  });

  it('falls back to the canonical German restore-failed copy when the API returns no message', async () => {
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue({
      ok: false,
      error: { message: '' },
    } as RestoreResult);

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe('Wiederherstellen fehlgeschlagen.');
    });
  });

  it('rolls the optimistic restore back on a network rejection and toasts the canonical copy', async () => {
    // Distinct from the API-error branch: the fetch throws (offline,
    // DNS, server unreachable) so the user-supplied message is absent
    // and the canonical German copy is the only signal.
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockRejectedValue(new Error('network down'));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    await waitFor(() => {
      const { hiddenByProject } = useAttachmentStore.getState();
      expect(hiddenByProject['p-42']?.some((a) => a.id === item.id)).toBe(true);
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe('Wiederherstellen fehlgeschlagen.');
    });
  });

  it('rolls the optimistic restore back BEFORE bouncing on a session-expired failure', async () => {
    // Regression: previously the session-expired branch returned to the
    // central handler WITHOUT undoing the optimistic move, leaving the
    // restored row in `byProject` under a now-stale cache. Spy on the
    // auth store's bounce action so we can observe the order.
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      category: 'authentication',
      sessionExpired: true,
    } as RestoreResult);

    // Replace handleSessionExpired with a spy so the cascading
    // downstream-state clear does not run inside this test.
    const bounce = vi.fn();
    useAuthStore.setState({ handleSessionExpired: bounce });

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    await waitFor(() => {
      expect(bounce).toHaveBeenCalledTimes(1);
    });

    // Maps must be back to their pre-click state — the row is in the
    // Papierkorb again, the live list is empty.
    const { hiddenByProject, byProject } = useAttachmentStore.getState();
    expect(hiddenByProject['p-42']?.some((a) => a.id === item.id)).toBe(true);
    expect(byProject['p-42']?.some((a) => a.id === item.id)).toBe(false);
    // Login redirect IS the user-facing signal — a duplicate error toast
    // would be noise, so suppress.
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
