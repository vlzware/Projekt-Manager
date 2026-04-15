/**
 * User management view — list, create, deactivate, reactivate, reset password.
 *
 * Only accessible to users with user:read permission (owner, office).
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 22–24.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUserStore } from '@/state/userStore';
import { useConfirmStore } from '@/state/confirmStore';
import { usePermission } from '@/hooks/usePermission';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { User } from '@/domain/types';
import styles from './Management.module.css';

const AVAILABLE_ROLES = Object.keys(STRINGS.roles);

export function UserManagement() {
  const authUser = useAuthStore((s) => s.authUser);
  const canManage = usePermission('user:manage');
  const canDelete = usePermission('user:delete');

  const users = useUserStore((s) => s.users);
  const loading = useUserStore((s) => s.loading);
  const error = useUserStore((s) => s.error);
  const fetchUsers = useUserStore((s) => s.fetchUsers);
  const createUser = useUserStore((s) => s.createUser);
  const deactivateUser = useUserStore((s) => s.deactivateUser);
  const reactivateUser = useUserStore((s) => s.reactivateUser);
  const deleteUser = useUserStore((s) => s.deleteUser);
  const resetUserPassword = useUserStore((s) => s.resetPassword);
  const clearError = useUserStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [formOpen, setFormOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPw, setResetPw] = useState('');
  const [resetPwConfirm, setResetPwConfirm] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const resetForm = () => {
    setUsername('');
    setDisplayName('');
    setPassword('');
    setPasswordConfirm('');
    setSelectedRoles([]);
  };

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const passwordsMatch = password === passwordConfirm;

  const handleCreate = async () => {
    if (
      submitting ||
      !username.trim() ||
      !displayName.trim() ||
      !password.trim() ||
      !passwordsMatch ||
      selectedRoles.length === 0
    )
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

  const resetPwMatch = resetPw === resetPwConfirm;

  const handleDelete = async (user: User) => {
    const confirmed = await requestConfirm(STRINGS.ui.deleteConfirm(user.displayName));
    if (!confirmed) return;

    setSelectedUser(null);
    await deleteUser(user.id);
  };

  const handleResetPassword = async (user: User) => {
    if (submitting || !resetPw.trim() || !resetPwMatch) return;
    setSubmitting(true);

    const ok = await resetUserPassword(user.id, resetPw);
    setSubmitting(false);

    if (ok) {
      setResetSuccess(true);
      setResetPw('');
      setResetPwConfirm('');
    }
  };

  const closeCreateForm = useCallback(() => {
    if (submitting) return;
    setFormOpen(false);
  }, [submitting]);

  const closeDetailPanel = useCallback(() => {
    if (submitting) return;
    setSelectedUser(null);
    setResetOpen(false);
    setResetSuccess(false);
  }, [submitting]);

  useEscapeKey(closeCreateForm, formOpen);
  useEscapeKey(closeDetailPanel, !!selectedUser && !formOpen);

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
        {canManage && (
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
        )}
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
              className={`${styles.clickableRow} ${u.active ? '' : `${styles.rowInactive} deactivated`}`}
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
        <div className={styles.formOverlay}>
          <div className={styles.formPanel}>
            <h2 className={styles.formTitle}>
              {STRINGS.entities.user} {STRINGS.ui.create}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.username} *</label>
              <input
                className={styles.formInput}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
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
                disabled={submitting}
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
                disabled={submitting}
                data-testid="user-password-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.password.confirm} *</label>
              <input
                className={styles.formInput}
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                disabled={submitting}
                data-testid="user-password-confirm-input"
              />
              {password && passwordConfirm && !passwordsMatch && (
                <div className={styles.error}>{STRINGS.password.mismatch}</div>
              )}
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
                      disabled={submitting}
                      data-testid={`user-role-${role}`}
                    />
                    {STRINGS.roles[role]}
                  </label>
                ))}
              </div>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                className={styles.cancelButton}
                onClick={closeCreateForm}
                disabled={submitting}
              >
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
                  !passwordsMatch ||
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

      {/* User detail / deactivate / reactivate / reset password */}
      {selectedUser && !formOpen && (
        <div className={styles.formOverlay}>
          <div className={styles.formPanel}>
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

            {/* Reset password section (owner only) */}
            {canManage && resetOpen && (
              <div className={styles.sectionDivider}>
                {resetSuccess ? (
                  <div className={styles.resultBox}>{STRINGS.password.resetSuccess}</div>
                ) : (
                  <>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>{STRINGS.password.newPassword} *</label>
                      <input
                        className={styles.formInput}
                        type="password"
                        value={resetPw}
                        onChange={(e) => setResetPw(e.target.value)}
                        disabled={submitting}
                        data-testid="user-reset-pw-input"
                        autoFocus
                      />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>{STRINGS.password.confirm} *</label>
                      <input
                        className={styles.formInput}
                        type="password"
                        value={resetPwConfirm}
                        onChange={(e) => setResetPwConfirm(e.target.value)}
                        disabled={submitting}
                        data-testid="user-reset-pw-confirm"
                      />
                      {resetPw && resetPwConfirm && !resetPwMatch && (
                        <div className={styles.error}>{STRINGS.password.mismatch}</div>
                      )}
                    </div>
                    <div className={styles.formActions}>
                      <button
                        className={styles.cancelButton}
                        onClick={() => {
                          if (submitting) return;
                          setResetOpen(false);
                          setResetPw('');
                          setResetPwConfirm('');
                        }}
                        disabled={submitting}
                      >
                        {STRINGS.ui.cancel}
                      </button>
                      <button
                        className={styles.submitButton}
                        onClick={() => handleResetPassword(selectedUser)}
                        disabled={submitting || !resetPw.trim() || !resetPwMatch}
                        data-testid="user-reset-pw-submit"
                      >
                        {STRINGS.password.resetPassword}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                className={styles.cancelButton}
                onClick={closeDetailPanel}
                disabled={submitting}
              >
                {STRINGS.ui.close}
              </button>
              {canManage && !resetOpen && (
                <button
                  className={styles.actionButton}
                  onClick={() => {
                    setResetOpen(true);
                    setResetSuccess(false);
                    setResetPw('');
                    setResetPwConfirm('');
                    clearError();
                  }}
                  data-testid="user-reset-pw-button"
                >
                  {STRINGS.password.resetPassword}
                </button>
              )}
              {canManage && selectedUser.active && (
                <button
                  className={styles.dangerButton}
                  onClick={() => handleDeactivate(selectedUser)}
                  data-testid="user-deactivate-button"
                >
                  {STRINGS.ui.deactivate}
                </button>
              )}
              {canManage && !selectedUser.active && (
                <button
                  className={styles.actionButton}
                  onClick={() => handleReactivate(selectedUser)}
                  data-testid="user-reactivate-button"
                >
                  {STRINGS.ui.reactivate}
                </button>
              )}
              {canDelete && selectedUser.id !== authUser?.id && (
                <button
                  className={styles.dangerButton}
                  onClick={() => handleDelete(selectedUser)}
                  data-testid="user-delete-button"
                >
                  {STRINGS.ui.delete}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
