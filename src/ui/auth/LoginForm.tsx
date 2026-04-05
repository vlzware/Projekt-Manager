import { useState } from 'react';
import { useProjectStore } from '@/state/store';
import styles from './LoginForm.module.css';

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const login = useProjectStore((s) => s.login);
  const authError = useProjectStore((s) => s.authError);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await login(username, password);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      <form data-testid="login-form" className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Anmelden</h1>

        {authError && (
          <div className={styles.error}>{authError}</div>
        )}

        <div className={styles.field}>
          <label htmlFor="login-username" className={styles.label}>
            Benutzername
          </label>
          <input
            data-testid="login-username"
            id="login-username"
            type="text"
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="login-password" className={styles.label}>
            Passwort
          </label>
          <input
            data-testid="login-password"
            id="login-password"
            type="password"
            className={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" className={styles.submitButton} disabled={isSubmitting || !username.trim() || !password.trim()}>
          Anmelden
        </button>
      </form>
    </div>
  );
}
