/**
 * Calls the supplied handler when the user presses Escape, while the
 * `enabled` flag is true. Used by modals to close on Esc.
 *
 * Mirrors the pattern in `src/ui/common/ConfirmDialog.tsx` — a window-level
 * keydown listener. When the ConfirmDialog is open on top of this modal,
 * Esc is reserved for the dialog (the topmost interactive surface) and
 * the handler does not fire. This keeps Esc scoped to the topmost
 * dismissable surface when modals are stacked.
 */

import { useEffect } from 'react';

const CONFIRM_DIALOG_SELECTOR = '[data-testid="confirm-dialog"]';

export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Yield to a stacked ConfirmDialog: it owns Esc while it is open.
      if (document.querySelector(CONFIRM_DIALOG_SELECTOR)) return;
      e.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handler, enabled]);
}
