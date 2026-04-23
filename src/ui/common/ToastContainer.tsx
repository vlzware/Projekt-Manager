/**
 * Toast container — renders short-lived status messages from
 * `useToastStore`. Mounted once at the App root so every route can fire
 * toasts without per-route wiring.
 *
 * Positioning: fixed bottom-center on mobile (touch targets stay close
 * to the thumb), top-right on desktop (does not overlap primary actions
 * and mirrors common desktop conventions).
 *
 * Accessibility: each toast is `role="status"` with `aria-live="polite"`
 * so screen readers announce the message without pre-empting whatever
 * the user is currently reading.
 */

import { useToastStore } from '@/state/toastStore';
import { STRINGS } from '@/config/strings';
import styles from './ToastContainer.module.css';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container} aria-live="polite" data-testid="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${styles[t.kind] ?? ''}`}
          role="status"
          data-testid={`toast-${t.kind}`}
        >
          <span className={styles.message}>{t.message}</span>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={() => dismiss(t.id)}
            aria-label={STRINGS.ui.close}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
