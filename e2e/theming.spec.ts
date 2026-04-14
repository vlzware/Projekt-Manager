import { test, expect } from '@playwright/test';

/**
 * Theming state/timing tests — covers AC-111 and AC-112 from the theming
 * block (spec: docs/spec/verification.md §15.20, docs/spec/ui.md §9.6).
 *
 * AC-111 [vis]: The theme override is resolved and applied to the document
 * root before the first paint of themed content. Reloading a session with
 * a non-default preference shows no flash of the default theme.
 *
 * AC-112 [vis]: When the user's theme preference is `'system'`, operating-
 * system color-scheme changes propagate to the UI without a reload.
 *
 * Scope notes:
 *   - Other [vis] ACs in §15.20 (AC-109 token override, AC-110 dark
 *     palette + WCAG contrast, AC-114 configured-accent propagation)
 *     are VR-tier per ADR-0014 and deliberately NOT covered here.
 *     Attempting them via getComputedStyle + addStyleTag leads to the
 *     computed-style-assertion trap the project rejected in iteration
 *     5 (brittle, fights transitions / specificity, low defect-
 *     detection value). Those ACs await a visual-regression baseline.
 *   - Uses the `chromium` project (parallel, read-only). Empty
 *     storageState forces the unauthenticated login view.
 *   - The localStorage key `theme-preference` is pinned as the
 *     contract; if the implementation picks a different one, these
 *     tests fail and the naming gets reconciled in the spec.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const THEME_PREFERENCE_KEY = 'theme-preference';

// AC-111
test('AC-111 [vis]: theme override applied before first paint (no flash)', async ({ page }) => {
  // Seed preference = 'dark' via addInitScript, which runs BEFORE the page's
  // own scripts — this is the earliest hook available. The production FOUC
  // script must already have run by DOMContentLoaded; if it hasn't,
  // data-theme is still unset when we read it and this test fails.
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, 'dark');
      const snapshot: { at: string; value: string | null }[] = [];
      (window as unknown as { __themeSnapshot: typeof snapshot }).__themeSnapshot = snapshot;
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          snapshot.push({
            at: 'DOMContentLoaded',
            value: document.documentElement.getAttribute('data-theme'),
          });
          requestAnimationFrame(() => {
            snapshot.push({
              at: 'firstRAF',
              value: document.documentElement.getAttribute('data-theme'),
            });
          });
        },
        { once: true },
      );
    },
    { key: THEME_PREFERENCE_KEY },
  );

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.waitForFunction(() => {
    const w = window as unknown as { __themeSnapshot?: { at: string }[] };
    return !!w.__themeSnapshot && w.__themeSnapshot.length >= 2;
  });

  const snapshots = await page.evaluate(
    () =>
      (window as unknown as { __themeSnapshot: { at: string; value: string | null }[] })
        .__themeSnapshot,
  );
  const byCheckpoint = Object.fromEntries(snapshots.map((s) => [s.at, s.value]));

  expect(
    byCheckpoint['DOMContentLoaded'],
    `data-theme was "${byCheckpoint['DOMContentLoaded']}" at DOMContentLoaded with preference=dark seeded in localStorage["${THEME_PREFERENCE_KEY}"]. The inline FOUC script did not run before DOMContentLoaded, so users will see a flash of the light theme on reload.`,
  ).toBe('dark');
  expect(
    byCheckpoint['firstRAF'],
    `data-theme was "${byCheckpoint['firstRAF']}" at the first requestAnimationFrame. Even if the attribute is eventually set, it must be set before the first paint.`,
  ).toBe('dark');
});

// AC-112
test('AC-112 [vis]: system mode tracks OS color-scheme change without reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, 'system');
    },
    { key: THEME_PREFERENCE_KEY },
  );

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Track navigations — an OS scheme change MUST NOT cause a reload
  // (spec §9.6: live subscription, not refresh).
  let navigations = 0;
  const onNav = () => {
    navigations += 1;
  };
  page.on('framenavigated', onNav);

  // Start light: data-theme attribute should be absent or non-'dark'.
  const lightAttr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  expect(lightAttr).not.toBe('dark');

  await page.emulateMedia({ colorScheme: 'dark' });

  // Wait for the matchMedia listener to flip data-theme.
  try {
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      null,
      { timeout: 2000 },
    );
  } catch {
    // fall through — assertion below gives a descriptive message
  }

  const darkAttr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  page.off('framenavigated', onNav);

  expect(
    darkAttr,
    `data-theme did not flip to "dark" after OS scheme change (preference='system'). Got "${darkAttr}". The client is not subscribed to (prefers-color-scheme: dark).`,
  ).toBe('dark');

  expect(
    navigations,
    `Expected zero navigations between emulateMedia(colorScheme:'dark') and the attribute flip. Observed ${navigations}.`,
  ).toBe(0);
});
