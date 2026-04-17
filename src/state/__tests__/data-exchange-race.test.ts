/**
 * Race-condition regressions for useDataExchangeStore (ADR-0018).
 *
 * Two known races (Task C1):
 *   1. commit() does not guard on `importing`, so a double-click fires
 *      dataApi.import twice and the second response stomps the first.
 *   2. setFile() does not check `importing`, so picking a new file mid-commit
 *      clears envelope/preview while the in-flight commit still writes
 *      importResult — producing state that misrepresents which file was
 *      actually imported.
 *
 * These tests pin the target behavior: while `importing === true`, both
 * commit() and setFile() are no-ops. They are expected to FAIL against the
 * current (unguarded) store; they pass only once the guards land.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';
import type { DryRunPreview, Envelope, ImportResult } from '@/domain/dataExchange';
import { SCHEMA_VERSION } from '@/domain/dataExchange';

type ImportApiResult = ApiResult<ImportResult | DryRunPreview>;
type ExportApiResult = ApiResult<Envelope>;

const importMock = vi.fn<() => Promise<ImportApiResult>>();
const exportMock = vi.fn<() => Promise<ExportApiResult>>();

vi.mock('@/api/client', () => ({
  dataApi: {
    import: (...args: unknown[]) => importMock(...(args as Parameters<typeof importMock>)),
    export: (...args: unknown[]) => exportMock(...(args as Parameters<typeof exportMock>)),
  },
  // Other api namespaces are imported by sibling stores (projectStore,
  // customerStore). Their list/me calls must not explode if triggered
  // during the success path (commit() kicks off fetchProjects/fetchCustomers).
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: vi.fn(),
    logout: vi.fn(),
  },
  projectApi: {
    list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateDates: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
  },
  customerApi: {
    list: vi.fn().mockResolvedValue({ ok: true, data: { customers: [], total: 0 } }),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  userApi: { list: vi.fn() },
}));

const { useDataExchangeStore } = await import('@/state/dataExchangeStore');
const { useProjectStore } = await import('@/state/projectStore');
const { useCustomerStore } = await import('@/state/customerStore');

function makeEnvelope(): Envelope {
  return {
    schema_version: SCHEMA_VERSION,
    exported_at: '2026-04-15T12:00:00.000Z',
    customers: [],
    projects: [],
    project_workers: [],
  };
}

function makePreview(overrides: Partial<DryRunPreview> = {}): DryRunPreview {
  return {
    schema_version: SCHEMA_VERSION,
    target_non_empty: false,
    would_write: { customers: 0, projects: 0, project_workers: 0 },
    validation_errors: [],
    ...overrides,
  };
}

function makeImportResult(): ImportResult {
  return {
    schema_version: SCHEMA_VERSION,
    summary: { customers: 0, projects: 0, project_workers: 0 },
  };
}

function makeFile(name = 'envelope.json'): File {
  return new File(['{}'], name, { type: 'application/json' });
}

function resetDataExchangeStore() {
  useDataExchangeStore.setState({
    file: null,
    envelope: null,
    preview: null,
    previewError: null,
    phraseInput: '',
    importing: false,
    importResult: null,
    importError: null,
    exporting: false,
    exportError: null,
  });
}

describe('useDataExchangeStore — commit race guards', () => {
  beforeEach(() => {
    importMock.mockReset();
    exportMock.mockReset();
    resetDataExchangeStore();
    // Neutralize the post-commit refresh calls so they don't pull on the
    // (mocked) list APIs and mutate state mid-test.
    useProjectStore.setState({ fetchProjects: vi.fn(async () => {}) });
    useCustomerStore.setState({ fetchCustomers: vi.fn(async () => {}) });
  });

  it('commit() is a no-op while a commit is already importing', async () => {
    // Seed a valid preview so commit() is allowed to start.
    const envelope = makeEnvelope();
    const preview = makePreview();
    useDataExchangeStore.setState({
      file: makeFile(),
      envelope,
      preview,
      importing: false,
      importResult: null,
      importError: null,
    });

    // Controlled-defer: the first commit hangs on this promise until we
    // resolve it, which gives us a window to fire a second commit().
    // Fallback behavior for the second mock call is a benign success — the
    // test fails on the call-count assertion, but we don't want the current
    // (broken) code to produce an unhandled rejection that pollutes output.
    let resolveImport!: (v: ImportApiResult) => void;
    importMock
      .mockImplementationOnce(
        () =>
          new Promise<ImportApiResult>((r) => {
            resolveImport = r;
          }),
      )
      .mockResolvedValue({ ok: true, data: makeImportResult() });

    const first = useDataExchangeStore.getState().commit();

    // Call started: importing flipped true and the API saw exactly one hit.
    expect(useDataExchangeStore.getState().importing).toBe(true);
    expect(importMock).toHaveBeenCalledTimes(1);

    // Second click while the first is in flight. The guard must reject it.
    const second = useDataExchangeStore.getState().commit();

    expect(importMock).toHaveBeenCalledTimes(1);

    // Resolve the deferred first call and let both promises settle.
    resolveImport({ ok: true, data: makeImportResult() });
    await first;
    await second;

    const state = useDataExchangeStore.getState();
    expect(importMock).toHaveBeenCalledTimes(1);
    expect(state.importing).toBe(false);
    expect(state.importResult).not.toBeNull();
    expect(state.importError).toBeNull();
    // The seeded file is still the one that was imported — no overwrite.
    expect(state.file).not.toBeNull();
    expect(state.envelope).toBe(envelope);
  });

  it('setFile() is a no-op while a commit is importing', async () => {
    const envelope = makeEnvelope();
    const preview = makePreview();
    const originalFile = makeFile('original.json');
    useDataExchangeStore.setState({
      file: originalFile,
      envelope,
      preview,
      importing: false,
    });

    let resolveImport!: (v: ImportApiResult) => void;
    importMock.mockImplementationOnce(
      () =>
        new Promise<ImportApiResult>((r) => {
          resolveImport = r;
        }),
    );

    const commitPromise = useDataExchangeStore.getState().commit();

    // Precondition for the race: commit is in flight, preview still populated.
    const mid = useDataExchangeStore.getState();
    expect(mid.importing).toBe(true);
    expect(mid.envelope).toBe(envelope);
    expect(mid.preview).toBe(preview);
    expect(mid.file).toBe(originalFile);

    // User picks a different file while the import is still running.
    const newFile = makeFile('different.json');
    await useDataExchangeStore.getState().setFile(newFile);

    // Guard target: nothing about the import-in-progress may change.
    const afterSetFile = useDataExchangeStore.getState();
    expect(afterSetFile.file).toBe(originalFile);
    expect(afterSetFile.envelope).toBe(envelope);
    expect(afterSetFile.preview).toBe(preview);
    expect(afterSetFile.importing).toBe(true);
    // The second file's parse must not have reached the dry-run endpoint.
    expect(importMock).toHaveBeenCalledTimes(1);

    // Let the original commit finish and verify its result landed for the
    // original envelope (not silently overwritten by a second flow).
    resolveImport({ ok: true, data: makeImportResult() });
    await commitPromise;

    const final = useDataExchangeStore.getState();
    expect(final.importing).toBe(false);
    expect(final.importResult).not.toBeNull();
    expect(final.envelope).toBe(envelope);
  });

  it('setFile(null) is also a no-op while a commit is importing', async () => {
    const envelope = makeEnvelope();
    const preview = makePreview();
    const originalFile = makeFile('original.json');
    useDataExchangeStore.setState({
      file: originalFile,
      envelope,
      preview,
      importing: false,
    });

    let resolveImport!: (v: ImportApiResult) => void;
    importMock.mockImplementationOnce(
      () =>
        new Promise<ImportApiResult>((r) => {
          resolveImport = r;
        }),
    );

    const commitPromise = useDataExchangeStore.getState().commit();

    expect(useDataExchangeStore.getState().importing).toBe(true);

    // User hits the "clear" action mid-commit.
    await useDataExchangeStore.getState().setFile(null);

    const mid = useDataExchangeStore.getState();
    expect(mid.file).toBe(originalFile);
    expect(mid.envelope).toBe(envelope);
    expect(mid.preview).toBe(preview);
    expect(mid.importing).toBe(true);

    // Clean up — resolve so the commit() promise settles for the runner.
    resolveImport({ ok: true, data: makeImportResult() });
    await commitPromise;
  });
});
