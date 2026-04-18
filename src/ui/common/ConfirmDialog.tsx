/**
 * Accessible confirmation dialog. Mounted once at the App root; controlled
 * by `useConfirmStore`. See state/confirmStore.ts for the imperative API.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true"
 *   - aria-labelledby points at the title (the label, not the description)
 *   - aria-describedby points at the message
 *   - Escape key cancels
 *   - Initial focus on the confirm button (consistent with browser confirm())
 *   - Focus trap: Tab/Shift-Tab cycle inside the dialog only
 *   - Focus restoration: the element focused before the dialog opened is
 *     restored when it closes
 *   - Body scroll lock: page behind the dialog cannot scroll while open
 */

import { useEffect, useRef } from 'react';
import { useConfirmStore } from '@/state/confirmStore';
import styles from './ConfirmDialog.module.css';

const TITLE_ID = 'confirm-dialog-title';
const MESSAGE_ID = 'confirm-dialog-message';

export function ConfirmDialog() {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const title = useConfirmStore((s) => s.title);
  const message = useConfirmStore((s) => s.message);
  const confirmLabel = useConfirmStore((s) => s.confirmLabel);
  const cancelLabel = useConfirmStore((s) => s.cancelLabel);
  const resolve = useConfirmStore((s) => s.resolve);

  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Element focused before the dialog opened. Restored on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Save the currently focused element so we can restore it on close.
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Lock body scroll while the modal is open. Save the previous value so
    // we restore it instead of forcing 'auto' (which would clobber any
    // upstream `overflow: hidden`).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Initial focus on the confirm button.
    confirmBtnRef.current?.focus();

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(false);
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap: Tab/Shift-Tab cycle within the dialog.
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !dialogRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialogRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Restore focus to the element that had it before the dialog opened.
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [isOpen, resolve]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} data-testid="confirm-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={MESSAGE_ID}
        data-testid="confirm-dialog"
      >
        <h2 id={TITLE_ID} className={styles.title}>
          {title}
        </h2>
        <p id={MESSAGE_ID} className={styles.message}>
          {message}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.button} ${styles.cancel}`}
            onClick={() => resolve(false)}
            data-testid="confirm-cancel"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={() => resolve(true)}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
