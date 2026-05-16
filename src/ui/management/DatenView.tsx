/**
 * Daten view — takeout-zip Export + Import (ADR-0018, ui/daten.md §8.11).
 *
 * Two actions, gated independently:
 *   - Export — gated by `data:export`. Opens a pre-flight dialog.
 *   - Import — gated by `data:restore`. Triggers the OS file picker
 *     directly; the dialog mounts at `parsing` once a zip is chosen.
 *
 * Both flows reuse the takeout zip pipeline; the text-row endpoints
 * (`GET /api/export`, `POST /api/import`) are internal building blocks
 * and not surfaced as standalone UI actions (api.md §14.2.4).
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { StorageUsageRow } from './StorageUsageRow';
import { VollstaendigerExportDialog } from './VollstaendigerExportDialog';
import { VollstaendigerImportDialog } from './VollstaendigerImportDialog';
import styles from './Management.module.css';

export function DatenView() {
  const canExport = usePermission('data:export');
  const canImport = usePermission('data:restore');

  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    // Reset the input value first so re-picking the same file still
    // fires `change`. Browsers gate the click() to user-gesture
    // handlers — the surrounding button's onClick is exactly that.
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file) setImportFile(file);
  };

  return (
    <div className={styles.container} data-testid="daten-view">
      <StorageUsageRow />

      {canExport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.exportHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.exportDescription}</p>
          <div className={styles.inlineGroup}>
            <button
              className={styles.submitButton}
              onClick={() => setExportOpen(true)}
              data-testid="data-export-button"
            >
              {STRINGS.dataExchange.exportAction}
            </button>
          </div>
        </div>
      )}

      <VollstaendigerExportDialog isOpen={exportOpen} onClose={() => setExportOpen(false)} />

      {canImport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.importHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.importDescription}</p>
          <div className={styles.inlineGroup}>
            <button
              className={styles.submitButton}
              onClick={handleImportClick}
              data-testid="data-import-button"
            >
              {STRINGS.dataExchange.importAction}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFilePicked}
              hidden
              data-testid="data-import-file-input"
            />
          </div>
        </div>
      )}

      {/* Conditionally mount so each open is a fresh dialog lifecycle —
          the phrase input + ephemeral runner state reset implicitly via
          unmount/remount, no setState-in-effect needed. */}
      {importFile && (
        <VollstaendigerImportDialog file={importFile} onClose={() => setImportFile(null)} />
      )}
    </div>
  );
}
