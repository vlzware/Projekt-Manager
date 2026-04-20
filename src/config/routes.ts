/**
 * Central route table — single source of truth for:
 *   - URL ↔ view key mapping
 *   - Per-route access rules (role- or permission-based, via a predicate)
 *   - Per-user landing choice (the "default view" after login, §8.1.2)
 *
 * Both the nav renderer (`Header`) and the route guard (`App`) consume
 * this table, so the per-role matrix in `docs/spec/ui/index.md §8.7.1` cannot
 * drift between what the user sees and what the guard allows.
 *
 * Design echoes ADR-0019: explicit, declarative predicate functions
 * over hidden role branching. The spec mixes role-based gating (Kanban,
 * Kalender, Projekte, Kunden) with permission-based gating (Benutzer →
 * `user:read`, Daten → `data:export`), so one predicate shape covers
 * both uniformly.
 *
 * Note on layering: this module sits in the config layer per
 * `eslint.config.js` CONFIG_BANNED, so the predicate parameter is a
 * structural `RouteCaller` rather than the concrete `AuthUser` from
 * `src/api/client.ts`. `AuthUser` is structurally assignable to
 * `RouteCaller`, so callers in the state/UI layers can pass their
 * `authUser` directly. The `view` key is likewise a string literal
 * union mirrored from `src/domain/types.ts`'s `ViewMode` — the
 * `ROUTE_VIEWS` const below asserts exact mirror at compile time.
 */
import type { Role } from '@/config/permissions';
import { hasPermission } from '@/config/permissions';
import { STRINGS } from '@/config/strings';

/**
 * Minimal caller shape the route predicates need. `AuthUser` from
 * `@/api/client` is structurally assignable to this type — the state
 * and UI layers pass their `authUser` directly without a cast.
 */
export interface RouteCaller {
  roles: string[];
}

/**
 * View keys. Mirrors the `ViewMode` union in `src/domain/types.ts`.
 * A compile-time check in `src/hooks/useRouterNav.ts` guarantees the
 * two unions stay in sync; a drift there fails `tsc --noEmit`.
 */
export type RouteView =
  | 'kanban'
  | 'kalender'
  | 'kunden'
  | 'projekte'
  | 'benutzer'
  | 'daten'
  | 'aktivitaet';

export interface RouteEntry {
  /** Stable view key. */
  view: RouteView;
  /** URL path segment (absolute, single level — no parameters today). */
  path: string;
  /** German label used in navigation. Reuses `STRINGS.ui.view*`. */
  label: string;
  /** True iff this caller may enter the route (nav + guard). */
  canAccess: (caller: RouteCaller) => boolean;
  /**
   * True iff this is the landing entry for this caller. Exactly one
   * entry returns true for any given caller (enforced by
   * `assertSingleLanding`).
   */
  isDefaultFor: (caller: RouteCaller) => boolean;
}

/**
 * True iff the caller holds any of the listed roles. Accepts the
 * network-boundary shape `string[]` and coerces via `includes` —
 * unknown role strings are silently ignored, matching the server's
 * role enforcement.
 */
function hasRole(caller: RouteCaller, ...roles: Role[]): boolean {
  return caller.roles.some((r) => (roles as readonly string[]).includes(r));
}

/**
 * Worker / office / owner landing: Kanban (ui/index.md §8.1.2). Kept
 * explicit so a future role that also has Kanban access (e.g. a new
 * "supervisor") does not accidentally inherit the landing.
 */
function landsOnKanban(caller: RouteCaller): boolean {
  return hasRole(caller, 'owner', 'office', 'worker');
}

function landsOnProjects(caller: RouteCaller): boolean {
  // Bookkeeper doesn't have Kanban, so they land on Projekte. Checked
  // by role rather than "no Kanban access" so a future bookkeeper-like
  // role doesn't implicitly land on Projekte without a spec update.
  return hasRole(caller, 'bookkeeper') && !landsOnKanban(caller);
}

/**
 * Route table — ordered to match the nav matrix in `docs/spec/ui/index.md
 * §8.7.1`. The Header renders in this order.
 */
