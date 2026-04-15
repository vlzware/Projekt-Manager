/**
 * Project management view — list, search, create, edit, delete projects.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 19, 21.
 * See e2e/visual-regression-management.spec.ts for delete flow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS, STATE_FALLBACK_COLOR } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { usePermission } from '@/hooks/usePermission';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useConfirmStore } from '@/state/confirmStore';
import styles from './Management.module.css';

type NumberPreflightStatus = 'idle' | 'checking' | 'available' | 'taken';

export function ProjectManagement() {
  const canCreate = usePermission('project:create');
  const canUpdate = usePermission('project:update');
  const canDelete = usePermission('project:delete');
  const projects = useProjectManagementStore((s) => s.projects);
  const customers = useProjectManagementStore((s) => s.customers);
  const loading = useProjectManagementStore((s) => s.loading);
  const error = useProjectManagementStore((s) => s.error);
  const fetchProjects = useProjectManagementStore((s) => s.fetchProjects);
  const searchProjects = useProjectManagementStore((s) => s.searchProjects);
  const fetchCustomers = useProjectManagementStore((s) => s.fetchCustomers);
  const createProject = useProjectManagementStore((s) => s.createProject);
  const updateProject = useProjectManagementStore((s) => s.updateProject);
  const updateDates = useProjectManagementStore((s) => s.updateDates);
  const deleteProject = useProjectManagementStore((s) => s.deleteProject);
  const clearError = useProjectManagementStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

  // Create form fields
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedEnd, setPlannedEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Client-supplied UUID for idempotent create. Stable across re-renders
  // and retries in the same form instance. See CustomerManagement for the
  // matching pattern.
  const [createId, setCreateId] = useState<string | null>(null);

  // Number-preflight state — populated on blur of the number field.
  const [numberStatus, setNumberStatus] = useState<NumberPreflightStatus>('idle');
  // Monotonic request id so two overlapping blurs cannot commit out of
  // order — the response that completes second may carry the older value.
  const numberPreflightReqRef = useRef(0);

  useEffect(() => {
    fetchProjects();
    fetchCustomers();
  }, [fetchProjects, fetchCustomers]);

  // Debounced search — skip initial render (fetchProjects above handles it).
  const prevSearch = useRef(search);
  useEffect(() => {
    if (search === prevSearch.current) return;
    prevSearch.current = search;
    const timer = setTimeout(() => {
      fetchProjects(search || undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchProjects]);

  // Close customer dropdown on outside click
  const closeDropdown = useCallback((e: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
      setCustomerDropdownOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!customerDropdownOpen) return;
    document.addEventListener('mousedown', closeDropdown);
    return () => document.removeEventListener('mousedown', closeDropdown);
  }, [customerDropdownOpen, closeDropdown]);

  const resetForm = () => {
    setNumber('');
    setTitle('');
    setCustomerId('');
    setNotes('');
    setEstimatedValue('');
    setPlannedStart('');
    setPlannedEnd('');
    setNumberStatus('idle');
  };

  const handleNumberBlur = async () => {
    const trimmed = number.trim();
    if (!trimmed) {
      numberPreflightReqRef.current++;
      setNumberStatus('idle');
      return;
    }
    const myReq = ++numberPreflightReqRef.current;
    setNumberStatus('checking');
    const results = await searchProjects(trimmed);
    // Only commit if this is still the latest request — a later blur
    // (or a change-driven reset) must win.
    if (myReq !== numberPreflightReqRef.current) return;
    const taken = results.some((p) => p.number === trimmed);
    setNumberStatus(taken ? 'taken' : 'available');
  };

  const handleCreate = async () => {
    if (submitting || !number.trim() || !title.trim() || !customerId || !createId) return;
    setSubmitting(true);

    const outcome = await createProject({
      id: createId,
      number: number.trim(),
      title: title.trim(),
      customerId,
    });

    setSubmitting(false);

    if (outcome.status === 'ok' || outcome.status === 'conflict') {
      setFormOpen(false);
      setCreateId(null);
      resetForm();
    }
  };

  const handleSaveEdit = async () => {
    if (submitting || !editProject || !title.trim()) return;
    setSubmitting(true);

    const parsedValue = estimatedValue.trim() ? parseFloat(estimatedValue.replace(',', '.')) : null;

    const result = await updateProject(editProject.id, {
      title: title.trim(),
      estimatedValue: parsedValue != null && !isNaN(parsedValue) ? parsedValue : null,
      notes: notes.trim() || null,
    });

    // Save dates if they changed (separate API endpoint)
    const origStart = editProject.plannedStart ? editProject.plannedStart.slice(0, 10) : '';
    const origEnd = editProject.plannedEnd ? editProject.plannedEnd.slice(0, 10) : '';
    if (plannedStart !== origStart || plannedEnd !== origEnd) {
      await updateDates(editProject.id, {
        plannedStart: plannedStart || null,
        plannedEnd: plannedEnd || null,
      });
    }

    setSubmitting(false);
    if (result) {
      setEditProject(null);
      resetForm();
    }
  };

  const handleDelete = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    const confirmed = await requestConfirm(
      STRINGS.ui.deleteConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    await deleteProject(project.id);
  };

  const handleRowClick = (project: Project) => {
    setEditProject(project);
    setTitle(project.title);
    setNotes(project.notes ?? '');
    setEstimatedValue(project.estimatedValue != null ? String(project.estimatedValue) : '');
    setPlannedStart(project.plannedStart ? project.plannedStart.slice(0, 10) : '');
    setPlannedEnd(project.plannedEnd ? project.plannedEnd.slice(0, 10) : '');
    clearError();
  };

  const openCreateForm = () => {
    clearError();
    resetForm();
    setEditProject(null);
    setCreateId(crypto.randomUUID());
    setFormOpen(true);
  };

  const closeCreateForm = useCallback(() => {
    if (submitting) return;
    setFormOpen(false);
    setCreateId(null);
    resetForm();
  }, [submitting]);

  const closeEditForm = useCallback(() => {
    if (submitting) return;
    setEditProject(null);
    resetForm();
  }, [submitting]);

  useEscapeKey(closeCreateForm, formOpen);
  useEscapeKey(closeEditForm, !!editProject && !formOpen);

  const stateLabel = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.label ?? status;
  };

  const stateColor = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.color ?? STATE_FALLBACK_COLOR;
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canCreate && (
          <button
            className={styles.createButton}
            onClick={openCreateForm}
            data-testid="project-create-button"
          >
            {STRINGS.ui.create}
          </button>
        )}
        <input
          className={styles.searchInput}
          placeholder={STRINGS.ui.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="project-search"
        />
      </div>

      {error && !formOpen && !editProject && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="project-table">
        <thead>
          <tr>
            <th>{STRINGS.ui.number}</th>
            <th>{STRINGS.ui.title}</th>
            <th>{STRINGS.ui.customer}</th>
            <th>{STRINGS.ui.status}</th>
            <th>{STRINGS.ui.dates}</th>
            <th>{STRINGS.ui.value}</th>
            {canDelete && <th>{STRINGS.ui.actions}</th>}
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className={styles.clickableRow} onClick={() => handleRowClick(p)}>
              <td>{p.number}</td>
              <td>{p.title}</td>
              <td>{p.customer?.name ?? '—'}</td>
              <td>
                <span className={styles.badge} style={{ backgroundColor: stateColor(p.status) }}>
                  {stateLabel(p.status)}
                </span>
              </td>
              <td>
                {p.plannedStart
                  ? `${new Date(p.plannedStart).toLocaleDateString('de-DE')}${p.plannedEnd ? ' – ' + new Date(p.plannedEnd).toLocaleDateString('de-DE') : ''}`
                  : STRINGS.projects.noDate}
              </td>
              <td>
                {p.estimatedValue != null
                  ? p.estimatedValue.toLocaleString('de-DE', {
                      style: 'currency',
                      currency: 'EUR',
                    })
                  : '—'}
              </td>
              {canDelete && (
                <td>
                  <button className={styles.dangerButton} onClick={(e) => handleDelete(e, p)}>
                    {STRINGS.ui.delete}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && projects.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {/* Create form */}
      {formOpen && (
        <div className={styles.formOverlay}>
          <form
            className={styles.formPanel}
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <h2 className={styles.formTitle}>
              {STRINGS.entities.project} {STRINGS.ui.create}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.number} *</label>
              <input
                className={styles.formInput}
                value={number}
                onChange={(e) => {
                  setNumber(e.target.value);
                  // Clear the preflight verdict on edit — re-runs on the
                  // next blur. Bump the request id so a still-in-flight
                  // fetch from the prior value cannot commit its result.
                  numberPreflightReqRef.current++;
                  if (numberStatus !== 'idle') setNumberStatus('idle');
                }}
                onBlur={() => void handleNumberBlur()}
                disabled={submitting}
                data-testid="project-number-input"
                autoFocus
              />
              {numberStatus === 'taken' && (
                <div
                  className={styles.fieldHintError}
                  data-testid="project-number-taken"
                  role="status"
                >
                  {STRINGS.projects.numberTaken(number.trim())}
                </div>
              )}
              {numberStatus === 'available' && (
                <div
                  className={styles.fieldHintOk}
                  data-testid="project-number-available"
                  role="status"
                >
                  {STRINGS.projects.numberAvailable}
                </div>
              )}
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.title} *</label>
              <input
                className={styles.formInput}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={submitting}
                data-testid="project-title-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.customer} *</label>
              <div
                className={styles.selectWrapper}
                data-testid="project-customer-select"
                ref={dropdownRef}
              >
                <input
                  className={styles.formInput}
                  value={customerId ? (customers.find((c) => c.id === customerId)?.name ?? '') : ''}
                  readOnly
                  onClick={() => !submitting && setCustomerDropdownOpen(!customerDropdownOpen)}
                  disabled={submitting}
                  placeholder={STRINGS.ui.search}
                />
                {customerDropdownOpen && (
                  <div className={styles.selectDropdown}>
                    {customers.map((c) => (
                      <div
                        key={c.id}
                        className={styles.selectOption}
                        onClick={() => {
                          setCustomerId(c.id);
                          setCustomerDropdownOpen(false);
                        }}
                      >
                        {c.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={closeCreateForm}
                disabled={submitting}
              >
                {STRINGS.ui.cancel}
              </button>
              <button
                type="submit"
                className={styles.submitButton}
                disabled={submitting || !number.trim() || !title.trim() || !customerId}
                data-testid="project-submit"
              >
                {STRINGS.ui.create}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit panel (click row → edit project) */}
      {editProject && !formOpen && (
        <div className={styles.formOverlay}>
          <form
            className={styles.formPanel}
            onSubmit={(e) => {
              e.preventDefault();
              if (!canUpdate) return;
              void handleSaveEdit();
            }}
          >
            <h2 className={styles.formTitle}>
              {editProject.number} — {canUpdate ? STRINGS.ui.edit : STRINGS.ui.viewDetails}
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
                value={editProject.customer?.name ?? '—'}
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
                  // Clear end if start is cleared (same rule as detail panel)
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
                onClick={closeEditForm}
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
      )}
    </div>
  );
}
