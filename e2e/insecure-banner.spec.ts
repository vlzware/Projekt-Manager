import { test, expect } from '@playwright/test';
import os from 'node:os';

/**
 * Insecure connection banner — verifies the red warning bar appears
 * on the login page when the app is accessed via plain HTTP on a
 * non-localhost address, and does NOT appear on localhost.
 *
 * Uses empty storageState so every test sees the unauthenticated
 * login page. The banner is most critical there — credentials are
 * about to be typed.
 */

// Override the project's default storageState (which has the
// authenticated session from auth.setup.ts) — we need the login page.
test.use({ storageState: { cookies: [], origins: [] } });

/** Returns the first non-loopback IPv4 address, or null. */
function getLocalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

test.describe('Insecure connection banner', () => {
  test('no banner and standard title on localhost', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();

    await expect(page.getByTestId('insecure-banner')).not.toBeVisible();
    await expect(page).toHaveTitle('Projekt-Manager');
  });

  test('banner and title prefix on non-localhost HTTP', async ({ page }) => {
    const ip = getLocalIPv4();
    test.skip(!ip, 'No non-loopback IPv4 address available');

    await page.goto(`http://${ip}:5173/`);
    await expect(page.getByTestId('login-form')).toBeVisible();

    await expect(page.getByTestId('insecure-banner')).toBeVisible();
    await expect(page.getByTestId('insecure-banner')).toContainText('UNSICHERER MODUS');
    await expect(page).toHaveTitle(/^UNSICHER/);
  });
});
