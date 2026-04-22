import { useState } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { BRANDING } from '@/config/brandingConfig';
import { STRINGS } from '@/config/strings';
import styles from './LoginForm.module.css';

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const login = useAuthStore((s) => s.login);
  const authError = useAuthStore((s) => s.authError);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await login(username, password);
      if (useAuthStore.getState().authUser) {
        fetchProjects();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.appName}>{BRANDING.appName}</h1>
      <form data-testid="login-form" className={styles.form} onSubmit={handleSubmit}>
        <h2 className={styles.title}>{STRINGS.auth.loginButton}</h2>

        {authError && (
          <div className={styles.error} data-testid="login-error">
            {authError}
          </div>
        )}

        <div className={styles.field}>
          <label htmlFor="login-username" className={styles.label}>
            {STRINGS.auth.username}
          </label>
          <input
            data-testid="login-username"
            id="login-username"
            type="text"
            autoComplete="username"
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="login-password" className={styles.label}>
            {STRINGS.auth.password}
          </label>
          <input
            data-testid="login-password"
            id="login-password"
            type="password"
            autoComplete="current-password"
            className={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        <button
          type="submit"
          data-testid="login-submit"
          className={styles.submitButton}
          disabled={isSubmitting || !username.trim() || !password.trim()}
        >
          {STRINGS.auth.loginButton}
        </button>
      </form>
    </div>
  );
}
