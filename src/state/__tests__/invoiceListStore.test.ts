/**
 * `invoiceListStore` — the `hasInitialized` lifecycle flag.
 *
 * The flag exists to distinguish two states that the previous
 * `initialLoad` boolean conflated:
 *   - (A) "never asked"  — `hasInitialized === false`, `loading === false`
 *   - (B) "asked, in flight" — `hasInitialized === false`, `loading === true`
 *   - (C) "settled at least once" — `hasInitialized === true`, forever
 *
 * The conflation mattered under SSE-during-initial-load: the empty-state
 * banner predicate must not flash between the first fetch settling and a
 * second SSE-triggered fetch beginning. The new predicate
 * (`hasInitialized && !loading && ordered.length === 0`) only goes true
 * once both have happened — and `hasInitialized` never flips back.
 *
 * `fetchMore` only runs after at least one successful fetch (the view's
 * `Load more` button is hidden until `total > invoices.length`), so it
 * must not touch `hasInitialized`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';
import type { Invoice } from '@/domain/invoice';

const invoicesListMock = vi.fn();

vi.mock('@/api/client', () => ({
  invoicesApi: {
    list: (...args: unknown[]) => invoicesListMock(...args),
  },
}));

vi.mock('./sessionExpired', () => ({
  handleSessionExpired: vi.fn(),
}));

const { useInvoiceListStore } = await import('@/state/invoiceListStore');

type ListResult = ApiResult<{ data: Invoice[]; total: number }>;

beforeEach(() => {
  invoicesListMock.mockReset();
  useInvoiceListStore.setState({
    filters: { year: null, status: null, search: '', projectId: null },
    invoices: [],
    total: 0,
    loading: false,
    error: null,
    hasInitialized: false,
  });
});

describe('invoiceListStore — hasInitialized lifecycle', () => {
  it('is false at mount (never-asked state)', () => {
    const s = useInvoiceListStore.getState();
    expect(s.hasInitialized).toBe(false);
    expect(s.loading).toBe(false);
  });

  it('stays false while the first fetch is in flight, flips true on success', async () => {
    let resolveFirst: (v: ListResult) => void;
    const firstPromise = new Promise<ListResult>((resolve) => {
      resolveFirst = resolve;
    });
    invoicesListMock.mockReturnValueOnce(firstPromise);

    const pending = useInvoiceListStore.getState().fetch();

    // In flight: loading is true, hasInitialized still false. The empty
    // banner predicate (hasInitialized && !loading && empty) is false →
    // no flicker.
    expect(useInvoiceListStore.getState().loading).toBe(true);
    expect(useInvoiceListStore.getState().hasInitialized).toBe(false);

    resolveFirst!({ ok: true, data: { data: [], total: 0 } });
    await pending;

    const after = useInvoiceListStore.getState();
    expect(after.loading).toBe(false);
    expect(after.hasInitialized).toBe(true);
    expect(after.invoices).toEqual([]);
    expect(after.total).toBe(0);
    expect(after.error).toBeNull();
  });

  it('flips hasInitialized to true on first-fetch error and surfaces the message', async () => {
    invoicesListMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'boom' },
      category: 'server_error',
      sessionExpired: false,
    } satisfies ListResult);

    await useInvoiceListStore.getState().fetch();

    const s = useInvoiceListStore.getState();
    expect(s.hasInitialized).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toBe('boom');
  });

  it('never flips back to false on subsequent fetches', async () => {
    invoicesListMock
      .mockResolvedValueOnce({ ok: true, data: { data: [], total: 0 } })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'transient' },
        category: 'server_error',
        sessionExpired: false,
      })
      .mockResolvedValueOnce({ ok: true, data: { data: [], total: 0 } });

    await useInvoiceListStore.getState().fetch();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);

    await useInvoiceListStore.getState().fetch();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);

    await useInvoiceListStore.getState().fetch();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);
  });

  it('SSE-during-initial-load — second fetch issued before first resolves keeps hasInitialized monotonic', async () => {
    // The exact F8 race: a `fetch()` is in flight (first page), an SSE
    // frame triggers a second `fetch()` before the first response arrives.
    // The window between the first response and the second `set({loading:true})`
    // must not leak a "never asked" reading.
    let resolveFirst: (v: ListResult) => void;
    let resolveSecond: (v: ListResult) => void;
    const firstPromise = new Promise<ListResult>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<ListResult>((resolve) => {
      resolveSecond = resolve;
    });
    invoicesListMock.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise);

    const first = useInvoiceListStore.getState().fetch();
    const second = useInvoiceListStore.getState().fetch();

    // Both in flight — neither has settled, hasInitialized still false.
    expect(useInvoiceListStore.getState().hasInitialized).toBe(false);
    expect(useInvoiceListStore.getState().loading).toBe(true);

    resolveFirst!({ ok: true, data: { data: [], total: 0 } });
    await first;

    // First settled — hasInitialized true. The second fetch is still in
    // flight (`loading: true` again after the first's set), so the empty
    // banner predicate (hasInitialized && !loading && empty) remains false.
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);

    resolveSecond!({ ok: true, data: { data: [], total: 0 } });
    await second;

    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);
    expect(useInvoiceListStore.getState().loading).toBe(false);
  });

  it('fetchMore does not touch hasInitialized', async () => {
    // Seed: at least one successful fetch must have happened for the view
    // to expose `Load more` at all. We assert that fetchMore() — success
    // or failure path — leaves hasInitialized exactly where the first
    // fetch left it.
    invoicesListMock.mockResolvedValueOnce({
      ok: true,
      data: { data: [{ id: 'inv-1' } as Invoice], total: 2 },
    });
    await useInvoiceListStore.getState().fetch();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);

    invoicesListMock.mockResolvedValueOnce({
      ok: true,
      data: { data: [{ id: 'inv-2' } as Invoice], total: 2 },
    });
    await useInvoiceListStore.getState().fetchMore();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);

    invoicesListMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'paginate-fail' },
      category: 'server_error',
      sessionExpired: false,
    });
    // fetchMore short-circuits when invoices.length >= total — flush
    // the total to keep the call live.
    useInvoiceListStore.setState({ total: 99 });
    await useInvoiceListStore.getState().fetchMore();
    expect(useInvoiceListStore.getState().hasInitialized).toBe(true);
  });
});
