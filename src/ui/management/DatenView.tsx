/**
 * Daten view — unified business-data export + restore (ADR-0018, ui.md §8.11).
 *
 * Gated by `data:export` at the navigation level; the restore sub-form is
 * further gated by `data:restore`. The commit button obeys a three-part
 * guard: preview present, no validation errors, and (if the target is
 * non-empty) the typed phrase matches the configured phrase. The server
 * is always the final authority — AC-160 re-validates the phrase and
 * AC-138 still enforces TARGET_NOT_EMPTY when override is absent.
 */

import type { ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { RESTORE_CONFIRMATION_PHRASE, restorePhraseMatches } from '@/config/dataExchangeConfig';
import { usePermission } from '@/hooks/usePermission';
import { useDataExchangeStore } from '@/state/dataExchangeStore';
import styles from './Management.module.css';

export function DatenView() {
  const canExport = usePermission('data:export');
  const canImport = usePermission('data:restore');

  const file = useDataExchangeStore((s) => s.file);
  const preview = useDataExchangeStore((s) => s.preview);
  const previewError = useDataExchangeStore((s) => s.previewError);
  const phraseInput = useDataExchangeStore((s) => s.phraseInput);
  const importing = useDataExchangeStore((s) => s.importing);
  const importResult = useDataExchangeStore((s) => s.importResult);
  const importError = useDataExchangeStore((s) => s.importError);
  const exporting = useDataExchangeStore((s) => s.exporting);
  const exportError = useDataExchangeStore((s) => s.exportError);
  const setFile = useDataExchangeStore((s) => s.setFile);
  const setPhraseInput = useDataExchangeStore((s) => s.setPhraseInput);
  const commit = useDataExchangeStore((s) => s.commit);
  const runExport = useDataExchangeStore((s) => s.runExport);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    // Fire-and-forget: the store handles async parsing + dry-run. Swallow
    // the returned promise so the change handler stays synchronous from
    // React's perspective.
    void setFile(picked);
  };

  const hasValidationErrors = (preview?.validation_errors.length ?? 0) > 0;
  const requiresPhrase = preview?.target_non_empty === true;
  const commitDisabled =
    !preview ||
    hasValidationErrors ||
    importing ||
    (requiresPhrase && !restorePhraseMatches(phraseInput));

  return (
    <div className={styles.container} data-testid="daten-view">
      {/* ---- EXPORT SECTION ---- */}
      {canExport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.exportHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.exportDescription}</p>

          <div className={styles.inlineGroup}>
            <button
              className={styles.submitButton}
              onClick={() => void runExport()}
              disabled={exporting}
              data-testid="data-export-button"
            >
              {STRINGS.dataExchange.exportAction}
            </button>
          </div>

          {exportError && (
            <div className={styles.error} style={{ marginTop: 12 }}>
              {exportError}
            </div>
          )}
        </div>
      )}

      {/* ---- IMPORT SECTION ---- */}
      {canImport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.importHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.importDescription}</p>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>{STRINGS.ui.uploadFile}</label>
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              disabled={importing}
              data-testid="data-import-file-input"
            />
            {file && <div className={styles.fileName}>{file.name}</div>}
          </div>

          {previewError && (
            <div className={styles.error} style={{ marginTop: 12 }}>
              {previewError}
            </div>
          )}

          {preview && (
            <div
              className={styles.previewPanel}
              data-testid="data-import-preview"
              style={{ marginTop: 12 }}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{STRINGS.ui.entityType}</th>
                    <th>{STRINGS.dataExchange.wouldWriteHeader}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{STRINGS.ui.customers}</td>
                    <td data-testid="data-import-preview-customers">
                      {preview.would_write.customers}
                    </td>
                  </tr>
                  <tr>
                    <td>{STRINGS.ui.projects}</td>
                    <td data-testid="data-import-preview-projects">
                      {preview.would_write.projects}
                    </td>
                  </tr>
                  <tr>
                    <td>{STRINGS.dataExchange.projectWorkers}</td>
                    <td data-testid="data-import-preview-workers">
                      {preview.would_write.project_workers}
                    </td>
                  </tr>
                </tbody>
              </table>

              {hasValidationErrors && (
                <div className={styles.sectionDivider}>
                  <div className={styles.resultBoxError}>
                    {STRINGS.dataExchange.validationErrorsHeading}
                  </div>
                  <ul className={styles.validationList}>
                    {preview.validation_errors.map((err, i) => (
                      <li key={i} className={styles.errorRow}>
                        <strong>{err.path}</strong>: {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {requiresPhrase && (
                <div className={styles.sectionDivider}>
                  <div className={styles.resultBoxError}>
                    {STRINGS.dataExchange.restoreDestructiveNotice}
                  </div>
                  <label className={styles.formLabel} style={{ marginTop: 12 }}>
                    {STRINGS.dataExchange.restorePhrasePrompt(RESTORE_CONFIRMATION_PHRASE)}
                  </label>
                  <input
                    type="text"
                    value={phraseInput}
                    onChange={(e) => setPhraseInput(e.target.value)}
                    disabled={importing}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="data-import-phrase-input"
                  />
                </div>
              )}

              <div className={styles.sectionDivider}>
                <button
                  className={styles.submitButton}
                  onClick={() => void commit()}
                  disabled={commitDisabled}
                  data-testid="data-import-commit"
                >
                  {STRINGS.dataExchange.importAction}
                </button>
              </div>
            </div>
          )}

          {importError && (
            <div className={styles.error} style={{ marginTop: 12 }}>
              {importError}
            </div>
          )}

          {importResult && (
            <div
              className={styles.resultBox}
              data-testid="data-import-result"
              style={{ marginTop: 12 }}
            >
              <div>{STRINGS.dataExchange.importSuccessHeading}</div>
              <ul className={styles.resultList}>
                <li>
                  {STRINGS.ui.customers}: {importResult.summary.customers}
                </li>
                <li>
                  {STRINGS.ui.projects}: {importResult.summary.projects}
                </li>
                <li>
                  {STRINGS.dataExchange.projectWorkers}: {importResult.summary.project_workers}
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
