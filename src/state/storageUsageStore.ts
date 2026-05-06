/**
 * Shared subscription that powers the Footer storage badge
 * (ui/index.md §8.1.2) and the DatenView storage row
 * (ui/daten.md §8.11.3).
 *
 * Four refresh triggers, one fetch path:
 *   1. First subscriber mount — `subscribe()` triggers `getGlobal()`.
 *   2. `visibilitychange` → `visible` — refetch when the tab returns.
 *      Hidden alone is not a trigger; refreshing while the tab is
 *      hidden burns cycles for an off-screen UI nobody is reading.
 *   3. Post-mutation `refresh()` — orchestrators that move counter
 *      bytes invoke this after their successful path.
 *   4. `storage_usage_changed` SSE frame — cross-session invalidation
 *      from another browser/tab's mutation.
 *
 * Subscribers are reference-counted: the listeners (`visibilitychange`,
 * SSE) are attached on first subscribe and torn down on last
 * unsubscribe. A second subscriber joining a loaded store does NOT
 * trigger a refetch — Footer + DatenView mounted in the same render
 * pass produce a single network call.
 */

import { create } from 'zustand';
import { storageUsageApi, type StorageUsageDto } from '@/api/client';
import { STORAGE_USAGE_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

interface StorageUsageStore {
  data: StorageUsageDto | null;
  subscribe: () => () => void;
  refresh: () => Promise<void>;
  __resetForTests: () => void;
}

let subscriberCount = 0;
let visibilityHandler: (() => void) | null = null;
let unsubscribeSse: (() => void) | null = null;
// In-flight epoch — every refetch() captures a snapshot before
// awaiting and only commits its result if no newer call has started
// in the meantime. A burst of triggers (mount + visibilitychange +
// SSE arriving in the same tick) issues N parallel GETs; without
// this gate the slowest response wins because `setState` blindly
// overwrites with whichever promise resolves last.
let refetchEpoch = 0;

async function refetch(): Promise<void> {
  const epoch = ++refetchEpoch;
  const result = await storageUsageApi.getGlobal();
  if (epoch !== refetchEpoch) return;
  if (result.ok) {
    useStorageUsageStore.setState({ data: result.data });
  }
}

function attachListeners(): void {
  visibilityHandler = (): void => {
    if (document.visibilityState === 'visible') {
      void refetch();
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  unsubscribeSse = onSseEvent(STORAGE_USAGE_CHANGED, () => {
    void refetch();
  });
}

function detachListeners(): void {
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (unsubscribeSse) {
    unsubscribeSse();
    unsubscribeSse = null;
  }
}

export const useStorageUsageStore = create<StorageUsageStore>((set) => ({
  data: null,

  subscribe: () => {
    subscriberCount += 1;
    if (subscriberCount === 1) {
      attachListeners();
      void refetch();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount === 0) {
        detachListeners();
      }
    };
  },

  refresh: async () => {
    await refetch();
  },

  __resetForTests: () => {
    detachListeners();
    subscriberCount = 0;
    refetchEpoch = 0;
    set({ data: null });
  },
}));
