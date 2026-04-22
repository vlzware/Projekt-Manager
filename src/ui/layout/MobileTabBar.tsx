/**
 * Phone-only bottom tab bar — Android-style primary nav.
 *
 * Renders the user's primary destinations (everything visible in nav
 * except the secondary "Verwaltung" set) as icons + labels, fixed to
 * the bottom of the viewport. Hidden at >= md via CSS — the desktop
 * keeps the top nav pill.
 *
 * The header's primary nav buttons are hidden in the same breakpoint
 * (Header.module.css), so the two surfaces never compete on a phone.
 * Verwaltung / email-extract / backup badge / user menu remain in the
 * top header on every viewport because they are admin / status
 * affordances, not destinations the worker reaches every minute.
 */
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav } from '@/hooks/useRouterNav';
import { visibleRoutesForUser, type RouteView } from '@/config/routes';
import { TAB_BAR_ICONS } from './tabBarIcons';
import styles from './MobileTabBar.module.css';

const SECONDARY_VIEWS: readonly RouteView[] = [
  'benutzer',
  'daten',
  'aktivitaet',
  'benachrichtigungen',
];

export function MobileTabBar() {
  const authUser = useAuthStore((s) => s.authUser);
  const activeView = useUIStore((s) => s.activeView);
  const { navigateTo } = useRouterNav();

  if (!authUser) return null;

  const primaryRoutes = visibleRoutesForUser(authUser).filter(
    (r) => !SECONDARY_VIEWS.includes(r.view),
  );

  // Empty primary set (e.g. unknown-role caller) — render nothing
  // rather than an empty bar that would steal vertical real estate.
  if (primaryRoutes.length === 0) return null;

  return (
    <nav className={styles.tabBar} data-testid="mobile-tab-bar" aria-label="Hauptnavigation">
      {primaryRoutes.map((r) => {
        const active = r.view === activeView;
        const Icon = TAB_BAR_ICONS[r.view];
        return (
          <button
            key={r.view}
            type="button"
            className={`${styles.tab} ${active ? styles.tabActive : ''}`}
            onClick={() => navigateTo(r.path)}
            data-testid={`tab-bar-${r.view}`}
            aria-current={active ? 'page' : undefined}
          >
            {Icon && <Icon className={styles.icon} />}
            <span className={styles.label}>{r.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
