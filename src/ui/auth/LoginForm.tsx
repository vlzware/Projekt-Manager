/**
 * LoginForm — stub component for TDD.
 * Tests in src/ui/__tests__/auth.test.tsx define the expected behavior.
 *
 * This stub renders the form structure so CT-18 (field rendering) passes.
 * Login logic (API call, error handling, navigation) will be implemented
 * when the store gains login/logout actions and the API client exists.
 */
export function LoginForm() {
  return (
    <form>
      <label htmlFor="username">Benutzername</label>
      <input id="username" type="text" />
      <label htmlFor="password">Passwort</label>
      <input id="password" type="password" />
      <button type="submit">Anmelden</button>
    </form>
  );
}
