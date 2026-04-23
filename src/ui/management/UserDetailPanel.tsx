/**
 * Detail panel for a user row — also hosts the admin actions:
 * reset password, deactivate, reactivate, delete.
 */

import { useCallback, useState } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUserStore } from '@/state/userStore';
import { useConfirmStore } from '@/state/confirmStore';
import { usePermission } from '@/hooks/usePermission';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { User } from '@/domain/types';
import styles from './Management.module.css';

interface Props {
  user: User;
  onClose: () => void;
}

export function UserDetailPanel({ user, onClose }: Props) {
  const authUser = useAuthStore((s) => s.authUser);
  const canManage = usePermission('user:manage');
  const canDelete = usePermission('user:delete');

  const deactivateUser = useUserStore((s) => s.deactivateUser);
  const reactivateUser = useUserStore((s) => s.reactivateUser);
  const deleteUser = useUserStore((s) => s.deleteUser);
  const updateUser = useUserStore((s) => s.updateUser);
  const resetUserPassword = useUserStore((s) => s.resetPassword);
  const clearError = useUserStore((s) => s.clearError);
  const error = useUserStore((s) => s.error);
  const requestConfirm = useConfirmStore((s) => s.request);

  const [submitting, setSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPw, setResetPw] = useState('');
  const [resetPwConfirm, setResetPwConfirm] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [emailDraft, setEmailDraft] = useState(user.email ?? '');

  const resetPwMatch = resetPw === resetPwConfirm;

  const close = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEscapeKey(close);

  const handleDeactivate = async () => {
    const confirmed = await requestConfirm(STRINGS.ui.deactivateConfirm(user.displayName));
    if (!confirmed) return;
    onClose();
    await deactivateUser(user.id);
  };

  const handleReactivate = async () => {
    const confirmed = await requestConfirm(STRINGS.ui.reactivateConfirm(user.displayName));
    if (!confirmed) return;
    onClose();
    await reactivateUser(user.id);
  };

  const handleDelete = async () => {
    const confirmed = await requestConfirm(STRINGS.ui.deleteConfirm(user.displayName));
    if (!confirmed) return;
    onClose();
    await deleteUser(user.id);
  };

  const handleResetPassword = async () => {
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

  const openResetForm = () => {
    setResetOpen(true);
    setResetSuccess(false);
    setResetPw('');
    setResetPwConfirm('');
    clearError();
  };

  const cancelResetForm = () => {
    if (submitting) return;
    setResetOpen(false);
    setResetPw('');
    setResetPwConfirm('');
  };

  return (
    <div className={styles.formOverlay}>
      <div className={styles.formPanel}>
        <h2 className={styles.formTitle}>{user.displayName}</h2>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.username}</label>
          <div>{user.username}</div>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.roles}</label>
          <div>{user.roles.map((r) => STRINGS.roles[r] ?? r).join(', ')}</div>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.email}</label>
          {canManage ? (
            <input
              className={styles.formInput}
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onBlur={() => {
                const trimmed = emailDraft.trim();
                const next = trimmed ? trimmed : null;
                if (next === (user.email ?? null)) return;
                void updateUser(user.id, { email: next });
              }}
              disabled={submitting}
              data-testid="user-email-input"
              autoComplete="email"
            />
          ) : (
            <div>{user.email ?? '—'}</div>
          )}
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.status}</label>
          <span
            className={`${styles.badge} ${user.active ? styles.badgeActive : styles.badgeInactive}`}
          >
            {user.active ? STRINGS.ui.active : STRINGS.ui.inactive}
          </span>
        </div>

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
                    onClick={cancelResetForm}
                    disabled={submitting}
                  >
                    {STRINGS.ui.cancel}
                  </button>
                  <button
                    className={styles.submitButton}
                    onClick={() => void handleResetPassword()}
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
          <button className={styles.cancelButton} onClick={close} disabled={submitting}>
            {STRINGS.ui.close}
          </button>
          {canManage && !resetOpen && (
            <button
              className={styles.actionButton}
              onClick={openResetForm}
              data-testid="user-reset-pw-button"
            >
              {STRINGS.password.resetPassword}
            </button>
          )}
          {canManage && user.active && (
            <button
              className={styles.dangerButton}
              onClick={() => void handleDeactivate()}
              data-testid="user-deactivate-button"
            >
              {STRINGS.ui.deactivate}
            </button>
          )}
          {canManage && !user.active && (
            <button
              className={styles.actionButton}
              onClick={() => void handleReactivate()}
              data-testid="user-reactivate-button"
            >
              {STRINGS.ui.reactivate}
            </button>
          )}
          {canDelete && user.id !== authUser?.id && (
            <button
              className={styles.dangerButton}
              onClick={() => void handleDelete()}
              data-testid="user-delete-button"
            >
              {STRINGS.ui.delete}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
