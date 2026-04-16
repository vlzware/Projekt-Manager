import { test, expect, type Page } from '@playwright/test';
import { STRINGS } from '../src/config/strings';

/**
 * Permission-based UI visibility (AC-121 [crit]) + per-role nav matrix
 * (AC-75 [vis]) + forbidden-URL probe (AC-149 [vis]).
 *
 * Verifies that every action-triggering UI control is hidden for users
 * whose roles do not grant the backing permission. This is the client
 * side of the `requirePermission` contract — the server is always
 * authoritative, but rendering an affordance that always 403s is
 * misleading state (ADR-0014 Tier-1).
 *
 * Each role logs in fresh (storageState override) so the suite exercises
 * each role's derived `usePermission(...)` result in a real render,
 * not against a mock. Login round-trips stay well within the dev server
 * rate-limit (LOGIN_RATE_LIMIT_MAX=30 — see playwright.config.ts).
 *
 * Asserts with toHaveCount / toBeVisible / toHaveURL — NOT screenshots —
 * because AC-121 / AC-149 are critical-ish behavior, and the nav-matrix
 * (AC-75) is verified structurally (tab presence/absence) rather than
 * by eye.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

interface RoleCase {
  username: string;
  /** Access to the Kanban view (ui.md §8.7.1 — owner/office/worker). */
  canSeeKanban: boolean;
  /** Access to the Projekte/Kunden management views (owner/office/bookkeeper). */
  canSeeManagement: boolean;
  canReadUsers: boolean;
  canManageUsers: boolean;
  canDeleteUsers: boolean;
  canExtract: boolean;
  canCreateProject: boolean;
  canUpdateProject: boolean;
  canDeleteProject: boolean;
  canTransition: boolean;
  canUpdateDates: boolean;
  canCreateCustomer: boolean;
  canDeleteCustomer: boolean;
  /** `data:export` — gates Daten tab visibility and the export action. */
  canExportData: boolean;
  /** `data:restore` — gates the import form inside the Daten view. */
  canRestoreData: boolean;
}

/**
 * Expected visibility derived from ROLE_PERMISSIONS in
 * `src/config/permissions.ts` AND the nav matrix in
 * `docs/spec/ui.md §8.7.1` (AC-75). Keep in sync when either changes.
 */
const roleCases: Record<Role, RoleCase> = {
  owner: {
    username: 'inhaber',
    canSeeKanban: true,
    canSeeManagement: true,
    canReadUsers: true,
    canManageUsers: true,
    canDeleteUsers: true,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: true,
    canExportData: true,
    canRestoreData: true,
  },
  office: {
    username: 'buero',
    canSeeKanban: true,
    canSeeManagement: true,
    // Per the nav matrix in `docs/spec/ui.md §8.7.1` (AC-75), the
    // Benutzer tab is owner-only even though office holds `user:read`
    // in `permissions.ts`. The client-side route predicate gates
    // Benutzer on `user:manage` (owner-only) to make the nav match
    // the spec. See `src/config/routes.ts` for the rationale.
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: false,
    canExportData: true,
    canRestoreData: false,
  },
  worker: {
    username: 'arbeiter1',
    canSeeKanban: true,
    canSeeManagement: false,
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canExportData: false,
    canRestoreData: false,
  },
  bookkeeper: {
    username: 'buchhalter',
    canSeeKanban: false,
    canSeeManagement: true,
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canExportData: false,
    canRestoreData: false,
  },
};

async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();
  // Wait for the authenticated layout — `header` mounts on every role's
  // landing view. The previous wait on `kanban-board` hung for bookkeeper,
  // whose landing is `/projects` per the central route table.
  await page.getByTestId('header').waitFor();
}

