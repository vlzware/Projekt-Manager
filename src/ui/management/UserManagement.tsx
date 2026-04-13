/**
 * User management view — list, create, deactivate, reactivate users.
 *
 * Only accessible to users with user:read permission (owner, office).
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 22–24.
 */

import { useEffect, useState } from 'react';
import { useUserStore } from '@/state/userStore';
import { useConfirmStore } from '@/state/confirmStore';
import { STRINGS } from '@/config/strings';
import type { User } from '@/domain/types';
import styles from './Management.module.css';

const AVAILABLE_ROLES = Object.keys(STRINGS.roles);

export function UserManagement() {
  const users = useUserStore((s) => s.users);
  const loading = useUserStore((s) => s.loading);
  const error = useUserStore((s) => s.error);
  const fetchUsers = useUserStore((s) => s.fetchUsers);
  const createUser = useUserStore((s) => s.createUser);
  const deactivateUser = useUserStore((s) => s.deactivateUser);
  const reactivateUser = useUserStore((s) => s.reactivateUser);
  const clearError = useUserStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [formOpen, setFormOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const resetForm = () => {
    setUsername('');
    setDisplayName('');
    setPassword('');
    setSelectedRoles([]);
  };

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleCreate = async () => {
    if (!username.trim() || !displayName.trim() || !password.trim() || selectedRoles.length === 0)
      return;
    setSubmitting(true);

    const ok = await createUser({
      username: username.trim(),
      displayName: displayName.trim(),
      password: password.trim(),
      roles: selectedRoles,
    });

    setSubmitting(false);
    if (ok) {
      setFormOpen(false);
      resetForm();
    }
  };

  const handleDeactivate = async (user: User) => {
    const confirmed = await requestConfirm(STRINGS.ui.deactivateConfirm(user.displayName));
    if (!confirmed) return;

    setSelectedUser(null);
    await deactivateUser(user.id);
  };

  const handleReactivate = async (user: User) => {
    const confirmed = await requestConfirm(STRINGS.ui.reactivateConfirm(user.displayName));
    if (!confirmed) return;

    setSelectedUser(null);
    await reactivateUser(user.id);
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <button
          className={styles.createButton}
          onClick={() => {
            clearError();
            resetForm();
            setSelectedUser(null);
            setFormOpen(true);
          }}
          data-testid="user-create-button"
        >
          {STRINGS.ui.create}
        </button>
      </div>

      {error && !formOpen && !selectedUser && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="user-table">
        <thead>
          <tr>
            <th>{STRINGS.ui.username}</th>
            <th>{STRINGS.ui.displayName}</th>
            <th>{STRINGS.ui.roles}</th>
            <th>{STRINGS.ui.email}</th>
            <th>{STRINGS.ui.status}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              className={u.active ? undefined : `${styles.rowInactive} deactivated`}
              onClick={() => {
                setSelectedUser(u);
                setFormOpen(false);
                clearError();
              }}
            >
              <td>{u.username}</td>
              <td>{u.displayName}</td>
              <td>{u.roles.map((r) => STRINGS.roles[r] ?? r).join(', ')}</td>
              <td>{u.email ?? '—'}</td>
              <td>
                <span
                  className={`${styles.badge} ${u.active ? styles.badgeActive : styles.badgeInactive}`}
                >
                  {u.active ? STRINGS.ui.active : STRINGS.ui.inactive}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && users.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {/* Create form */}
      {formOpen && (
        <div className={styles.formOverlay} onClick={() => setFormOpen(false)}>
          <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.formTitle}>
              {STRINGS.entities.user} {STRINGS.ui.create}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.username} *</label>
              <input
                className={styles.formInput}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="user-username-input"
                autoFocus
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.displayName} *</label>
              <input
                className={styles.formInput}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="user-displayname-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.auth.password} *</label>
              <input
                className={styles.formInput}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="user-password-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.roles} *</label>
              <div className={styles.checkboxGroup}>
                {AVAILABLE_ROLES.map((role) => (
                  <label key={role} className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={selectedRoles.includes(role)}
                      onChange={() => toggleRole(role)}
                      data-testid={`user-role-${role}`}
                    />
                    {STRINGS.roles[role]}
                  </label>
                ))}
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
                disabled={
                  submitting ||
                  !username.trim() ||
                  !displayName.trim() ||
                  !password.trim() ||
                  selectedRoles.length === 0
                }
                data-testid="user-submit"
              >
                {STRINGS.ui.create}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User detail / deactivate / reactivate */}
      {selectedUser && !formOpen && (
        <div className={styles.formOverlay} onClick={() => setSelectedUser(null)}>
          <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.formTitle}>{selectedUser.displayName}</h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.username}</label>
              <div>{selectedUser.username}</div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.roles}</label>
              <div>{selectedUser.roles.map((r) => STRINGS.roles[r] ?? r).join(', ')}</div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.status}</label>
              <span
                className={`${styles.badge} ${selectedUser.active ? styles.badgeActive : styles.badgeInactive}`}
              >
                {selectedUser.active ? STRINGS.ui.active : STRINGS.ui.inactive}
              </span>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={() => setSelectedUser(null)}>
                {STRINGS.ui.close}
              </button>
              {selectedUser.active ? (
                <button
                  className={styles.dangerButton}
                  onClick={() => handleDeactivate(selectedUser)}
                  data-testid="user-deactivate-button"
                >
                  {STRINGS.ui.deactivate}
                </button>
              ) : (
                <button
                  className={styles.actionButton}
                  onClick={() => handleReactivate(selectedUser)}
                  data-testid="user-reactivate-button"
                >
                  {STRINGS.ui.reactivate}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
