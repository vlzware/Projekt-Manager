import { test, expect } from '@playwright/test';

/**
 * Theme override smoke test — covers AC-109 from the theming block (§15.20).
 *
 * AC-109 [vis]: Applying a non-default theme override on the document root
 * replaces the semantic token layer. Components render with the overridden
 * palette without code changes.
 *
 * Strategy (intentionally does not depend on any particular default theme):
 *   1. Navigate to the login page — a public surface, no auth required.
 *   2. Snapshot the computed `background-color` of `<body>` under the
 *      default theme.
 *   3. Inject a `<style>` block that redefines the semantic surface token
 *      (`--color-surface-base`) scoped to `[data-theme="smoke-test"]` to a
 *      known RGB value that is guaranteed different from any plausible
 *      default.
 *   4. Set `data-theme="smoke-test"` on `<html>`.
 *   5. Re-read the computed `background-color`. Assert:
 *        a) it differs from the default (the override took effect), and
 *        b) it equals the injected RGB value (the override propagated via
 *           the semantic token layer, not via some unrelated rule).
 *
 * Why this is expected to FAIL today and PASS after #99 lands:
 *   - Today `<body>` has no rule that resolves `var(--color-surface-base)`,
 *     so redefining the variable changes nothing — step 5a fails.
 *   - After the token system is in place, `body { background: var(--color-surface-base) }`
 *     (or equivalent) is authored in src/styles/tokens.css, and swapping
 *     the variable under `[data-theme="smoke-test"]` re-paints the body.
 *
 * The specific variable name `--color-surface-base` is the contract this
 * test pins down. When the token source lands it MUST expose a semantic
 * token by this name that drives the body background. If the
 * implementation picks a different name, this test fails and the naming
 * needs a spec update, not a test rewrite.
 *
 * Uses the `chromium` project (parallel, read-only) — no server state
 * mutated. Empty storageState forces the unauthenticated login view so
 * the test is self-contained and does not depend on seed data.
 */

test.use({ storageState: { cookies: [], origins: [] } });

// RGB triple unlikely to occur as a real default. Compared as a numeric
// tuple rather than a literal string — Chromium's getComputedStyle output
// shape (`rgb(r, g, b)` vs `rgb(r g b)`) is a browser/CSS-version concern
// we do not want to pin.
const OVERRIDE_R = 199;
const OVERRIDE_G = 47;
const OVERRIDE_B = 210;
const OVERRIDE_CSS = `rgb(${OVERRIDE_R}, ${OVERRIDE_G}, ${OVERRIDE_B})`;

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/\d+/g);
  if (!match || match.length < 3) return null;
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

// AC-109
test('AC-109 [vis]: data-theme override replaces semantic token layer', async ({ page }) => {
  await page.goto('/');
  // Wait for a known element so we know the document has painted at least
  // once with the default theme applied.
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Capture the default computed background-color of <body>. This is the
  // baseline we expect the override to change.
  const defaultBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  await page.addStyleTag({
    content: `
      [data-theme="smoke-test"] {
        --color-surface-base: ${OVERRIDE_CSS};
      }
    `,
  });

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'smoke-test');
  });

  const overriddenBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  expect(
    overriddenBg,
    `Expected body background-color to change when [data-theme="smoke-test"] redefines --color-surface-base. Got same value (${defaultBg}) both before and after — either body does not consume the semantic token, or the token is not defined.`,
  ).not.toBe(defaultBg);

  const tuple = parseRgb(overriddenBg);
  expect(tuple, `could not parse computed color ${overriddenBg}`).not.toBeNull();
  expect(
    tuple,
    `Expected body background to equal the injected override ${OVERRIDE_CSS}. Got ${overriddenBg}. The override reached the DOM but not via the --color-surface-base semantic token — check which variable drives body background.`,
  ).toEqual([OVERRIDE_R, OVERRIDE_G, OVERRIDE_B]);
});
