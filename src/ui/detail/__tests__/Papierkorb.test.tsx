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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // Pin the hiddenAt timestamp at exactly one hour ago so the German
    // relative-time formatter produces a deterministic string we can
    // assert against. The fixture's default uses a wall-clock-relative
    // timestamp computed at fixture-load time, which races a slow render.
    const item = makeHidden({
      hiddenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    listTrashMock.mockResolvedValue(ok({ data: [item] }));

    render(<Papierkorb projectId="p-42" />);

    expect(listTrashMock).toHaveBeenCalledWith('p-42');
    await waitFor(() => {
      expect(screen.getByText(item.fileName)).toBeInTheDocument();
    });
    // Hidden-at label is the rendered relative-time string composed
    // through `STRINGS.attachments.hiddenAtLabel`. The pre-fix test
    // claimed to assert this in its name but had no assertion at all
    // (T-TAUT).
    const row = screen.getByTestId(`papierkorb-row-${item.id}`);
    expect(row).toHaveTextContent('vor 1 Stunde gelöscht');
    // Restore button visible on the row, named per the German strings.
    expect(screen.getByTestId(`papierkorb-restore-${item.id}`)).toBeInTheDocument();
  });

  it('shows the empty-state copy when the trash is fetched-empty', async () => {
    listTrashMock.mockResolvedValue(ok({ data: [] }));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByText(/Keine gelöschten Dateien/)).toBeInTheDocument();
    });
    // The empty-state must be the explicit "fetched-empty" surface, not
    // the loading fallthrough — pre-fix the component rendered `null`
    // both during the initial fetch and on the empty result.
    expect(screen.getByTestId('papierkorb-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('papierkorb-loading')).not.toBeInTheDocument();
  });

  it('skips the mount-time fetch when the cache is already populated', async () => {
    // The page-level eager fetch fills `hiddenByProject` to drive the
    // tab-badge count; the tab component must not re-fetch when it
    // mounts. Pre-seed the store, render, and assert the API is never
    // called and the loading flash never renders.
    const item = makeHidden({});
    useAttachmentStore.setState({ hiddenByProject: { 'p-42': [item] } });

    render(<Papierkorb projectId="p-42" />);

    expect(screen.queryByTestId('papierkorb-loading')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });
    expect(listTrashMock).not.toHaveBeenCalled();
  });

  it('shows a loading surface before the trash fetch resolves', async () => {
    // Hold the fetch open so we can observe the loading state.
    let resolveList!: (value: ListResult) => void;
    listTrashMock.mockImplementation(
      () =>
        new Promise<ListResult>((resolve) => {
          resolveList = resolve;
        }),
    );

    render(<Papierkorb projectId="p-42" />);

    expect(screen.getByTestId('papierkorb-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('papierkorb-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('papierkorb-error')).not.toBeInTheDocument();

    // Resolve so the test runner does not hold the promise.
    resolveList(ok({ data: [] }));
    await waitFor(() => {
      expect(screen.getByTestId('papierkorb-empty')).toBeInTheDocument();
    });
  });

  it('shows an error banner with retry when the trash fetch fails', async () => {
    listTrashMock.mockRejectedValueOnce(new Error('network down'));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId('papierkorb-error')).toBeInTheDocument();
    });
    // The canonical German error string is the user-facing copy on a
    // bare network rejection.
    expect(screen.getByTestId('papierkorb-error')).toHaveTextContent(
      'Änderung fehlgeschlagen. Bitte erneut versuchen.',
    );
    // Retry button re-runs the fetch — wire the mock to succeed on the
    // second call.
    listTrashMock.mockResolvedValueOnce(ok({ data: [] }));
    await userEvent.click(screen.getByTestId('papierkorb-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('papierkorb-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('papierkorb-error')).not.toBeInTheDocument();
  });

  it('shows a forbidden banner when the trash fetch returns 403', async () => {
    // Tab is permission-gated upstream so this branch is defense-in-depth
    // for direct API calls by an unprivileged caller (e.g. a worker who
    // bookmarked the URL).
    listTrashMock.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_PERMITTED', message: 'Keine Berechtigung.' },
      category: 'authorization',
      sessionExpired: false,
    } as ListResult);

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId('papierkorb-forbidden')).toBeInTheDocument();
    });
    // No retry button — the user cannot recover from a permission denial.
    expect(screen.queryByTestId('papierkorb-retry')).not.toBeInTheDocument();
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

  it('surfaces the 422 data-integrity message verbatim and not the canonical fallback', async () => {
    // The store funnels every server-error branch through
    // `result.error.message || restoreFailed`, which works only because
    // the server picks the right copy per error category. A future
    // refactor that flattens 422 (Datenintegrität — version_id null on
    // a hidden row) and 409 (race-conflict — invalid input) into one
    // generic string would silently lose the distinction. Lock both
    // messages in here as they leave the API surface.
    const { STRINGS } = await import('@/config/strings');
    const integrityMessage = STRINGS.attachments.restoreMissingVersionId('att-1');
    const conflictMessage = STRINGS.errors.invalidInput;
    expect(integrityMessage).not.toBe(conflictMessage);

    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue({
      ok: false,
      error: { message: integrityMessage },
    } as RestoreResult);

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe(integrityMessage);
      expect(toasts[0].message).not.toBe(STRINGS.attachments.restoreFailed);
      expect(toasts[0].message).not.toBe(conflictMessage);
    });
  });

  it('surfaces the 409 race-conflict message verbatim and not the canonical fallback', async () => {
    // Mirror of the 422 test — a CAS-loss race (someone else hid the
    // row again, or it was never in `hidden` to begin with) surfaces
    // as `STRINGS.errors.invalidInput`. Asserting the exact string
    // (and that it differs from the integrity copy) catches a future
    // server-side change that collapses both into one error code.
    const { STRINGS } = await import('@/config/strings');
    const integrityMessage = STRINGS.attachments.restoreMissingVersionId('att-1');
    const conflictMessage = STRINGS.errors.invalidInput;

    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));
    restoreMock.mockResolvedValue({
      ok: false,
      error: { message: conflictMessage },
    } as RestoreResult);

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId(`papierkorb-restore-${item.id}`));

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe(conflictMessage);
      expect(toasts[0].message).not.toBe(STRINGS.attachments.restoreFailed);
      expect(toasts[0].message).not.toBe(integrityMessage);
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

  it('guards against a fast double-click — the second click is a no-op', async () => {
    // Without the pending-set guard, two synchronous click dispatches in
    // the same React tick (touchscreen double-tap, programmatic
    // re-dispatch) both reach the store before the optimistic move
    // unmounts the button. The store's `if (!target) return` is a
    // safety net but not a contract — make the no-double-POST behaviour
    // explicit at the component layer too.
    //
    // `fireEvent` is the right tool here: `userEvent.click` awaits state
    // settling between actions, which would unmount the button before
    // the second event fires. `fireEvent` dispatches synchronously, so
    // both clicks land on the still-mounted node.
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));

    let resolveRestore!: (value: RestoreResult) => void;
    restoreMock.mockImplementation(
      () =>
        new Promise<RestoreResult>((resolve) => {
          resolveRestore = resolve;
        }),
    );

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    const button = screen.getByTestId(`papierkorb-restore-${item.id}`);

    // Two synchronous click events — the second must NOT enqueue a
    // second restore. With the in-component guard, the state-update
    // from the first click and the `pending.has(att.id)` check both
    // reflect an in-flight call by the time the second click runs.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(restoreMock).toHaveBeenCalledTimes(1);

    // Resolve the restore so the test runner doesn't hold the promise.
    resolveRestore(ok({ ...item, status: 'ready', hiddenAt: null }));
    await waitFor(() => {
      expect(screen.queryByTestId(`papierkorb-row-${item.id}`)).not.toBeInTheDocument();
    });
  });

  it('renders Restore as not-busy and not-disabled before any click — sanity check', async () => {
    // The aria-busy + disabled attributes flip to `true` while a
    // restore is in flight (see the double-click guard test). The
    // optimistic move unmounts the row before that state is observable
    // to a real user across a full React commit, so the assertions
    // here are limited to the pre-click resting state — anything more
    // would test React's render scheduling rather than the component.
    const item = makeHidden({});
    listTrashMock.mockResolvedValue(ok({ data: [item] }));

    render(<Papierkorb projectId="p-42" />);

    await waitFor(() => {
      expect(screen.getByTestId(`papierkorb-row-${item.id}`)).toBeInTheDocument();
    });

    const button = screen.getByTestId(`papierkorb-restore-${item.id}`);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
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
