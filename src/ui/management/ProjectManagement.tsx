/**
 * Project management view — list, search, create, edit, delete projects.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 19, 21.
 * See e2e/visual-regression-management.spec.ts for delete flow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useConfirmStore } from '@/state/confirmStore';
import styles from './Management.module.css';

export function ProjectManagement() {
  const projects = useProjectManagementStore((s) => s.projects);
  const customers = useProjectManagementStore((s) => s.customers);
  const loading = useProjectManagementStore((s) => s.loading);
  const error = useProjectManagementStore((s) => s.error);
  const fetchProjects = useProjectManagementStore((s) => s.fetchProjects);
  const fetchCustomers = useProjectManagementStore((s) => s.fetchCustomers);
  const createProject = useProjectManagementStore((s) => s.createProject);
  const updateProject = useProjectManagementStore((s) => s.updateProject);
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
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
  };

  const handleCreate = async () => {
    if (!number.trim() || !title.trim() || !customerId) return;
    setSubmitting(true);

    const ok = await createProject({
      number: number.trim(),
      title: title.trim(),
      customerId,
    });

    setSubmitting(false);
    if (ok) {
      setFormOpen(false);
      resetForm();
    }
  };

  const handleSaveNotes = async () => {
    if (!editProject) return;
    setSubmitting(true);
    const result = await updateProject(editProject.id, { notes: notes.trim() || null });
    setSubmitting(false);
    if (result) {
      setEditProject(null);
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
    setNotes(project.notes ?? '');
    clearError();
  };

  const stateLabel = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.label ?? status;
  };

  const stateColor = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.color ?? '#94a3b8';
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          placeholder={STRINGS.ui.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="project-search"
        />
        <button
          className={styles.createButton}
          onClick={() => {
            clearError();
            resetForm();
            setEditProject(null);
            setFormOpen(true);
          }}
          data-testid="project-create-button"
        >
          {STRINGS.ui.create}
        </button>
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
            <th>{STRINGS.ui.actions}</th>
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
              <td>
                <button className={styles.dangerButton} onClick={(e) => handleDelete(e, p)}>
                  {STRINGS.ui.delete}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && projects.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {/* Create form */}
      {formOpen && (
        <div className={styles.formOverlay} onClick={() => setFormOpen(false)}>
          <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.formTitle}>
              {STRINGS.entities.project} {STRINGS.ui.create}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.number} *</label>
              <input
                className={styles.formInput}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                data-testid="project-number-input"
                autoFocus
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.title} *</label>
              <input
                className={styles.formInput}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
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
                  onClick={() => setCustomerDropdownOpen(!customerDropdownOpen)}
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
              <button className={styles.cancelButton} onClick={() => setFormOpen(false)}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleCreate}
                disabled={submitting || !number.trim() || !title.trim() || !customerId}
                data-testid="project-submit"
              >
                {STRINGS.ui.create}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit panel (click row → edit notes) */}
      {editProject && !formOpen && (
        <div className={styles.formOverlay} onClick={() => setEditProject(null)}>
          <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.formTitle}>
              {editProject.number} — {editProject.title}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.notes}</label>
              <textarea
                className={styles.formTextarea}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="project-notes-input"
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={() => setEditProject(null)}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleSaveNotes}
                disabled={submitting}
                data-testid="project-save"
              >
                {STRINGS.ui.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