export const ROUTES: readonly RouteEntry[] = [
  {
    view: 'kanban',
    path: '/kanban',
    label: STRINGS.ui.viewKanban,
    canAccess: (u) => hasRole(u, 'owner', 'office', 'worker'),
    isDefaultFor: landsOnKanban,
  },
  {
    view: 'kalender',
    path: '/calendar',
    label: STRINGS.ui.viewCalendar,
    canAccess: (u) => hasRole(u, 'owner', 'office', 'worker'),
    isDefaultFor: () => false,
  },
  {
    view: 'projekte',
    path: '/projects',
    label: STRINGS.ui.viewProjects,
    canAccess: (u) => hasRole(u, 'owner', 'office', 'bookkeeper'),
    isDefaultFor: landsOnProjects,
  },
  {
    view: 'kunden',
    path: '/customers',
    label: STRINGS.ui.viewCustomers,
    canAccess: (u) => hasRole(u, 'owner', 'office', 'bookkeeper'),
    isDefaultFor: () => false,
  },
  {
    view: 'benutzer',
    path: '/users',
    label: STRINGS.ui.viewUsers,
    // View gated on `user:manage` per ui/management.md §8.10 — owner-only under
    // the default role set, matching the nav matrix in §8.7.1.
    // Office holds `user:read` for worker-assignment dropdowns, not
    // administration, and is not admitted here.
    canAccess: (u) => hasPermission(u.roles, 'user:manage'),
    isDefaultFor: () => false,
  },
  {
    view: 'daten',
    path: '/data',
    label: STRINGS.ui.viewData,
    canAccess: (u) => hasPermission(u.roles, 'data:export'),
    isDefaultFor: () => false,
  },
  {
    // View gated on `audit:read` per ui/index.md §8.7.1 — owner and
    // office under the default matrix. Worker and bookkeeper lack
    // `audit:read` and do not see the tab. The per-role visible row set
    // is narrowed server-side (api.md §14.2.8) by the destructive-action
    // scope, so this gate is the nav-visibility concern; data exposure
    // is authoritative on the server.
    view: 'aktivitaet',
    path: '/audit',
    label: STRINGS.ui.viewAudit,
    canAccess: (u) => hasPermission(u.roles, 'audit:read'),
    isDefaultFor: () => false,
  },
] as const;

/**
 * Dev-time invariant: a caller with access to at least one route must
 * land on exactly one. Catches a bug where two `isDefaultFor` predicates
 * overlap, or where a role with route access has no landing. Callers
 * with no route access at all (empty roles, unknown roles) legitimately
 * have no landing — the fallback branch in `landingPathForUser` handles
 * that, and the route guard then renders `NotPermittedView`.
 */
export function assertSingleLanding(caller: RouteCaller): void {
  if (process.env.NODE_ENV === 'production') return;
  const landings = ROUTES.filter((r) => r.isDefaultFor(caller));
  if (landings.length > 1) {
    const names = landings.map((r) => r.view).join(', ');
    throw new Error(
      `routes: expected at most one landing route for caller with roles ` +
        `[${caller.roles.join(', ')}], got ${landings.length} (${names})`,
    );
  }
  if (landings.length === 0 && ROUTES.some((r) => r.canAccess(caller))) {
    throw new Error(
      `routes: caller with roles [${caller.roles.join(', ')}] has route ` +
        `access but no landing route`,
    );
  }
}

/** Route keyed by URL path. `undefined` for unknown paths. */
export function routeByPath(pathname: string): RouteEntry | undefined {
  return ROUTES.find((r) => r.path === pathname);
}

/** Route keyed by view. Throws for unknown views (compile-time impossible today). */
export function routeByView(view: RouteView): RouteEntry {
  const match = ROUTES.find((r) => r.view === view);
  if (!match) {
    throw new Error(`routes: no route for view '${view}'`);
  }
  return match;
}

/** Path → view key. Falls back to 'kanban' for unknown paths (legacy behavior). */
export function viewFromPath(pathname: string): RouteView {
  return routeByPath(pathname)?.view ?? 'kanban';
}

/** View key → path. Total over the `RouteView` union. */
export function pathFromView(view: RouteView): string {
  return routeByView(view).path;
}

/** The nav set this caller sees, in matrix order. */
export function visibleRoutesForUser(caller: RouteCaller): readonly RouteEntry[] {
  return ROUTES.filter((r) => r.canAccess(caller));
}

/**
 * True iff the given view key is this caller's landing. Callers use
 * this to gate "landing-only" affordances (e.g., the backup-freshness
 * badge, AC-170 — visible on the owner's landing, not on `/customers`).
 */
export function isLandingViewForUser(caller: RouteCaller, view: RouteView): boolean {
  const match = ROUTES.find((r) => r.isDefaultFor(caller));
  return match?.view === view;
}

/** The caller's default landing path — used on login and on `/` redirects. */
export function landingPathForUser(caller: RouteCaller): string {
  // Dev-time invariant check — throws if two `isDefaultFor` predicates
  // overlap or none matches. Self-guarded on NODE_ENV so prod is a no-op.
  assertSingleLanding(caller);
  const match = ROUTES.find((r) => r.isDefaultFor(caller));
  // In dev, `assertSingleLanding` has already caught this; in prod,
  // fall back to the first accessible route so an unseen role
  // combination cannot produce an unrecoverable login.
  if (match) return match.path;
  const fallback = ROUTES.find((r) => r.canAccess(caller));
  return fallback?.path ?? '/kanban';
}
