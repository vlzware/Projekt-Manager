/**
 * Cross-cutting subscription that refreshes the invoice store on every
 * `invoice_changed` SSE frame (api.md §14.2.13, ADR-0026).
 *
 * Why a dedicated module rather than a `subscribe()` on `useInvoiceStore`:
 *   - The store is keyed by `projectId`. The SSE event carries no
 *     payload (architecture.md §11.13 — invalidation hint only), so the
 *     handler must refresh every project the user has already loaded.
 *   - Auth lifetime is the correct boundary; the auth-gated `useEffect`
 *     in `App.tsx` is the only correct entry point (same reasoning as
 *     `projectSseSubscription.ts`).
 */

import { useInvoiceStore } from './invoiceStore';
import { INVOICE_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

export function subscribeInvoiceStoreToSse(): () => void {
  return onSseEvent(INVOICE_CHANGED, () => {
    const projectIds = Object.keys(useInvoiceStore.getState().byProject);
    for (const projectId of projectIds) {
      void useInvoiceStore.getState().fetchByProject(projectId);
    }
  });
}
