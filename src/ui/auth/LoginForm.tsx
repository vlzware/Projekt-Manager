import { useState } from 'react';
import { useProjectStore } from '@/state/store';
import styles from './LoginForm.module.css';

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useProjectStore((s) => s.login);
  const authError = useProjectStore((s) => s.authError);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await login(username, password);
  };

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Anmelden</h1>

        {authError && (
          <div className={styles.error}>{authError}</div>
        )}

        <div className={styles.field}>
          <label htmlFor="login-username" className={styles.label}>
            Benutzername
          </label>
          <input
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
            id="login-password"
            type="password"
            className={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" className={styles.submitButton}>
          Anmelden
        </button>
      </form>
    </div>
  );
}
