/**
 * "Passwort ändern" modal — self-service password change.
 *
 * Triggered from the user menu in the Header (spec §8.7.2).
 * Calls POST /api/auth/change-password (current + new + confirmation).
 */

import { useState } from 'react';
import { changePassword } from '@/state/authStore';
import { STRINGS } from '@/config/strings';
import styles from '../management/Management.module.css';

interface Props {
  onClose: () => void;
}

export function PasswordChangeModal({ onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const passwordsMatch = newPassword === confirmPassword;
  const canSubmit =
    currentPassword.trim() && newPassword.trim() && confirmPassword.trim() && passwordsMatch;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const result = await changePassword(currentPassword, newPassword);

    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setSuccess(true);
  };

  return (
    <div className={styles.formOverlay} onClick={onClose}>
      <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.formTitle}>{STRINGS.password.change}</h2>

        {success ? (
          <>
            <div className={styles.resultBox}>{STRINGS.password.changeSuccess}</div>
            <div className={styles.formActions}>
              <button
                className={styles.submitButton}
                onClick={onClose}
                data-testid="pw-change-done"
              >
                {STRINGS.ui.ok}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.password.currentPassword} *</label>
              <input
                className={styles.formInput}
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                data-testid="pw-change-current"
                autoFocus
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.password.newPassword} *</label>
              <input
                className={styles.formInput}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                data-testid="pw-change-new"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.password.confirm} *</label>
              <input
                className={styles.formInput}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                data-testid="pw-change-confirm"
              />
              {newPassword && confirmPassword && !passwordsMatch && (
                <div className={styles.error}>{STRINGS.password.mismatch}</div>
              )}
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={onClose}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleSubmit}
                disabled={submitting || !canSubmit}
                data-testid="pw-change-submit"
              >
                {STRINGS.password.change}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
