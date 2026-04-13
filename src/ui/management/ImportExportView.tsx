/**
 * Import/Export view — bulk JSON import and filtered export.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/import-export-flows.spec.ts steps 25–27.
 */

import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS } from '@/config/stateConfig';
import { useAuthStore } from '@/state/authStore';
import { useImportExportStore } from '@/state/importExportStore';
import styles from './Management.module.css';

export function ImportExportView() {
  const authUser = useAuthStore((s) => s.authUser);
  const canImport = authUser?.roles.some((r) => r === 'owner' || r === 'office') ?? false;

  const importEntity = useImportExportStore((s) => s.importEntity);
  const importData = useImportExportStore((s) => s.importData);
  const importResult = useImportExportStore((s) => s.importResult);
  const importError = useImportExportStore((s) => s.importError);
  const importing = useImportExportStore((s) => s.importing);
  const setImportEntity = useImportExportStore((s) => s.setImportEntity);
  const setImportData = useImportExportStore((s) => s.setImportData);
  const setImportError = useImportExportStore((s) => s.setImportError);
  const runImport = useImportExportStore((s) => s.runImport);

  const exportEntity = useImportExportStore((s) => s.exportEntity);
  const exportStatus = useImportExportStore((s) => s.exportStatus);
  const exporting = useImportExportStore((s) => s.exporting);
  const exportError = useImportExportStore((s) => s.exportError);
  const setExportEntity = useImportExportStore((s) => s.setExportEntity);
  const setExportStatus = useImportExportStore((s) => s.setExportStatus);
  const runExport = useImportExportStore((s) => s.runExport);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setImportData(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (!Array.isArray(parsed)) {
          setImportError(STRINGS.errors.invalidInput);
          setImportData(null);
          return;
        }
        setImportData(parsed);
      } catch {
        setImportError(STRINGS.errors.invalidInput);
        setImportData(null);
      }
    };
    reader.readAsText(file);
  };

  const previewColumns = (item: Record<string, unknown>, index: number) => {
    if (importEntity === 'customers') {
      return (
        <tr key={index}>
          <td>{index}</td>
          <td>{(item.name as string) ?? '—'}</td>
          <td>{(item.phone as string) ?? '—'}</td>
          <td>{(item.email as string) ?? '—'}</td>
        </tr>
      );
    }
    return (
      <tr key={index}>
        <td>{index}</td>
        <td>{(item.number as string) ?? '—'}</td>
        <td>{(item.title as string) ?? '—'}</td>
        <td>{(item.status as string) ?? '—'}</td>
      </tr>
    );
  };

  return (
    <div className={styles.container} data-testid="import-export-view">
      {/* ---- IMPORT SECTION ---- */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>{STRINGS.ui.import}</h3>

        <div className={styles.inlineGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.entityType}</label>
          <select
            className={styles.formSelect}
            value={importEntity}
            onChange={(e) => setImportEntity(e.target.value as 'customers' | 'projects')}
            data-testid="import-entity-select"
            disabled={!canImport}
            style={{ width: 'auto' }}
          >
            <option value="customers">{STRINGS.ui.customers}</option>
            <option value="projects">{STRINGS.ui.projects}</option>
          </select>
        </div>

        {!canImport && (
          <div className={styles.permissionHint} data-testid="import-permission-hint">
            {STRINGS.auth.notPermitted}
          </div>
        )}

        <div className={styles.formGroup} style={{ marginTop: 12 }}>
          <label className={styles.formLabel}>{STRINGS.ui.uploadFile}</label>
          <input
            type="file"
            accept=".json"
            onChange={handleFileChange}
            data-testid="import-file-input"
            disabled={!canImport}
          />
        </div>

        {importData && importData.length > 0 && (
          <>
            <table
              className={styles.table}
              data-testid="import-preview-table"
              style={{ marginTop: 12 }}
            >
              <thead>
                <tr>
                  <th>#</th>
                  {importEntity === 'customers' ? (
                    <>
                      <th>{STRINGS.ui.name}</th>
                      <th>{STRINGS.ui.phone}</th>
                      <th>{STRINGS.ui.email}</th>
                    </>
                  ) : (
                    <>
                      <th>{STRINGS.ui.number}</th>
                      <th>{STRINGS.ui.title}</th>
                      <th>{STRINGS.ui.status}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {importData.map((item, i) => previewColumns(item as Record<string, unknown>, i))}
              </tbody>
            </table>

            <div style={{ marginTop: 12 }}>
              <button
                className={styles.submitButton}
                onClick={runImport}
                disabled={importing || !canImport}
                data-testid="import-submit"
              >
                {STRINGS.ui.importSubmit}
              </button>
            </div>
          </>
        )}

        {importError && (
          <div className={styles.error} style={{ marginTop: 12 }}>
            {importError}
          </div>
        )}

        {importResult && (
          <div style={{ marginTop: 12 }} data-testid="import-result">
            <div className={styles.resultBox}>
              {STRINGS.ui.importedCount(importResult.imported)}
              {importResult.errors.length > 0 &&
                ` · ${STRINGS.ui.errorCount(importResult.errors.length)}`}
            </div>
            {importResult.errors.map((err) => (
              <div
                key={err.index}
                className={styles.errorRow}
                data-testid={`import-error-row-${err.index}`}
              >
                <span className={styles.resultBoxError}>
                  {STRINGS.ui.row} {err.index}: {err.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- EXPORT SECTION ---- */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>{STRINGS.ui.export}</h3>

        <div className={styles.inlineGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.entityType}</label>
          <select
            className={styles.formSelect}
            value={exportEntity}
            onChange={(e) => setExportEntity(e.target.value as 'customers' | 'projects')}
            data-testid="export-entity-select"
            style={{ width: 'auto' }}
          >
            <option value="projects">{STRINGS.ui.projects}</option>
            <option value="customers">{STRINGS.ui.customers}</option>
          </select>

          {exportEntity === 'projects' && (
            <select
              className={styles.formSelect}
              value={exportStatus}
              onChange={(e) => setExportStatus(e.target.value)}
              data-testid="export-status-filter"
              style={{ width: 'auto' }}
            >
              <option value="">{STRINGS.ui.all}</option>
              {STATE_CONFIGS.map((cfg) => (
                <option key={cfg.key} value={cfg.key}>
                  {cfg.label}
                </option>
              ))}
            </select>
          )}

          <button
            className={styles.submitButton}
            onClick={runExport}
            disabled={exporting}
            data-testid="export-button"
          >
            {STRINGS.ui.exportDownload}
          </button>
        </div>

        {exportError && (
          <div className={styles.error} style={{ marginTop: 12 }}>
            {exportError}
          </div>
        )}
      </div>
    </div>
  );
}
