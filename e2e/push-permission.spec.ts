import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — Push permission + Stummschalten toggle.
 *
 * Pins AC-201 (no auto-prompt on page load; prompt only on user
 * activation of the opt-in affordance) and AC-202 (Stummschalten
 * toggle reflects `pushMuted` and persists).
 *
 * AC-201 rationale: a denied permission is near-irreversible in-app;
 * every prompt must be a deliberate user action. We cannot assert on
 * the browser's permission UI rendering — the contract is about
 * whether the app calls `Notification.requestPermission()`, which we
 * spy on from the page context.
 *
 * Under Playwright, browser-level permission grants happen via
 * `browserContext.grantPermissions(['notifications'])` — see
 * https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions.
 * We spy on `window.Notification.requestPermission` rather than
 * observing the UI prompt.
 *
 * Uses `chromium-mutating` because `Stummschalten` persists via the
 * self-update mutation.
 */

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------
// AC-201 — No auto-request; user activation triggers one prompt
// ---------------------------------------------------------------
test.describe('AC-201: push permission is user-initiated, not auto-requested', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('page load does not call Notification.requestPermission', async ({ page }) => {
    // Spy is installed BEFORE any navigation so first-load calls are
    // observed. `addInitScript` runs before page scripts in every
    // frame of every navigation in this context.
    await page.addInitScript(() => {
      const W = window as unknown as Record<string, unknown>;
      W.__requestPermissionCalls = 0;
      const orig = (window.Notification && window.Notification.requestPermission) || undefined;
      if (!window.Notification) {
        // Some browsers without the API — still install a stub to
        // observe calls that WOULD have been made.
        W.Notification = {
          permission: 'default',
          requestPermission: () => {
            (W.__requestPermissionCalls as number)++;
            return Promise.resolve('default');
          },
        };
      } else {
        window.Notification.requestPermission = () => {
          (W.__requestPermissionCalls as number)++;
          return orig
            ? (orig.call(window.Notification) as Promise<NotificationPermission>)
            : Promise.resolve('default');
        };
      }
    });

    await page.goto('/');
    // Wait for the app shell to render so the initial-mount scripts
    // have had a chance to run any auto-prompt logic a regression
    // would introduce.
    await page.getByTestId('header').waitFor({ state: 'visible' });

    const calls = await page.evaluate(
      () => (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls,
    );
    expect(calls).toBe(0);
  });

  test('activating "Push-Benachrichtigungen aktivieren" triggers exactly one prompt', async ({
    page,
    context,
    browserName,
  }) => {
    // Probe the real permission state after clearPermissions() to
    // determine if headless Chromium returns 'default' — which is
    // required for the opt-in affordance to render. If the browser
    // returns 'denied' despite clearPermissions(), the opt-in path
    // cannot be exercised without patching the DOM, so we skip with a
    // documented reason rather than shipping a fake-pass.
    await context.clearPermissions();
    const permissionAfterClear = await page.evaluate(
      () =>
        typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    );
    if (permissionAfterClear !== 'default') {
      test.skip(
        true,
        `${browserName} headless returns Notification.permission === '${permissionAfterClear}' after clearPermissions() — the opt-in affordance cannot render without patching the DOM. Real-browser behavior verified by the component-level unit tests.`,
      );
      return;
    }

    // Grant notifications so the requestPermission call resolves to
    // "granted" without a blocking interactive prompt. The app's behavior
    // under denied/unsupported is a separate spec.
    await context.grantPermissions(['notifications']);
    // Clear again so permission is 'default' at page load — the opt-in
    // affordance only renders when permission !== 'denied' AND no
    // subscription is active. After grantPermissions resolves to
    // 'granted', clearPermissions resets it to 'default', giving the
    // component the correct starting state.
    await context.clearPermissions();

    await page.addInitScript(() => {
      const W = window as unknown as Record<string, unknown>;
      W.__requestPermissionCalls = 0;
      const orig = window.Notification?.requestPermission?.bind(window.Notification);
      if (orig) {
        window.Notification.requestPermission = () => {
          (W.__requestPermissionCalls as number)++;
          return orig();
        };
      }
    });

    await page.goto('/');
    // Open the user menu; activate the opt-in affordance.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('push-opt-in-button').click();

    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls,
        ),
      )
      .toBe(1);
  });
});

// ---------------------------------------------------------------
// AC-202 — Stummschalten persists and reflects pushMuted
// ---------------------------------------------------------------
test.describe('AC-202: Stummschalten reflects pushMuted and persists', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('toggling Stummschalten persists across a reload', async ({ page }) => {
    // Reset the state via API first so the UI-side assertion is
    // deterministic.
    const reset = await page.request.patch('/api/auth/me', {
      data: { pushMuted: false },
    });
    expect(reset.ok()).toBe(true);

    await page.goto('/');
    await page.getByTestId('user-menu-trigger').click();

    const toggle = page.getByTestId('push-mute-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();

    // Reload — persisted value must survive.
    await page.reload();
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('push-mute-toggle')).toBeChecked();
  });

  test('failed mutation reverts the optimistic toggle', async ({ page }) => {
    // Intercept the self-update request and respond with a 500 so the
    // UI must revert its optimistic toggle change per AC-53 / §9.5.
    await page.route('**/api/auth/me', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVER_ERROR', message: 'synthetic test failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByTestId('user-menu-trigger').click();
    const toggle = page.getByTestId('push-mute-toggle');
    const before = await toggle.isChecked();

    await toggle.click();

    // After the 500 response the toggle must revert to its prior state.
    await expect
      .poll(async () => toggle.isChecked())
      .toBe(before);
  });
});
