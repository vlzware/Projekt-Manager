/**
 * Edit form for an existing project. Owns its own field state, derived
 * from the passed-in project. Returns control to the parent via
 * onClose when the user cancels or a successful save lands.
 *
 * Dates use a separate API endpoint (updateDates) — save only fires it
 * when either date actually changed, to avoid spurious statusChangedAt
 * resets.
 */

import { useCallback, useState } from 'react';
import { STRINGS } from '@/config/strings';
import type { Project } from '@/domain/types';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import styles from './Management.module.css';

interface Props {
  project: Project;
  canUpdate: boolean;
  onClose: () => void;
}

export function ProjectEditForm({ project, canUpdate, onClose }: Props) {
  const updateProject = useProjectManagementStore((s) => s.updateProject);
  const updateDates = useProjectManagementStore((s) => s.updateDates);
  const error = useProjectManagementStore((s) => s.error);

  const [title, setTitle] = useState(project.title);
  const [notes, setNotes] = useState(project.notes ?? '');
  const [estimatedValue, setEstimatedValue] = useState(
    project.estimatedValue != null ? String(project.estimatedValue) : '',
  );
  const [plannedStart, setPlannedStart] = useState(
    project.plannedStart ? project.plannedStart.slice(0, 10) : '',
  );
  const [plannedEnd, setPlannedEnd] = useState(
    project.plannedEnd ? project.plannedEnd.slice(0, 10) : '',
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    if (submitting || !title.trim()) return;
    setSubmitting(true);

    const parsedValue = estimatedValue.trim() ? parseFloat(estimatedValue.replace(',', '.')) : null;

    const result = await updateProject(project.id, {
      title: title.trim(),
      estimatedValue: parsedValue != null && !isNaN(parsedValue) ? parsedValue : null,
      notes: notes.trim() || null,
    });

    // Save dates only if they changed (separate API endpoint).
    const origStart = project.plannedStart ? project.plannedStart.slice(0, 10) : '';
    const origEnd = project.plannedEnd ? project.plannedEnd.slice(0, 10) : '';
    if (plannedStart !== origStart || plannedEnd !== origEnd) {
      await updateDates(project.id, {
        plannedStart: plannedStart || null,
        plannedEnd: plannedEnd || null,
      });
    }

    setSubmitting(false);
    if (result) {
      onClose();
    }
  };

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  return (
    <div className={styles.formOverlay}>
      <form
        className={styles.formPanel}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canUpdate) return;
          void handleSave();
        }}
      >
        <h2 className={styles.formTitle}>
          {project.number} — {canUpdate ? STRINGS.ui.edit : STRINGS.ui.viewDetails}
        </h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.title} *</label>
          <input
            className={styles.formInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!canUpdate || submitting}
            data-testid="project-title-edit"
            autoFocus
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.customer}</label>
          <input
            className={styles.formInput}
            value={project.customer?.name ?? '—'}
            readOnly
            disabled
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.dateStart}</label>
          <input
            className={styles.formInput}
            type="date"
            value={plannedStart}
            onChange={(e) => {
              setPlannedStart(e.target.value);
              // Clear end if start is cleared (same rule as detail panel).
              if (!e.target.value) setPlannedEnd('');
            }}
            disabled={!canUpdate || submitting}
            data-testid="project-start-edit"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.dateEnd}</label>
          <input
            className={styles.formInput}
            type="date"
            value={plannedEnd}
            onChange={(e) => setPlannedEnd(e.target.value)}
            min={plannedStart || undefined}
            disabled={!canUpdate || !plannedStart || submitting}
            data-testid="project-end-edit"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.value}</label>
          <input
            className={styles.formInput}
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
            placeholder="0,00"
            disabled={!canUpdate || submitting}
            data-testid="project-value-edit"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.notes}</label>
          <textarea
            className={styles.formTextarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={!canUpdate || submitting}
            data-testid="project-notes-input"
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={close}
            disabled={submitting}
          >
            {STRINGS.ui.cancel}
          </button>
          {canUpdate && (
            <button
              type="submit"
              className={styles.submitButton}
              disabled={submitting || !title.trim()}
              data-testid="project-save"
            >
              {STRINGS.ui.save}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
