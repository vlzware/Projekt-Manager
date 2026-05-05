/**
 * Vollständiger Export dialog — pre-flight → progress → post-export
 * summary (ui/daten.md §8.11.1, AC-249/AC-251).
 *
 * Three phases:
 *   1. preflight  — server-computed `totalCount` + `totalSizeBytes`
 *                   readout. Below the mobile-warning breakpoint a
 *                   non-blocking warning copy is rendered. Confirm
 *                   starts the export; Escape / Cancel closes the
 *                   dialog.
 *   2. progress   — drains descriptor pages in cursor order with
 *                   bounded retry on URL expiry, feeds the helper a
 *                   pre-flattened iterable so the helper stays a pure
 *                   stream-zip assembler. Cancel closes the dialog
 *                   immediately, aborts the in-flight ciphertext
 *                   fetch, and unregisters the SW-side registry entry
 *                   (AC-249: any partially-written download is the
 *                   user's to discard).
 *   3. summary    — resulting filename + cumulative skipped-row count.
 *
 * The orchestration (state machine, fetch loop, served-ACK await,
 * identity-gated `finally`) lives in `useExportAllRunner`; the four
 * phase render branches live in `VollstaendigerExportDialog.views`.
 * This file is the dialog mount + a11y wiring.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import { useExportAllRunner } from './useExportAllRunner';
import {
  ErrorView,
  PreflightView,
  ProgressView,
  SummaryView,
} from './VollstaendigerExportDialog.views';
import styles from './VollstaendigerExportDialog.module.css';

interface VollstaendigerExportDialogProps {
  /** Whether the dialog is mounted/open. */
  isOpen: boolean;
  /** Called when the user closes the dialog (any phase). */
  onClose: () => void;
}

/**
 * One-shot probe of the mobile-warning breakpoint. Used as the lazy
 * initializer for `useState` so the first render already reflects the
 * viewport — no extra setState-in-effect cascade. SSR-safe: returns
 * false when `window` is unavailable, matching the no-warning default.
 */
function probeIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`)
    .matches;
}

export function VollstaendigerExportDialog({ isOpen, onClose }: VollstaendigerExportDialogProps) {
  const [isMobile, setIsMobile] = useState<boolean>(probeIsMobile);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  const { phase, start, cancel } = useExportAllRunner({ isOpen });

  // --- Mobile-warning breakpoint detection ---------------------------
  // matchMedia is the canonical pattern for breakpoint reactivity;
  // re-evaluates on viewport resize so the warning appears/disappears
  // mirroring CSS media-query behavior. The E2E test resizes BEFORE
  // opening the dialog, so a one-shot read at open-time would suffice —
  // matchMedia is added for robustness against future viewport changes
  // mid-session. The initial value is supplied via `useState`'s lazy
  // initializer (`probeIsMobile`); the effect only wires the resize
  // handler so we don't trip the no-cascading-setState lint rule.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(
      `(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`,
    );
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const handleClose = useCallback(() => {
    cancel();
    onClose();
  }, [cancel, onClose]);

  // Modal a11y — focus trap, focus restoration, body scroll lock.
  // Escape closes only on preflight / summary / error: the progress
  // phase intentionally requires the user-visible "Abbrechen" press
  // so the partial-download contract is unambiguous.
  const escapeAllowed =
    phase.kind === 'preflight' || phase.kind === 'summary' || phase.kind === 'error';
  useDialogA11y({
    isOpen,
    dialogRef,
    onOpenedFocus: useCallback(() => initialFocusRef.current?.focus(), []),
    onEscape: escapeAllowed ? handleClose : undefined,
  });

  if (!isOpen) return null;

  if (phase.kind === 'closed') {
    // isOpen=true but phase=closed means we're between mount and the
    // first preflight fetch — render an empty overlay so the dialog
    // mount doesn't pop in/out.
    return <div className={styles.overlay} data-testid="export-all-loading" />;
  }

  if (phase.kind === 'preflight') {
    return (
      <PreflightView
        phase={phase}
        isMobile={isMobile}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusRef}
        onCancel={handleClose}
        onConfirm={() => start(phase)}
      />
    );
  }

  if (phase.kind === 'progress') {
    return (
      <ProgressView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusRef}
        onCancel={handleClose}
      />
    );
  }

  if (phase.kind === 'summary') {
    return (
      <SummaryView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusRef}
        onClose={handleClose}
      />
    );
  }

  // phase.kind === 'error'
  return (
    <ErrorView
      phase={phase}
      dialogRef={dialogRef}
      initialFocusRef={initialFocusRef}
      onClose={handleClose}
    />
  );
}
