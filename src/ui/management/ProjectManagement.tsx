/**
 * Project management view — list, search, create, edit, delete projects.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 19, 21.
 * See e2e/visual-regression-management.spec.ts for delete flow.
 */

import { useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS, STATE_FALLBACK_COLOR } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { usePermission } from '@/hooks/usePermission';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useConfirmStore } from '@/state/confirmStore';
import { ProjectCreateForm } from './ProjectCreateForm';
import { ProjectEditForm } from './ProjectEditForm';
import styles from './Management.module.css';

export function ProjectManagement() {
  const canCreate = usePermission('project:create');
  const canUpdate = usePermission('project:update');
  const canDelete = usePermission('project:delete');
  const projects = useProjectManagementStore((s) => s.projects);
  const loading = useProjectManagementStore((s) => s.loading);
  const error = useProjectManagementStore((s) => s.error);
  const fetchProjects = useProjectManagementStore((s) => s.fetchProjects);
  const fetchCustomers = useProjectManagementStore((s) => s.fetchCustomers);
  const deleteProject = useProjectManagementStore((s) => s.deleteProject);
  const clearError = useProjectManagementStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

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

  const handleDelete = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    const confirmed = await requestConfirm(
      STRINGS.ui.deleteConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    await deleteProject(project.id);
  };

  const handleRowClick = (project: Project) => {
    clearError();
    setEditProject(project);
  };

  const openCreateForm = () => {
    clearError();
    setEditProject(null);
    setFormOpen(true);
  };

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

      {formOpen && <ProjectCreateForm onClose={() => setFormOpen(false)} />}

      {editProject && !formOpen && (
        <ProjectEditForm
          project={editProject}
          canUpdate={canUpdate}
          onClose={() => setEditProject(null)}
        />
      )}
    </div>
  );
}
