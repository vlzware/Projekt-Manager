/**
 * Toast notification store.
 *
 * Short-lived status surface for events the user initiated but whose
 * outcome is easy to miss in the inline banner flow — the canonical
 * example is an upload that succeeded/failed while the user had
 * scrolled past the UploadCta. Toasts overlay the viewport so they
 * stay visible regardless of scroll position.
 *
 * Lifecycle: `show()` appends a toast and starts an auto-dismiss timer.
 * `dismiss(id)` removes it immediately (user close). Durations are
 * per-kind defaults — callers can override for sticky surfaces.
 *
 * Inline banners (UploadCta, management error boxes) still own the
 * detailed failure surface; toasts are the "did my action land?"
 * signal.
 */

import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  show: (kind: ToastKind, message: string, options?: { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  error: 6000,
};

function newToastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'toast-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (kind, message, options) => {
    const id = newToastId();
    const duration = options?.durationMs ?? DEFAULT_DURATION_MS[kind];
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (duration > 0) {
      setTimeout(() => {
        get().dismiss(id);
      }, duration);
    }
    return id;
  },

  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
