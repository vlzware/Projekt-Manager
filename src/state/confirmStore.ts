/**
 * Confirmation dialog store.
 *
 * Replaces `window.confirm()` with a styled, accessible modal.
 *
 * Pattern: imperative request → Promise<boolean>. The caller awaits a
 * boolean instead of receiving JSX. The actual <ConfirmDialog /> is mounted
 * once at the App root and reads its state from this store.
 *
 * Usage:
 *   const confirmed = await useConfirmStore.getState().request('Sicher?');
 *   if (confirmed) { ... }
 */

import { create } from 'zustand';

interface ConfirmState {
  isOpen: boolean;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  resolver: ((answer: boolean) => void) | null;

  request: (
    message: string,
    options?: { confirmLabel?: string; cancelLabel?: string },
  ) => Promise<boolean>;
  resolve: (answer: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  isOpen: false,
  message: '',
  confirmLabel: 'OK',
  cancelLabel: 'Abbrechen',
  resolver: null,

  request: (message, options = {}) => {
    // If a previous request is still open, resolve it as cancelled to avoid
    // dangling promises and double-modal state.
    const previous = get().resolver;
    if (previous) previous(false);

    return new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        message,
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Abbrechen',
        resolver: resolve,
      });
    });
  },

  resolve: (answer) => {
    const { resolver } = get();
    if (resolver) resolver(answer);
    set({
      isOpen: false,
      message: '',
      resolver: null,
    });
  },
}));
