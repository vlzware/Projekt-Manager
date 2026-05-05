/**
 * Vollständiger Import dialog — file picker → preflight → progress →
 * summary (ui/daten.md §8.11.4, AC-259/AC-260).
 *
 * Five phases:
 *   1. awaiting-file — user picks the takeout zip from the file picker.
 *   2. preflight     — parsed envelope-counts readout + (when target
 *                      non-empty) destructive-action confirmation
 *                      phrase input. Confirm dispatches the text-leg
 *                      and per-attachment legs.
 *   3. progress      — files-done / total + bytes-done / total + current
 *                      filename + Abbrechen action.
 *   4. summary       — restored counts + per-file failure list.
 *   5. error         — pre-flight or text-leg rejection surfaces here.
 *
 * Orchestration (state machine, zip parse, dry-run, orchestrator
 * dispatch) lives in `useImportAllRunner`; phase render branches live
 * in `VollstaendigerImportDialog.views`. This file is the dialog mount
 * + a11y wiring.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import { useImportAllRunner } from './useImportAllRunner';
import {
  AwaitingFileView,
  ErrorView,
  PreflightView,
  ProgressView,
  SummaryView,
} from './VollstaendigerImportDialog.views';
import styles from './VollstaendigerImportDialog.module.css';

interface VollstaendigerImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function probeIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`)
    .matches;
}

export function VollstaendigerImportDialog({ isOpen, onClose }: VollstaendigerImportDialogProps) {
  const [isMobile, setIsMobile] = useState<boolean>(probeIsMobile);
  const [phraseInput, setPhraseInput] = useState<string>('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusButtonRef = useRef<HTMLButtonElement>(null);
  const initialFocusInputRef = useRef<HTMLInputElement>(null);

  const { phase, pickFile, start, cancel } = useImportAllRunner({ isOpen });

  // The phrase input is local mount state — the parent conditionally
  // mounts this dialog on each open, so leftover input from a prior
  // session unmounts implicitly. No reset-on-prop-change effect needed
  // (those trip react-hooks/set-state-in-effect for the right reason —
  // such effects cascade an extra render and obscure the lifecycle).

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

  const escapeAllowed =
    phase.kind === 'awaiting-file' ||
    phase.kind === 'preflight' ||
    phase.kind === 'summary' ||
    phase.kind === 'error';
  useDialogA11y({
    isOpen,
    dialogRef,
    onOpenedFocus: useCallback(() => {
      // Pick the right initial-focus target per phase. Avoids a stale
      // ref grab when the dialog mounts in awaiting-file but we ref
      // the preflight confirm button in the props.
      if (phase.kind === 'awaiting-file') initialFocusInputRef.current?.focus();
      else initialFocusButtonRef.current?.focus();
    }, [phase.kind]),
    onEscape: escapeAllowed ? handleClose : undefined,
  });

  if (!isOpen) return null;

  if (phase.kind === 'closed') {
    return <div className={styles.overlay} data-testid="import-all-loading" />;
  }

  if (phase.kind === 'awaiting-file') {
    return (
      <AwaitingFileView
        dialogRef={dialogRef}
        initialFocusRef={initialFocusInputRef}
        onFile={(file) => void pickFile(file)}
        onCancel={handleClose}
      />
    );
  }

  if (phase.kind === 'preflight') {
    return (
      <PreflightView
        phase={phase}
        isMobile={isMobile}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        phraseInput={phraseInput}
        onPhraseInputChange={setPhraseInput}
        onCancel={handleClose}
        onConfirm={() => start(phraseInput)}
      />
    );
  }

  if (phase.kind === 'progress') {
    return (
      <ProgressView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        onCancel={handleClose}
      />
    );
  }

  if (phase.kind === 'summary') {
    return (
      <SummaryView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        onClose={handleClose}
      />
    );
  }

  // phase.kind === 'error'
  return (
    <ErrorView
      phase={phase}
      dialogRef={dialogRef}
      initialFocusRef={initialFocusButtonRef}
      onClose={handleClose}
    />
  );
}
