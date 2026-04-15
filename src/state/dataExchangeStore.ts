/**
 * Unified data-exchange state (ADR-0018 / ui.md §8.11).
 *
 * Drives the Daten view: parse an envelope file, run a server-side
 * dry-run, present the preview, then commit the restore. Export is a
 * one-shot GET that triggers a browser download.
 *
 * Flow invariants:
 *  - `preview` is only set after a successful dry-run; when null, the
 *    commit action must remain disabled.
 *  - `warnAcknowledged` is a UI gate, not a server protocol switch. The
 *    commit always sends `override=true` when the preview declared the
 *    target non-empty; the checkbox exists to force an intentional click,
 *    not to change the wire format.
 *  - Session-expiry on any call delegates to the shared handler so the
 *    user bounces back to login uniformly with every other store.
 */

import { create } from 'zustand';
import { dataApi } from '@/api/client';
import { STRINGS } from '@/config/strings';
import type { Envelope, DryRunPreview, ImportResult } from '@/domain/types';
import { formatDateOnly } from '@/domain/dateFormat';
import { handleSessionExpired } from './sessionExpired';
import { useProjectStore } from './projectStore';
import { useCustomerStore } from './customerStore';

/**
 * Max envelope size the client accepts before opening a network call.
 * Kept generous: the business-data export for a small business is well
 * under 1 MB, but a future-proof ceiling avoids unbounded FileReader work.
 */
const MAX_IMPORT_FILE_MB = 25;
const MAX_IMPORT_FILE_BYTES = MAX_IMPORT_FILE_MB * 1024 * 1024;

interface DataExchangeState {
  // Import
  file: File | null;
  envelope: Envelope | null;
  preview: DryRunPreview | null;
  previewError: string | null;
  warnAcknowledged: boolean;
  importing: boolean;
  importResult: ImportResult | null;
  importError: string | null;

  // Export
  exporting: boolean;
  exportError: string | null;

  setFile: (file: File | null) => Promise<void>;
  setWarnAcknowledged: (v: boolean) => void;
  commit: () => Promise<void>;
  clear: () => void;

  runExport: () => Promise<void>;
}

/**
 * Format a local-time timestamp suitable for a filename component. Mirrors
 * the spec example `projekt-manager-export-2026-04-15T14-23-07.json`.
 * Uses local time because the user's mental model of "when I exported" is
 * wall-clock, not UTC.
 */
function fileTimestamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${formatDateOnly(d)}T${hh}-${mm}-${ss}`;
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsText(file);
  });
}

function isDryRunPreview(result: ImportResult | DryRunPreview): result is DryRunPreview {
  return 'would_write' in result;
}

export const useDataExchangeStore = create<DataExchangeState>((set, get) => ({
  file: null,
  envelope: null,
  preview: null,
  previewError: null,
  warnAcknowledged: false,
  importing: false,
  importResult: null,
  importError: null,

  exporting: false,
  exportError: null,

  setFile: async (file: File | null) => {
    // Reset every derived field when the selection changes — the old
    // preview is about the old file and would mislead the commit button.
    if (!file) {
      set({
        file: null,
        envelope: null,
        preview: null,
        previewError: null,
        warnAcknowledged: false,
        importResult: null,
        importError: null,
      });
      return;
    }

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      set({
        file,
        envelope: null,
        preview: null,
        previewError: STRINGS.ui.fileTooLarge(MAX_IMPORT_FILE_MB),
        warnAcknowledged: false,
        importResult: null,
        importError: null,
      });
      return;
    }

    set({
      file,
      envelope: null,
      preview: null,
      previewError: null,
      warnAcknowledged: false,
      importResult: null,
      importError: null,
    });

    let text: string;
    try {
      text = await readFileAsText(file);
    } catch {
      set({ previewError: STRINGS.errors.invalidInput });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      set({ previewError: STRINGS.errors.invalidInput });
      return;
    }

    // Shallow shape gate — the full schema is validated server-side via
    // Fastify's ajv-generated schema. Refusing obvious shape mismatches
    // up front saves one round-trip and gives a cleaner error.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('schema_version' in parsed) ||
      !Array.isArray((parsed as Envelope).customers) ||
      !Array.isArray((parsed as Envelope).projects) ||
      !Array.isArray((parsed as Envelope).project_workers)
    ) {
      set({ previewError: STRINGS.errors.invalidInput });
      return;
    }

    const envelope = parsed as Envelope;

    // Dry-run with override=true so the server reports what the
    // destructive path would do. The commit path re-sends with
    // override derived from target_non_empty + warnAcknowledged.
    const res = await dataApi.import(envelope, { dryRun: true, override: true });
    if (!res.ok) {
      if (res.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ envelope, previewError: res.error.message });
      return;
    }

    if (!isDryRunPreview(res.data)) {
      // The server shape is declarative — this branch is unreachable in
      // the current contract. Keep the guard for future divergence.
      set({ envelope, previewError: STRINGS.errors.invalidResponse });
      return;
    }

    set({ envelope, preview: res.data, previewError: null });
  },

  setWarnAcknowledged: (v) => set({ warnAcknowledged: v }),

  commit: async () => {
    const { envelope, preview, warnAcknowledged } = get();
    if (!envelope || !preview) return;
    if (preview.validation_errors.length > 0) return;
    if (preview.target_non_empty && !warnAcknowledged) return;

    set({ importing: true, importError: null, importResult: null });

    const override = preview.target_non_empty;
    const res = await dataApi.import(envelope, { dryRun: false, override });

    if (!res.ok) {
      if (res.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ importing: false, importError: res.error.message });
      return;
    }

    if (isDryRunPreview(res.data)) {
      // Same unreachable-in-contract guard as in setFile.
      set({ importing: false, importError: STRINGS.errors.invalidResponse });
      return;
    }

    set({ importing: false, importResult: res.data });

    // Refresh downstream caches — a restore can rewrite every business
    // row, so leaving stale customers/projects in memory would show the
    // user pre-import data until the next navigation.
    useProjectStore.getState().fetchProjects();
    useCustomerStore.getState().fetchCustomers();
  },

  clear: () =>
    set({
      file: null,
      envelope: null,
      preview: null,
      previewError: null,
      warnAcknowledged: false,
      importing: false,
      importResult: null,
      importError: null,
    }),

  runExport: async () => {
    set({ exporting: true, exportError: null });

    const res = await dataApi.export();
    if (!res.ok) {
      if (res.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ exporting: false, exportError: res.error.message });
      return;
    }

    set({ exporting: false });

    // Trigger file download via a transient anchor element; kept inside
    // the store so the view stays a pure render of state. URL.revokeObjectURL
    // in the same tick is safe because `a.click()` is synchronous — the
    // browser has already handed the URL to the download manager.
    const blob = new Blob([JSON.stringify(res.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `projekt-manager-export-${fileTimestamp(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
}));
