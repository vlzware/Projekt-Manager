/**
 * Vollständiger Export dialog — pre-flight → progress → post-export
 * summary (ui/daten.md §8.11.3, AC-249/AC-251).
 *
 * Three phases:
 *   1. preflight  — server-computed `totalCount` + `totalSizeBytes`
 *                   readout (single up-front, no growing-under-the-user
 *                   behavior). Below the mobile-warning breakpoint a
 *                   non-blocking warning copy is rendered. Confirm starts
 *                   the export; Escape / Cancel closes the dialog.
 *   2. progress   — drains descriptor pages in cursor order, pre-fetches
 *                   ciphertext per entry with bounded retry on URL expiry,
 *                   feeds `assembleExportAllZip` an iterable that has
 *                   already resolved every per-file failure into either
 *                   "yields a fetchable descriptor" or "yields a
 *                   DEK_UNWRAP_FAILED-tagged descriptor (skipped)". Cancel
 *                   closes the dialog immediately, aborts the in-flight
 *                   ciphertext fetch, and unregisters the SW-side
 *                   registry entry if cancel beat the iframe arrival; if
 *                   the SW is already serving the partial archive that
 *                   flow runs to completion at the browser level (the
 *                   user's download manager will show a partial file —
 *                   AC-249: "Any partially-written download is the
 *                   user's to discard").
 *   3. summary    — resulting filename + cumulative skipped-row count.
 *                   "X Dateien übersprungen" surfaces whenever the
 *                   cumulative count is ≥ 1, regardless of skip cause.
 *
 * Per-file failure handling lives in this component (not the helper) so
 * the helper stays a pure stream-zip assembler. The bounded retry is
 * single-shot per AC-251: one re-fetch of the affected descriptor page
 * on a 403 (canonical S3-expiry surface); a second 403 logs and skips.
 * Storage 4xx (other than 403) and 5xx + network errors log and skip
 * without retrying.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { formatDateOnly } from '@/domain/dateFormat';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import {
  assembleExportAllZip,
  type BinaryDescriptor,
  type DescriptorPage,
  type ExportEnvelope,
} from './exportAllAsZip';
import { streamingDownload, unregisterStreamingDownload } from './streamingDownload';
import styles from './VollstaendigerExportDialog.module.css';

const PRELOAD_PAGE_LIMIT = ATTACHMENT_CONFIG.exportAllPerPageDefault;

/**
 * Discriminated union over the dialog's lifecycle phases. The `kind`
 * tag is the discriminator — `phase.kind === 'preflight'` narrows
 * `phase` to the `PreflightPhase` shape inside the branch.
 */
type DialogPhase = { kind: 'closed' } | PreflightPhase | ProgressPhase | SummaryPhase | ErrorPhase;

interface PreflightPhase {
  kind: 'preflight';
  envelope: ExportEnvelope;
  firstPage: DescriptorPage;
}

interface ProgressPhase {
  kind: 'progress';
  totalCount: number;
  totalSizeBytes: number;
  filesDone: number;
  bytesDone: number;
  currentFile: string;
}

interface SummaryPhase {
  kind: 'summary';
  filename: string;
  skippedCount: number;
}

interface ErrorPhase {
  kind: 'error';
  message: string;
}

interface VollstaendigerExportDialogProps {
  /** Whether the dialog is mounted/open. */
  isOpen: boolean;
  /** Called when the user closes the dialog (any phase). */
  onClose: () => void;
}

/**
 * Format a byte count for human display. Decimal SI (KB/MB) — matches
 * what download UIs typically render (Chrome, Firefox both surface
 * decimal byte counts in their downloads UI). Two decimal places at the
 * MB+ tier; integer at B/KB.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Local-time timestamp for the export filename. Mirrors the
 * `fileTimestamp` helper in `dataExchangeStore.ts`; consolidation of
 * the two copies (and the BinaryList `triggerDownload`) is tracked in
 * issue #164.
 */
function exportTimestamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${formatDateOnly(d)}T${hh}-${mm}-${ss}`;
}

/**
 * Fetch a single descriptor page from the server. Caller passes the
 * `after` cursor (`null` for the first page) and an `AbortSignal` so the
 * fetch participates in the dialog's cancel flow.
 */
async function fetchDescriptorPage(
  cursor: string | null,
  signal: AbortSignal,
): Promise<DescriptorPage> {
  const params = new URLSearchParams();
  params.set('limit', String(PRELOAD_PAGE_LIMIT));
  if (cursor !== null) params.set('after', cursor);
  const qs = params.toString();
  const res = await fetch(`/api/export/binary-descriptors${qs ? '?' + qs : ''}`, {
    signal,
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`descriptor fetch failed: status=${res.status}`);
  return (await res.json()) as DescriptorPage;
}

/**
 * Fetch the unified envelope (`GET /api/export`) for the data.json entry.
 */
async function fetchEnvelope(signal: AbortSignal): Promise<ExportEnvelope> {
  const res = await fetch('/api/export', { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`envelope fetch failed: status=${res.status}`);
  return (await res.json()) as ExportEnvelope;
}

/**
 * Sentinel marker used inside the descriptor-prep iterable to flag
 * entries that should be skipped in the helper. The helper already
 * skips entries with `error: 'DEK_UNWRAP_FAILED'`; we re-tag fetch-
 * failed entries with the same discriminator so the helper's existing
 * branch handles them — no helper changes needed.
 */
function tagAsSkipped(d: BinaryDescriptor): BinaryDescriptor {
  return { ...d, error: 'DEK_UNWRAP_FAILED' };
}

export function VollstaendigerExportDialog({ isOpen, onClose }: VollstaendigerExportDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'closed' });
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  // Active streaming-download key while the helper is awaiting the
  // SW's served-ACK. Set after `streamingDownload` resolves with the
  // handle, cleared once the ACK arrives (success path) or in
  // `handleClose` after the unregister fires (cancel-before-serve).
  // Used by `handleClose` to drop the SW-side registry entry — without
  // this, a cancel between `postMessage` and the iframe fetch would
  // leak a one-shot entry until the next download attempt or page
  // reload.
  const pendingStreamingKeyRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  // --- Mobile-warning breakpoint detection ---------------------------
  // matchMedia is the canonical pattern for breakpoint reactivity;
  // re-evaluates on viewport resize so the warning appears/disappears
  // mirroring CSS media-query behavior. The E2E test resizes BEFORE
  // opening the dialog, so a one-shot read at open-time would suffice —
  // matchMedia is added for robustness against future viewport changes
  // mid-session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(
      `(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`,
    );
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // --- Open: load envelope + first descriptor page -------------------
  // Effect runs when `isOpen` flips to true. Re-runs reset the phase to
  // `preflight` (after fetch) so the same dialog can be re-opened across
  // multiple click cycles (the E2E spec exercises this in AC-249's three
  // arms — close, resize, re-open).
  useEffect(() => {
    if (!isOpen) {
      setPhase({ kind: 'closed' });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    (async () => {
      try {
        const [envelope, firstPage] = await Promise.all([
          fetchEnvelope(ctrl.signal),
          fetchDescriptorPage(null, ctrl.signal),
        ]);
        if (ctrl.signal.aborted) return;
        setPhase({ kind: 'preflight', envelope, firstPage });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.warn('[export-all] preflight failed', err);
        setPhase({ kind: 'error', message: STRINGS.dataExchange.exportAllError });
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [isOpen]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Cancel-before-serve: tell the SW to drop the one-shot registry
    // entry so it doesn't survive the dialog close. If the SW already
    // served the bytes, the entry is gone and `delete` on a missing
    // key is a no-op on the SW side. The helper's served-Promise is
    // resolved/rejected through the closed port — no extra plumbing
    // here, the abort/close flow tears down the stream regardless.
    const pendingKey = pendingStreamingKeyRef.current;
    if (pendingKey !== null) {
      unregisterStreamingDownload(pendingKey);
      pendingStreamingKeyRef.current = null;
    }
    setPhase({ kind: 'closed' });
    onClose();
  }, [onClose]);

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

  /**
   * Progress-phase handler. Walks descriptor pages, pre-fetches each
   * entry's ciphertext (with one bounded retry on 403), buffers the
   * bytes, and yields single-entry pages to `assembleExportAllZip`. The
   * helper consumes the iterable lazily; per-entry pre-fetch happens
   * just-in-time (no peak-memory blow-up at the page-size of 100).
   */
  const startExport = useCallback(async (preflightSnapshot: PreflightPhase) => {
    // Fresh abort controller for the export run — replaces the one
    // used during preflight (the preflight fetches are already
    // settled at this point). `ctrl` is captured in this closure and
    // doubles as the local identity the `finally` block compares
    // against `abortRef.current` before nulling. Without the identity
    // check the OLD run's unwind (e.g. after a 30s ACK timeout) would
    // null out a NEW run's controller that the user started in the
    // meantime, turning the new run's Cancel into a no-op.
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const totalCount = preflightSnapshot.firstPage.totalCount;
    const totalSizeBytes = preflightSnapshot.firstPage.totalSizeBytes;

    setPhase({
      kind: 'progress',
      totalCount,
      totalSizeBytes,
      filesDone: 0,
      bytesDone: 0,
      currentFile: '',
    });

    // Per-entry ciphertext cache, keyed on URL. The helper calls
    // `fetchCiphertext(url)` once per entry; we pre-fetched and
    // buffered bytes ahead of yielding, so the helper's call is a
    // synchronous Map lookup wrapped in a Promise.
    const ciphertextByUrl = new Map<string, Uint8Array>();

    let skippedCount = 0;
    let filesDone = 0;
    let bytesDone = 0;

    /**
     * Fetch ciphertext from a presigned URL. Returns the bytes on
     * success, the discriminator string `'EXPIRED_403'` on 403,
     * `'SKIP'` on any other 4xx/5xx or network error.
     */
    async function fetchCiphertextAttempt(
      url: string,
    ): Promise<Uint8Array | 'EXPIRED_403' | 'SKIP'> {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.status === 403) return 'EXPIRED_403';
        if (!res.ok) return 'SKIP';
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        return 'SKIP';
      }
    }

    // Generator that walks pages cursor-by-cursor and per-entry
    // pre-fetches ciphertext with a page-scoped bounded retry on URL
    // expiry. Yields single-entry pages so the helper's per-entry
    // stream-zip cadence is preserved.
    //
    // Bounded-retry semantics (AC-251 / ui/daten.md §8.11.3 step 4):
    // The "ONE re-fetch of the affected descriptor page" is per
    // page, not per entry. Once the page has been re-fetched, every
    // entry in that page that still 403s is skipped without another
    // re-fetch — the second re-fetch is what "logged and skipped on
    // a second expiry" means. This matches the descriptorCallCount
    // contract pinned by the AC-251 E2E (initial + one re-fetch per
    // page = two calls for a single-page export).
    async function* preparedPages(): AsyncIterable<DescriptorPage> {
      let currentPage: DescriptorPage = preflightSnapshot.firstPage;
      let cursor: string | null = null;
      // Per-page guard: flips to true on the first page re-fetch.
      // Reset to false on every page transition (cursor advance).
      let pageRefetched = false;

      while (true) {
        for (let i = 0; i < currentPage.entries.length; i++) {
          if (ctrl.signal.aborted) return;
          const entry = currentPage.entries[i]!;

          // Surface the current file in the progress dialog before
          // any fetch — even skipped entries display their name as
          // they pass through the pipeline.
          setPhase((prev) => {
            if (prev.kind !== 'progress') return prev;
            return { ...prev, currentFile: entry.fileName };
          });

          // (a) DEK_UNWRAP_FAILED — yield as-is, helper skips.
          if (entry.error === 'DEK_UNWRAP_FAILED') {
            skippedCount += 1;
            console.warn('[export-all] skipping entry: DEK unwrap failed', {
              attachmentId: entry.attachmentId,
            });
            yield { ...currentPage, entries: [entry] };
            continue;
          }

          if (!entry.originalUrl || !entry.originalDekMaterial) {
            skippedCount += 1;
            console.warn('[export-all] skipping entry: incomplete descriptor', {
              attachmentId: entry.attachmentId,
            });
            yield { ...currentPage, entries: [tagAsSkipped(entry)] };
            continue;
          }

          // First fetch attempt against the URL we already hold.
          let result = await fetchCiphertextAttempt(entry.originalUrl);

          // (b/c) URL expired — page-scoped re-fetch path.
          if (result === 'EXPIRED_403') {
            if (pageRefetched) {
              // Page already re-fetched once; the re-issued URL is
              // ALSO expired. Skip without another descriptor call —
              // the bounded-retry budget is exhausted for this page.
              skippedCount += 1;
              console.warn('[export-all] skipping entry: URL expired post-retry', {
                attachmentId: entry.attachmentId,
              });
              yield { ...currentPage, entries: [tagAsSkipped(entry)] };
              continue;
            }

            console.warn('[export-all] presigned URL expired, re-fetching page', {
              attachmentId: entry.attachmentId,
            });
            try {
              currentPage = await fetchDescriptorPage(cursor, ctrl.signal);
            } catch (err) {
              if (ctrl.signal.aborted) return;
              // Page re-fetch itself failed — treat the entry as
              // skipped. Subsequent entries from this page get the
              // same treatment because pageRefetched stays false but
              // the network is clearly compromised; falling through
              // is acceptable (next entry will likely also 403).
              console.warn('[export-all] page re-fetch failed', err);
              skippedCount += 1;
              yield { ...currentPage, entries: [tagAsSkipped(entry)] };
              continue;
            }
            pageRefetched = true;

            // Locate the same attachment by id in the refreshed page
            // — ordering is cursor-stable (AC-248) but match by id
            // defensively.
            const refreshed = currentPage.entries.find(
              (e) => e.attachmentId === entry.attachmentId,
            );
            if (!refreshed || !refreshed.originalUrl) {
              skippedCount += 1;
              console.warn('[export-all] entry vanished from refreshed page', {
                attachmentId: entry.attachmentId,
              });
              yield { ...currentPage, entries: [tagAsSkipped(entry)] };
              continue;
            }
            result = await fetchCiphertextAttempt(refreshed.originalUrl);
            if (result === 'EXPIRED_403' || result === 'SKIP') {
              skippedCount += 1;
              console.warn('[export-all] skipping entry: URL still failing after retry', {
                attachmentId: entry.attachmentId,
                resultMarker: result,
              });
              yield { ...currentPage, entries: [tagAsSkipped(refreshed)] };
              continue;
            }
            ciphertextByUrl.set(refreshed.originalUrl, result);
            filesDone += 1;
            bytesDone += refreshed.sizeBytes;
            setPhase((prev) => {
              if (prev.kind !== 'progress') return prev;
              return { ...prev, filesDone, bytesDone };
            });
            yield { ...currentPage, entries: [refreshed] };
            continue;
          }

          // (d) 5xx / 4xx (non-403) / network error → skip.
          if (result === 'SKIP') {
            skippedCount += 1;
            console.warn('[export-all] skipping entry: ciphertext fetch failed', {
              attachmentId: entry.attachmentId,
            });
            yield { ...currentPage, entries: [tagAsSkipped(entry)] };
            continue;
          }

          // Successful fetch.
          ciphertextByUrl.set(entry.originalUrl, result);
          filesDone += 1;
          bytesDone += entry.sizeBytes;
          setPhase((prev) => {
            if (prev.kind !== 'progress') return prev;
            return { ...prev, filesDone, bytesDone };
          });
          yield { ...currentPage, entries: [entry] };
        }

        if (currentPage.nextCursor === null) break;
        cursor = currentPage.nextCursor;
        // Reset the bounded-retry budget for the next page — the
        // re-fetch invariant is per page.
        pageRefetched = false;
        try {
          currentPage = await fetchDescriptorPage(cursor, ctrl.signal);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          console.warn('[export-all] descriptor page fetch failed', err);
          return;
        }
      }
    }

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      const cached = ciphertextByUrl.get(url);
      if (cached) {
        // Drain after consumption: the helper calls fetchCiphertext at
        // most once per URL (one yielded entry per pre-fetch), so the
        // bytes are no longer needed once handed to the assembler. Cap
        // peak memory at one in-flight ciphertext.
        ciphertextByUrl.delete(url);
        return cached;
      }
      // The helper called for a URL we never pre-fetched — defensive
      // throw rather than silently returning empty bytes. This should
      // not happen given the iterable contract.
      throw new Error(`export-all: ciphertext not pre-fetched for url=${url}`);
    };

    // Local key capture — set once `streamingDownload` resolves and
    // mirrors `pendingStreamingKeyRef.current`. The `finally` block
    // uses it for an identity check before nulling the global ref, so
    // a stale unwind (this run's `handle.served` rejecting after the
    // 30s timeout) cannot clobber a newer run's key that handleClose
    // would otherwise rely on.
    let localKey: string | null = null;
    try {
      const stream = assembleExportAllZip({
        envelope: preflightSnapshot.envelope,
        descriptorPages: preparedPages(),
        fetchCiphertext,
      });

      const filename = `projekt-manager-vollstaendiger-export-${exportTimestamp(new Date())}.zip`;

      // Tap the helper's stream so we know when it's fully drained.
      // `flush()` fires after the last chunk is pushed downstream — by
      // then the manifest entry has been emitted and the SW has
      // received every byte. We resolve `upstreamDone` there and use
      // it as a precondition for summary: the upstream pipe is what
      // signals "every byte the helper produced was enqueued". The
      // SW's served-ACK is the second precondition (it proves the
      // bytes actually reached the browser's download flow rather
      // than sitting in an evicted-SW registry entry).
      let resolveUpstreamDone: () => void;
      const upstreamDone = new Promise<void>((res) => {
        resolveUpstreamDone = res;
      });
      const tapped = stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush() {
            resolveUpstreamDone();
          },
        }),
      );

      // Hand the tapped stream to the SW, which intercepts the
      // synthetic-URL fetch and pipes bytes straight to the browser's
      // download flow — no whole-zip buffering. Pattern is the same as
      // Cryptomator Hub Web / Filen / ProtonDrive (`src/sw/streamingDownload.ts`).
      const handle = await streamingDownload({
        stream: tapped,
        filename,
        contentType: 'application/zip',
      });
      // Track the key so `handleClose` can unregister the SW-side
      // entry if the user cancels before the served-ACK arrives. The
      // local capture lets `finally` distinguish "this run's key" from
      // "a newer run that overwrote the global ref while we awaited".
      localKey = handle.key;
      pendingStreamingKeyRef.current = handle.key;

      // Wait for BOTH the upstream pipe to drain (helper emitted the
      // manifest, every byte enqueued into the transferred stream)
      // AND the SW's served-ACK (the bridge actually started serving
      // the iframe fetch). Without the served-ACK, an evicted SW
      // would leave the user with no file while the dialog cheerfully
      // promoted to "summary".
      await Promise.all([upstreamDone, handle.served]);

      if (ctrl.signal.aborted) return;

      setPhase({
        kind: 'summary',
        filename,
        skippedCount,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.warn('[export-all] zip assembly failed', err);
      setPhase({ kind: 'error', message: STRINGS.dataExchange.exportAllError });
    } finally {
      // Identity-gate the global-ref clears so a stale unwind of an
      // older run (e.g. its `handle.served` rejecting on the 30s
      // timeout long after handleClose) cannot clobber a newer run
      // that the user started in the meantime. Without these guards
      // the new run's Cancel becomes a no-op (no controller to abort)
      // and handleClose skips the unregister (no key to send).
      if (abortRef.current === ctrl) abortRef.current = null;
      if (localKey !== null && pendingStreamingKeyRef.current === localKey) {
        pendingStreamingKeyRef.current = null;
      }
    }
  }, []);

  if (!isOpen) return null;

  // ---- Render branches per phase ------------------------------------

  if (phase.kind === 'closed') {
    // isOpen=true but phase=closed means we're between mount and the
    // first preflight fetch — render an empty overlay so the dialog
    // mount doesn't pop in/out.
    return <div className={styles.overlay} data-testid="export-all-loading" />;
  }

  if (phase.kind === 'preflight') {
    return (
      <div className={styles.overlay} data-testid="export-all-overlay">
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-all-preflight-title"
          aria-describedby="export-all-preflight-body"
          data-testid="export-all-preflight"
        >
          <h2 id="export-all-preflight-title" className={styles.title}>
            {STRINGS.dataExchange.exportAllPreflightTitle}
          </h2>
          <div id="export-all-preflight-body" className={styles.body}>
            <div className={styles.readoutLine} data-testid="export-all-preflight-count">
              {STRINGS.dataExchange.exportAllPreflightCount(phase.firstPage.totalCount)}
            </div>
            <div
              className={styles.readoutLine}
              data-testid="export-all-preflight-size"
              data-bytes-total={phase.firstPage.totalSizeBytes}
            >
              {STRINGS.dataExchange.exportAllPreflightSize(
                formatBytes(phase.firstPage.totalSizeBytes),
              )}
            </div>
            {isMobile && (
              <div
                className={styles.mobileWarning}
                data-testid="export-all-preflight-mobile-warning"
                role="note"
              >
                {STRINGS.dataExchange.exportAllMobileWarning}
              </div>
            )}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.cancel}`}
              onClick={handleClose}
              data-testid="export-all-preflight-cancel"
            >
              {STRINGS.dataExchange.exportAllPreflightCancel}
            </button>
            <button
              ref={initialFocusRef}
              type="button"
              className={`${styles.button} ${styles.confirm}`}
              onClick={() => void startExport(phase)}
              data-testid="export-all-preflight-confirm"
            >
              {STRINGS.dataExchange.exportAllPreflightConfirm}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'progress') {
    return (
      <div className={styles.overlay} data-testid="export-all-overlay">
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-all-progress-title"
          aria-describedby="export-all-progress-body"
          data-testid="export-all-progress"
        >
          <h2 id="export-all-progress-title" className={styles.title}>
            {STRINGS.dataExchange.exportAllProgressTitle}
          </h2>
          <div id="export-all-progress-body" className={styles.body}>
            <div
              className={styles.readoutLine}
              data-testid="export-all-progress-counter"
              data-files-total={phase.totalCount}
              data-files-done={phase.filesDone}
            >
              {STRINGS.dataExchange.exportAllProgressCounter(phase.filesDone, phase.totalCount)}
            </div>
            <div
              className={styles.readoutLine}
              data-testid="export-all-progress-bytes"
              data-bytes-total={phase.totalSizeBytes}
              data-bytes-done={phase.bytesDone}
            >
              {STRINGS.dataExchange.exportAllProgressBytes(
                formatBytes(phase.bytesDone),
                formatBytes(phase.totalSizeBytes),
              )}
            </div>
            <div className={styles.currentFile} data-testid="export-all-progress-current-file">
              {STRINGS.dataExchange.exportAllProgressCurrentFile(phase.currentFile || '—')}
            </div>
          </div>
          <div className={styles.actions}>
            <button
              ref={initialFocusRef}
              type="button"
              className={`${styles.button} ${styles.cancel}`}
              onClick={handleClose}
              data-testid="export-all-cancel"
            >
              {STRINGS.dataExchange.exportAllCancel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'summary') {
    return (
      <div className={styles.overlay} data-testid="export-all-overlay">
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-all-summary-title"
          aria-describedby="export-all-summary-body"
          data-testid="export-all-summary"
        >
          <h2 id="export-all-summary-title" className={styles.title}>
            {STRINGS.dataExchange.exportAllSummaryTitle}
          </h2>
          <div id="export-all-summary-body" className={styles.body}>
            <div className={styles.readoutLine} data-testid="export-all-summary-filename">
              {STRINGS.dataExchange.exportAllSummaryFile(phase.filename)}
            </div>
            {phase.skippedCount > 0 && (
              <div className={styles.skippedLine} data-testid="export-all-summary-skipped">
                {STRINGS.dataExchange.exportAllSummarySkipped(phase.skippedCount)}
              </div>
            )}
          </div>
          <div className={styles.actions}>
            <button
              ref={initialFocusRef}
              type="button"
              className={`${styles.button} ${styles.confirm}`}
              onClick={handleClose}
              data-testid="export-all-summary-close"
            >
              {STRINGS.dataExchange.exportAllSummaryClose}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // phase.kind === 'error'
  return (
    <div className={styles.overlay} data-testid="export-all-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-all-error-title"
        aria-describedby="export-all-error-body"
        data-testid="export-all-error"
      >
        <h2 id="export-all-error-title" className={styles.title}>
          {STRINGS.dataExchange.exportAllError}
        </h2>
        <div id="export-all-error-body" className={styles.body}>
          <div className={styles.readoutLine}>{phase.message}</div>
        </div>
        <div className={styles.actions}>
          <button
            ref={initialFocusRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={handleClose}
            data-testid="export-all-error-close"
          >
            {STRINGS.dataExchange.exportAllSummaryClose}
          </button>
        </div>
      </div>
    </div>
  );
}
