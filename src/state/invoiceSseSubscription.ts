/**
 * Cross-cutting subscription that refreshes every invoice store on
 * every `invoice_changed` SSE frame (api.md §14.2.13, ADR-0026).
 *
 * Three stores ride this channel:
 *   - `useInvoiceStore` — per-project cache, keyed by `projectId`. The
 *     SSE event carries no payload (architecture.md §11.13 —
 *     invalidation hint only), so the handler refreshes every project
 *     the user has already loaded.
 *   - `useInvoiceListStore` — cross-project list view. Refreshed only
 *     once an entry exists (`hasInitialized === true` — the user has
 *     visited `/rechnungen` at least once); skipping the initial fetch
 *     keeps an idle login from issuing a list query the user hasn't
 *     asked for.
 *   - `useInvoiceDetailStore` — per-id viewer cache (ui/invoices.md
 *     §8.16.5). Every id the user has already loaded gets refetched;
 *     an open `Stornorechnung` confirmation dialog is NOT closed by
 *     this refresh — the dialog component owns its own open state and
 *     is unaffected by store data updates.
 *
 * Auth lifetime is the correct boundary; the auth-gated `useEffect`
 * in `App.tsx` is the only correct entry point (same reasoning as
 * `projectSseSubscription.ts`).
 */

import { useInvoiceStore } from './invoiceStore';
import { useInvoiceListStore } from './invoiceListStore';
import { useInvoiceDetailStore } from './invoiceDetailStore';
import { INVOICE_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

export function subscribeInvoiceStoreToSse(): () => void {
  return onSseEvent(INVOICE_CHANGED, () => {
    const projectIds = Object.keys(useInvoiceStore.getState().byProject);
    for (const projectId of projectIds) {
      void useInvoiceStore.getState().fetchByProject(projectId);
    }
    if (useInvoiceListStore.getState().hasInitialized) {
      void useInvoiceListStore.getState().fetch();
    }
    useInvoiceDetailStore.getState().refreshAll();
  });
}