test.describe('AC-121: permission-based UI visibility', () => {
  // Each test logs in fresh — override the shared authenticated storage state.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [role, c] of Object.entries(roleCases) as [Role, RoleCase][]) {
    test(`${role} — action controls match ROLE_PERMISSIONS`, async ({ page }) => {
      await loginAs(page, c.username);

      // -- Header navigation and extract button --------------------------
      // Nav visibility is driven by the central route table (§8.7.1).
      await expect(page.getByTestId('view-toggle-kanban')).toHaveCount(c.canSeeKanban ? 1 : 0);
      await expect(page.getByTestId('view-toggle-projekte')).toHaveCount(
        c.canSeeManagement ? 1 : 0,
      );
      await expect(page.getByTestId('view-toggle-kunden')).toHaveCount(c.canSeeManagement ? 1 : 0);
      await expect(page.getByTestId('view-toggle-benutzer')).toHaveCount(c.canReadUsers ? 1 : 0);
      await expect(page.getByTestId('extract-button')).toHaveCount(c.canExtract ? 1 : 0);

      // -- Kanban view: transition controls on cards and detail panel ----
      // Only reachable when Kanban is in the role's nav matrix. Roles
      // without Kanban access (bookkeeper) cannot navigate there at all;
      // the server-side scoping for transitions is covered by unit tests.
      if (c.canSeeKanban) {
        await page.getByTestId('view-toggle-kanban').click();
        await page.getByTestId('kanban-board').waitFor();
        // Wait until at least one card has rendered — the subsequent
        // `forward-button-*` count assertion races the initial fetch
        // otherwise and reports 0 before any card mounts.
        await page.locator('[data-testid^="project-card-"]').first().waitFor();

        // Forward arrow on any card in a transitionable state.
        const cardForwardCount = await page.locator('[data-testid^="forward-button-"]').count();
        if (c.canTransition) {
          expect(cardForwardCount).toBeGreaterThan(0);
        } else {
          expect(cardForwardCount).toBe(0);
        }

        // Project detail panel (open first card).
        await page.locator('[data-testid^="project-card-"]').first().click();
        await page.getByTestId('detail-panel').waitFor();

        const detailForward = await page.getByTestId('detail-forward-button').count();
        const detailBackward = await page.getByTestId('detail-backward-button').count();
        if (c.canTransition) {
          // Anfrage hides backward, Erledigt hides forward — but every
          // state allows at least one direction, so the sum is ≥ 1 when
          // permitted.
          expect(detailForward + detailBackward).toBeGreaterThan(0);
        } else {
          expect(detailForward).toBe(0);
          expect(detailBackward).toBe(0);
        }

        await expect(page.getByTestId('detail-date-start')).toHaveCount(c.canUpdateDates ? 1 : 0);
        await expect(page.getByTestId('detail-date-end')).toHaveCount(c.canUpdateDates ? 1 : 0);

        await page.getByTestId('detail-close').click();
      }

      // -- Projekte management view --------------------------------------
      // Only owner / office / bookkeeper see the Projekte tab (ui.md
      // §8.7.1 — worker is excluded). Skip the management assertions
      // entirely for worker since the view is not navigable.
      if (c.canSeeManagement) {
        await page.getByTestId('view-toggle-projekte').click();
        await page.getByTestId('project-table').locator('tbody tr').first().waitFor();

        await expect(page.getByTestId('project-create-button')).toHaveCount(
          c.canCreateProject ? 1 : 0,
        );

        const projectArchiveBtns = page
          .getByTestId('project-table')
          .getByTestId('project-archive-button');
        if (c.canDeleteProject) {
          expect(await projectArchiveBtns.count()).toBeGreaterThan(0);
        } else {
          expect(await projectArchiveBtns.count()).toBe(0);
        }

        // Edit-form Save button: click into first row to open the form.
        // For bookkeeper the form opens but Save is hidden — no
        // mutation trigger, so the "details view" is the intentional
        // fallback.
        await page.getByTestId('project-table').locator('tbody tr').first().click();
        await expect(page.getByTestId('project-save')).toHaveCount(c.canUpdateProject ? 1 : 0);
        await page.getByRole('button', { name: 'Abbrechen' }).click();

        // -- Kunden management view --------------------------------------
        await page.getByTestId('view-toggle-kunden').click();
        await page.getByTestId('customer-table').locator('tbody tr').first().waitFor();

        await expect(page.getByTestId('customer-create-button')).toHaveCount(
          c.canCreateCustomer ? 1 : 0,
        );

        const customerDeleteBtns = page
          .getByTestId('customer-table')
          .locator('tbody button', { hasText: /löschen/i });
        if (c.canDeleteCustomer) {
          expect(await customerDeleteBtns.count()).toBeGreaterThan(0);
        } else {
          expect(await customerDeleteBtns.count()).toBe(0);
        }
      }

      // -- Daten (unified data-exchange) view ----------------------------
      // AC-142: the Daten tab itself is gated on `data:export`. Roles
      // without it must not see the nav toggle at all. Inside the view,
      // the import sub-form is gated on `data:restore` (owner only).
      await expect(page.getByTestId('view-toggle-daten')).toHaveCount(c.canExportData ? 1 : 0);
      if (c.canExportData) {
        await page.getByTestId('view-toggle-daten').click();
        await page.getByTestId('daten-view').waitFor();

        await expect(page.getByTestId('data-export-button')).toHaveCount(1);
        await expect(page.getByTestId('data-import-file-input')).toHaveCount(
          c.canRestoreData ? 1 : 0,
        );
      }

      // -- Benutzer management view (only if user:read) ------------------
      if (c.canReadUsers) {
        await page.getByTestId('view-toggle-benutzer').click();
        await page.getByTestId('user-table').locator('tbody tr').first().waitFor();

        await expect(page.getByTestId('user-create-button')).toHaveCount(c.canManageUsers ? 1 : 0);

        // Open a user detail to check the management action buttons.
        // Target `buchhalter` — always active and never the logged-in
        // user (owner or office), so deactivate visibility reflects
        // `user:manage` and delete visibility reflects `user:delete`,
        // without interference from the self-delete guard or the
        // inactive-user reactivate branch. Picked by content because
        // the list API does not guarantee row order (repositories/user.ts
        // has no ORDER BY — tracked separately).
        const targetRow = page
          .getByTestId('user-table')
          .locator('tbody tr', { hasText: 'buchhalter' });
        await expect(targetRow).toHaveCount(1);
        await targetRow.click();

        await expect(page.getByTestId('user-deactivate-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );
        await expect(page.getByTestId('user-reset-pw-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );
        await expect(page.getByTestId('user-delete-button')).toHaveCount(c.canDeleteUsers ? 1 : 0);
      }
    });
  }
});

/**
 * AC-75 — per-role nav visibility matrix (docs/spec/ui.md §8.7.1).
 *
 * Distinct from AC-121 above: AC-75 pins the nav _set_ per role (which
 * tabs render in the header), AC-121 pins action-control visibility
 * inside each view. The existing `permission-visibility` walk asserts
 * individual tabs per permission, but does not cover `view-toggle-kalender`
 * and does not check "exactly these tabs, no others" as a single contract.
 *
 * This block pins both clauses: every matrix tab is visible for its
 * role, and every non-matrix tab is hidden. Source of truth is the same
 * MATRIX constant used by `src/config/__tests__/routes.test.ts` and
 * `src/ui/layout/__tests__/Header.test.tsx` — the three levels (config,
 * component, E2E) assert the same matrix against progressively more
 * integrated stacks.
 */
// View keys mirror `RouteView` in `src/config/routes.ts`. Duplicated
// here (rather than imported) because the e2e harness runs under
// Playwright's TS config, not Vite's — the path alias `@/config/*`
// isn't resolvable here without extra tooling. The unit test
// `src/config/__tests__/routes.test.ts` pins the matrix against the
// live route table, so drift between the table and this constant
// surfaces there long before a browser run.
type NavView = 'kanban' | 'kalender' | 'projekte' | 'kunden' | 'benutzer' | 'daten';

const NAV_MATRIX: Record<Role, readonly NavView[]> = {
  owner: ['kanban', 'kalender', 'projekte', 'kunden', 'benutzer', 'daten'],
  office: ['kanban', 'kalender', 'projekte', 'kunden', 'daten'],
  worker: ['kanban', 'kalender'],
  bookkeeper: ['projekte', 'kunden'],
};

const ALL_VIEWS: readonly NavView[] = [
  'kanban',
  'kalender',
  'projekte',
  'kunden',
  'benutzer',
  'daten',
];

test.describe('AC-75: per-role nav visibility matrix', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [role, expected] of Object.entries(NAV_MATRIX) as [Role, readonly NavView[]][]) {
    test(`${role} — header nav set matches the ui.md §8.7.1 matrix exactly`, async ({ page }) => {
      await loginAs(page, roleCases[role].username);

      // Every matrix tab must be visible for this role.
      for (const view of expected) {
        await expect(page.getByTestId(`view-toggle-${view}`)).toBeVisible();
      }

      // Every non-matrix tab must be absent. toHaveCount(0) rather than
      // toBeHidden() because the latter passes for elements that exist
      // but are CSS-hidden; the nav renderer should not emit the tab at
      // all for unauthorized views (AC-75 "hidden from navigation").
      const forbidden = ALL_VIEWS.filter((v) => !expected.includes(v));
      for (const view of forbidden) {
        await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(0);
      }
    });
  }
});

/**
 * AC-149 — manual URL entry to a forbidden path presents the explicit
 * not-permitted error surface (`NotPermittedView`), the URL stays put,
 * and no other view-level content renders.
 *
 * Owner has no forbidden path under the default role set, so there is
 * no negative case to walk — the positive-path check inside the AC-121
 * block above already exercises owner landing on a permitted URL.
 *
 * Parametrized by role × forbidden-path. Representative combinations
 * cover every role that has at least one forbidden route; the component
 * test `src/ui/common/__tests__/NotPermittedView.test.tsx` already pins
 * the full role × path matrix at the component level (MemoryRouter),
 * so this E2E focuses on the browser-level integration: URL stays,
 * not-permitted view renders, no landing view mounts.
 */
interface ForbiddenCase {
  role: Role;
  path: string;
}

const FORBIDDEN_PATHS: readonly ForbiddenCase[] = [
  { role: 'worker', path: '/customers' }, // AC-149 example
  { role: 'worker', path: '/projects' },
  { role: 'worker', path: '/users' },
  { role: 'worker', path: '/data' },
  { role: 'bookkeeper', path: '/kanban' },
  { role: 'bookkeeper', path: '/calendar' },
  { role: 'bookkeeper', path: '/users' },
  { role: 'bookkeeper', path: '/data' },
  { role: 'office', path: '/users' },
];

// Landing-view testids that should NOT render when the guard is active.
// Any of these rendering alongside `not-permitted-view` would indicate
// the guard leaked content for the forbidden path.
const VIEW_TESTIDS: readonly string[] = [
  'kanban-board',
  'calendar-view',
  'project-table',
  'customer-table',
  'user-table',
  'daten-view',
];

test.describe('AC-149: forbidden URL probe → NotPermittedView, URL unchanged', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const { role, path } of FORBIDDEN_PATHS) {
    test(`${role} navigating directly to ${path} sees not-permitted surface and URL stays`, async ({
      page,
    }) => {
      // Log in first — the auth guard renders the login form for
      // unauthenticated callers, which would mask the route-guard path.
      await loginAs(page, roleCases[role].username);

      // Direct URL entry — simulates a user typing the path or
      // following a bookmark to an off-matrix view.
      await page.goto(path);

      // The not-permitted surface renders with the German copy sourced
      // from STRINGS (no hardcoded strings in the spec).
      const surface = page.getByTestId('not-permitted-view');
      await expect(surface).toBeVisible();
      await expect(surface).toContainText(STRINGS.ui.notPermittedHeading);
      await expect(surface).toContainText(STRINGS.ui.notPermittedBody);

      // AC-149 clause: "URL in the address bar remains unchanged".
      // Playwright's auto-waiting toHaveURL handles the navigation
      // settling; no raw waitForTimeout required.
      await expect(page).toHaveURL(new RegExp(`${path}$`));

      // No landing view mounts alongside the guard. Any of these
      // testids appearing would indicate the guard leaked content.
      for (const testid of VIEW_TESTIDS) {
        await expect(page.getByTestId(testid)).toHaveCount(0);
      }
    });
  }
});
