/**
 * Assigned-worker editor — chip set of currently assigned workers plus
 * add/remove controls gated by `project:update` (spec §8.15.3).
 *
 * Mutations go through `projectStore.updateAssignedWorkers` with the
 * full replacement list. Optimistic UI + revert-on-failure live in the
 * store; the component is a thin dispatcher.
 */

import { useEffect, useMemo, useState } from 'react';
import { STRINGS } from '@/config/strings';
import type { User } from '@/domain/types';
import { usePermission } from '@/hooks/usePermission';
import { useProjectStore } from '@/state/projectStore';
import { useUserStore } from '@/state/userStore';
import styles from './ProjectDetail.module.css';

interface AssignedWorkerEditorProps {
  projectId: string;
}

type AssignedWorker = { userId: string; displayName: string };

export function AssignedWorkerEditor({ projectId }: AssignedWorkerEditorProps) {
  const canUpdate = usePermission('project:update');
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const updateAssignedWorkers = useProjectStore((s) => s.updateAssignedWorkers);
  const mutationInFlight = useProjectStore((s) =>
    project ? !!s.mutationInFlight[projectId] : false,
  );
  const users = useUserStore((s) => s.users);
  const fetchUsers = useUserStore((s) => s.fetchUsers);

  const assigned: AssignedWorker[] = useMemo(
    () => project?.assignedWorkers ?? [],
    [project?.assignedWorkers],
  );

  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!canUpdate) return;
    void fetchUsers();
  }, [canUpdate, fetchUsers]);

  const unassignedWorkers = useMemo(() => {
    const assignedIds = new Set(assigned.map((a) => a.userId));
    return users.filter((u) => u.roles.includes('worker') && !assignedIds.has(u.id));
  }, [users, assigned]);

  const commit = (nextIds: string[], optimistic: AssignedWorker[]) => {
    if (!project) return;
    void updateAssignedWorkers(projectId, nextIds, optimistic);
  };

  const handleRemove = (userId: string) => {
    const next = assigned.filter((a) => a.userId !== userId);
    commit(
      next.map((a) => a.userId),
      next,
    );
  };

  const handleAdd = (user: User) => {
    const next: AssignedWorker[] = [
      ...assigned,
      { userId: user.id, displayName: user.displayName },
    ];
    setPickerOpen(false);
    commit(
      next.map((a) => a.userId),
      next,
    );
  };

  return (
    <section
      aria-label={STRINGS.attachments.assignedWorkers}
      data-testid="project-detail-assigned-workers"
      className={styles.workersSection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.assignedWorkers}</h3>
      <ul className={styles.chipList}>
        {assigned.map((w) => (
          <li key={w.userId} className={styles.chip} data-testid={`worker-chip-${w.userId}`}>
            <span>{w.displayName}</span>
            {canUpdate && (
              <button
                type="button"
                className={styles.chipRemove}
                data-testid={`worker-chip-remove-${w.userId}`}
                onClick={() => handleRemove(w.userId)}
                disabled={mutationInFlight}
                aria-label={STRINGS.attachments.removeWorker}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      {canUpdate && (
        <div className={styles.workerAddWrapper}>
          <button
            type="button"
            className={styles.addButton}
            data-testid="worker-editor-add"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={mutationInFlight}
          >
            {STRINGS.attachments.addWorker}
          </button>
          {pickerOpen && (
            <ul className={styles.workerOptions} role="listbox">
              {unassignedWorkers.length === 0 ? (
                <li className={styles.emptyState}>{STRINGS.attachments.noUnassignedWorkers}</li>
              ) : (
                unassignedWorkers.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className={styles.optionButton}
                      data-testid={`worker-editor-option-${u.id}`}
                      onClick={() => handleAdd(u)}
                    >
                      {u.displayName}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
