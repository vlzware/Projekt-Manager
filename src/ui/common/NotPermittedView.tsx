/**
 * Not-permitted route surface — rendered by the route guard when an
 * authenticated user requests a path their role cannot access.
 *
 * Per AC-149 (`docs/spec/verification.md §15.21`):
 *   - Visible error message indicating access is denied.
 *   - NO redirect to another view.
 *   - URL in the address bar remains unchanged.
 *
 * The home link is a user-initiated action (not an auto-redirect): it
 * routes to the user's legitimate landing view from the central route
 * table so the offer is always to a permitted destination.
 */
import { useAuthStore } from '@/state/authStore';
import { useRouterNav } from '@/hooks/useRouterNav';
import { landingPathForUser } from '@/config/routes';
import { STRINGS } from '@/config/strings';
import styles from './NotPermittedView.module.css';

export function NotPermittedView() {
  const authUser = useAuthStore((s) => s.authUser);
  const { navigateTo } = useRouterNav();

  // Defensive: the guard only renders this when `authUser` exists, but
  // rendering a useful fallback beats throwing if the auth store clears
  // between mount and paint.
  const homeHref = authUser ? landingPathForUser(authUser) : '/';

  return (
    <div className={styles.container} data-testid="not-permitted-view">
      <div className={styles.panel} role="alert">
        <h2 className={styles.heading}>{STRINGS.ui.notPermittedHeading}</h2>
        <p className={styles.body}>{STRINGS.ui.notPermittedBody}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.homeLink}
            onClick={() => navigateTo(homeHref)}
            data-testid="not-permitted-home"
          >
            {STRINGS.ui.notPermittedHome}
          </button>
        </div>
      </div>
    </div>
  );
}
