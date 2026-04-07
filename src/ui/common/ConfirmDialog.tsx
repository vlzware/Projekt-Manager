/**
 * Accessible confirmation dialog. Mounted once at the App root; controlled
 * by `useConfirmStore`. See state/confirmStore.ts for the imperative API.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true"
 *   - aria-describedby points at the message
 *   - Escape key cancels
 *   - Click on backdrop cancels
 *   - Initial focus on the confirm button (consistent with browser confirm())
 */

import { useEffect, useRef } from 'react';
import { useConfirmStore } from '@/state/confirmStore';
import styles from './ConfirmDialog.module.css';

export function ConfirmDialog() {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const message = useConfirmStore((s) => s.message);
  const confirmLabel = useConfirmStore((s) => s.confirmLabel);
  const cancelLabel = useConfirmStore((s) => s.cancelLabel);
  const resolve = useConfirmStore((s) => s.resolve);

  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    confirmBtnRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, resolve]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={() => resolve(false)} data-testid="confirm-overlay">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-describedby="confirm-dialog-message"
        onClick={(e) => e.stopPropagation()}
        data-testid="confirm-dialog"
      >
        <p id="confirm-dialog-message" className={styles.message}>
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
