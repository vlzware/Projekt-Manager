import { test, expect } from '@playwright/test';

/**
 * Theme override tests — covers AC-109..AC-112 and AC-114 from the theming
 * block (spec: docs/spec/verification.md §15.20, docs/spec/ui.md §9.6,
 * docs/spec/architecture.md §12.5).
 *
 * AC-109 [vis]: Applying a non-default theme override on the document root
 * replaces the semantic token layer. Components render with the overridden
 * palette without code changes.
 *
 * AC-110 [vis]: Dark mode renders via a dark theme override. Every semantic
 * surface has a dark-appropriate value. All text/surface semantic pairs
 * meet WCAG AA contrast — 4.5:1 for normal text, 3:1 for large text — in
 * both light and dark.
 *
 * AC-111 [vis]: The theme override is resolved and applied to the document
 * root before the first paint of themed content. Reloading a session with
 * a non-default preference shows no flash of the default theme.
 *
 * AC-112 [vis]: When the user's theme preference is `'system'`, operating-
 * system color-scheme changes propagate to the UI without a reload.
 *
 * AC-114 [vis]: Changing the configured accent value updates every accent-
 * using surface — primary actions, focus rings, etc. — in both modes.
 * AC-113 (accent must come from brandingConfig, not be hardcoded) is
 * enforced structurally by scripts/check-theme-tokens.sh, not here.
 *
 * Scope notes:
 *   - Uses the `chromium` project (parallel, read-only). Empty storageState
 *     forces the unauthenticated login view so each test is self-contained
 *     and does not depend on seed data.
 *   - No screenshot assertions here — baselines churn per project state.
 *   - The localStorage key `theme-preference` is pinned as the contract
 *     (see §9.6 "Local cache semantics"). The implementation MUST use this
 *     exact key; if it picks a different one, these tests fail and the
 *     naming gets reconciled in the spec, not by rewriting the test.
 *   - The custom-property names `--brand-accent-light` and
 *     `--brand-accent-dark` are pinned by AC-114 below. If the
 *     implementation chooses different names, the test fails and the
 *     naming gets reconciled in the spec, not by rewriting the test.
 */

test.use({ storageState: { cookies: [], origins: [] } });

// Local-cache key for the user's theme preference. Pinned contract.
// Values: 'light' | 'dark' | 'system' (see docs/spec/data-model.md §5.7).
const THEME_PREFERENCE_KEY = 'theme-preference';

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

/**
 * WCAG 2.1 relative luminance (sRGB). Input: 0-255 channel values.
 * Spec: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG 2.1 contrast ratio between two sRGB colors (r,g,b in 0-255).
 * Returns a number in [1, 21]. Required: >= 4.5 for normal text,
 * >= 3.0 for large text (§15.20 AC-110).
 * Spec: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
function contrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Parse a computed color string into an opaque RGB tuple.
 * Rejects transparent / semi-transparent values (alpha < 1) because
 * contrast against a transparent "surface" is ill-defined — the real
 * backdrop would have to be composited. Tests asserting AA must sample
 * opaque tokens; if a token resolves to a non-opaque value, the test
 * intentionally fails with a clear message.
 */
function opaqueRgb(value: string, label: string): [number, number, number] {
  const nums = value.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) {
    throw new Error(`Could not parse color for ${label}: "${value}"`);
  }
  const [r, g, b] = [Number(nums[0]), Number(nums[1]), Number(nums[2])];
  // rgba(...) with a 4th value < 1 means the token is not opaque.
  if (nums.length >= 4 && Number(nums[3]) < 1) {
    throw new Error(
      `Expected opaque color for ${label} (contrast is ill-defined over transparency). Got "${value}".`,
    );
  }
  return [r, g, b];
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

/**
 * Sample a representative set of semantic pairs from the login surface.
 *
 * Pairs (selected to cover surface + text tokens used on the public
 * login view without depending on any particular DOM layout):
 *   - bodyText:       --color-text           over --color-surface-base
 *   - mutedText:      --color-text-muted     over --color-surface-base
 *   - formTitleText:  --color-text           over --color-surface-raised
 *
 * Implementation notes:
 *   - Each value is resolved via a hidden probe element placed in the
 *     DOM. `getComputedStyle` resolves `var(...)` against the cascaded
 *     context, so a probe under `<html data-theme="dark">` returns the
 *     dark-mode resolved values without us having to know the raw palette.
 *   - The muted-text probe carries a background so we can sample both its
 *     foreground AND its intended backdrop from the same element — avoids
 *     needing to identify which real element consumes which token.
 *   - Probes are marked `aria-hidden` and appended to <body> after the
 *     login form so they do not shift layout.
 */
type SemanticPair = {
  label: string;
  textToken: string;
  surfaceToken: string;
};

const AC110_PAIRS: ReadonlyArray<SemanticPair> = [
  {
    label: 'body text over body surface',
    textToken: '--color-text',
    surfaceToken: '--color-surface-base',
  },
  {
    label: 'muted text over body surface',
    textToken: '--color-text-muted',
    surfaceToken: '--color-surface-base',
  },
  {
    label: 'form title text over form surface',
    textToken: '--color-text',
    surfaceToken: '--color-surface-raised',
  },
];

type SampledPair = { label: string; text: string; surface: string };

/**
 * Inject probe elements for each semantic pair and read back their
 * resolved computed colors. Runs entirely in the page context so we get
 * one round-trip per sample batch regardless of pair count.
 */
async function sampleSemanticPairs(
  page: import('@playwright/test').Page,
  pairs: ReadonlyArray<SemanticPair>,
): Promise<SampledPair[]> {
  return page.evaluate(
    (items) => {
      const results: { label: string; text: string; surface: string }[] = [];
      for (const { label, textToken, surfaceToken } of items) {
        const probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        // Off-screen but still laid out so getComputedStyle resolves vars.
        probe.style.cssText = `position: fixed; left: -9999px; top: -9999px; color: var(${textToken}); background-color: var(${surfaceToken}); padding: 1px;`;
        document.body.appendChild(probe);
        const cs = window.getComputedStyle(probe);
        results.push({ label, text: cs.color, surface: cs.backgroundColor });
        probe.remove();
      }
      return results;
    },
    pairs as unknown as SemanticPair[],
  );
}

// AC-110
test('AC-110 [vis]: dark mode has real overrides and meets WCAG AA contrast', async ({ page }) => {
  // Pin OS color-scheme to light so the baseline is deterministic even
  // if a FOUC script (AC-111) is live and falls back to prefers-color-
  // scheme on empty localStorage.
  await page.emulateMedia({ colorScheme: 'light' });

  // --- Phase 1: light-mode baseline. ---
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Guard the baseline: whatever the default theme is, it must not be
  // "dark" — otherwise the diff below would be comparing dark-to-dark.
  const initialThemeAttr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  expect(
    initialThemeAttr,
    `Expected initial data-theme to be absent or "light" when localStorage is empty and OS scheme is emulated light. Got "${initialThemeAttr}".`,
  ).not.toBe('dark');

  const lightValues = await sampleSemanticPairs(page, AC110_PAIRS);
  const lightBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  // --- Phase 2: dark-mode via direct attribute toggle. ---
  // This test is about the PALETTE (semantic values + AA contrast), not
  // about WHEN data-theme is applied — AC-111 covers the FOUC timing
  // contract. We therefore set the attribute after load (like AC-109
  // does for its arbitrary smoke-test override), so this test is robust
  // to the presence or absence of the FOUC script and any preference in
  // localStorage. The resulting computed styles reflect the `[data-theme
  // ="dark"]` cascade as authored in src/styles/tokens.css.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  // Guard: confirm the attribute took effect before asserting on paint.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const darkValues = await sampleSemanticPairs(page, AC110_PAIRS);
  const darkBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  // --- Assertions. ---

  // Body background itself must shift between modes — the single most
  // user-visible symptom if the dark override is missing.
  expect(
    darkBodyBg,
    `Body background did not change when [data-theme="dark"] was set. Got "${darkBodyBg}" both before and after — [data-theme="dark"] has no rules targeting --color-surface-base (or whichever token drives the body).`,
  ).not.toBe(lightBodyBg);

  // Every sampled semantic pair must differ between light and dark. A
  // token that does NOT change is proof the dark override is incomplete —
  // AC-110 requires every semantic surface to have a dark-appropriate
  // value, not just a subset.
  for (let i = 0; i < AC110_PAIRS.length; i++) {
    const pair = AC110_PAIRS[i];
    const l = lightValues[i];
    const d = darkValues[i];
    expect(
      d.text,
      `Token ${pair.textToken} (${pair.label}) is identical in light and dark (${l.text} === ${d.text}). Dark override is missing this text token.`,
    ).not.toBe(l.text);
    expect(
      d.surface,
      `Token ${pair.surfaceToken} (${pair.label}) is identical in light and dark (${l.surface} === ${d.surface}). Dark override is missing this surface token.`,
    ).not.toBe(l.surface);
  }

  // Contrast: both modes must meet AA for normal text (4.5:1) on every
  // sampled pair. Large-text threshold (3:1) is not exercised here
  // because none of the tokens above are large-text-only.
  const AA_NORMAL = 4.5;
  for (const values of [
    { mode: 'light', samples: lightValues },
    { mode: 'dark', samples: darkValues },
  ] as const) {
    for (let i = 0; i < values.samples.length; i++) {
      const pair = AC110_PAIRS[i];
      const s = values.samples[i];
      const textRgb = opaqueRgb(s.text, `${values.mode} ${pair.label} text`);
      const surfRgb = opaqueRgb(s.surface, `${values.mode} ${pair.label} surface`);
      const ratio = contrastRatio(textRgb, surfRgb);
      expect(
        ratio,
        `WCAG AA normal-text contrast (${AA_NORMAL}:1) failed in ${values.mode} mode for ${pair.label}: text=${s.text} over surface=${s.surface} → ratio=${ratio.toFixed(2)}:1.`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  }
});

// AC-111
test('AC-111 [vis]: theme override applied before first paint (no flash)', async ({ page }) => {
  // --- Phase 1: capture the light-mode body background without any
  //   preference seeded. This is the value a flash-of-light would show. ---
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  const lightBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  // --- Phase 2: seed preference + install snapshot hook, then navigate. ---
  // addInitScript runs BEFORE the page's own scripts on every navigation
  // to this origin — this is the earliest hook we can legitimately install.
  // The production FOUC script must therefore already have run by the time
  // DOMContentLoaded fires; if it has not, data-theme is still unset when
  // we read it, and this test fails with a specific message.
  await page.addInitScript(
    ({ key }) => {
      // Seed the preference BEFORE the page's FOUC script reads it.
      window.localStorage.setItem(key, 'dark');
      // Record the data-theme attribute at two checkpoints: the earliest
      // event after HTML parsing (DOMContentLoaded), and the first
      // animation frame (a conservative proxy for "first paint"). A
      // correct FOUC script must have applied the attribute before both.
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

  // Wait until both snapshots have been recorded. The rAF callback is
  // dispatched on the next frame after DOMContentLoaded — small, but
  // non-zero, wait budget.
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

  // Belt-and-braces: the body background at the moment the login form
  // becomes visible must already be the dark value, not the light one.
  const observedBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );
  expect(
    observedBodyBg,
    `Body background at first render was "${observedBodyBg}", identical to the light-mode value ("${lightBodyBg}"). Even if data-theme is set early, the override CSS did not affect the body — the dark palette is not applied on initial paint.`,
  ).not.toBe(lightBodyBg);
});

// AC-112
test('AC-112 [vis]: system mode tracks OS color-scheme change without reload', async ({ page }) => {
  // --- Seed preference = 'system' and start with OS scheme = light. ---
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, 'system');
    },
    { key: THEME_PREFERENCE_KEY },
  );

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Track navigation events from this point forward — toggling the OS
  // color scheme MUST NOT cause a full reload. The spec (§9.6 "'system'
  // mode") requires a live subscription, not a refresh.
  let navigations = 0;
  const onNav = () => {
    navigations += 1;
  };
  page.on('framenavigated', onNav);

  const lightBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );

  // --- Flip the OS color scheme to dark without reloading. ---
  await page.emulateMedia({ colorScheme: 'dark' });

  // Wait for the UI to react. We don't know (and don't want to pin) the
  // exact mechanism — matchMedia listener, storage event, or direct DOM
  // observation — only that the change propagates without a reload.
  try {
    await page.waitForFunction(
      (previous) => window.getComputedStyle(document.body).backgroundColor !== previous,
      lightBodyBg,
      { timeout: 2000 },
    );
  } catch {
    // Fall through — the assertion below will fail with a descriptive
    // message rather than a generic timeout.
  }

  const darkBodyBg = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );
  page.off('framenavigated', onNav);

  expect(
    darkBodyBg,
    `Body background did not update after the OS color-scheme flipped to dark (preference='system'). Before: ${lightBodyBg}. After: ${darkBodyBg}. The client is not subscribed to (prefers-color-scheme: dark).`,
  ).not.toBe(lightBodyBg);

  expect(
    navigations,
    `Expected zero navigations between the emulateMedia(colorScheme:'dark') call and the repaint. Observed ${navigations}. A reload defeats the "without a reload" requirement of AC-112.`,
  ).toBe(0);
});

// --- AC-114 helpers --------------------------------------------------------
//
// Two unlikely-to-collide accent values. Each is picked well outside the
// neutral-and-blue region so a missed-propagation bug (element stuck on the
// default palette) produces a loud, unambiguous failure. The override CSS
// is compared as a numeric tuple rather than a literal string — Chromium's
// getComputedStyle output shape (`rgb(r, g, b)` vs `rgb(r g b)`) is a
// browser/CSS-version concern we do not want to pin.
const ACCENT_LIGHT_OVERRIDE: [number, number, number] = [210, 40, 170]; // magenta
const ACCENT_DARK_OVERRIDE: [number, number, number] = [40, 200, 120]; // green

/**
 * Read the computed background-color of the login submit button. The button
 * consumes the accent via `background: var(--color-accent)` in
 * src/ui/auth/LoginForm.module.css — so its background IS the resolved
 * accent value. Selected by role + accessible name ("Anmelden") so this
 * spec remains stable across test-instrumentation churn on the component.
 */
async function readSubmitButtonBg(page: import('@playwright/test').Page): Promise<string> {
  const button = page.getByRole('button', { name: /Anmelden/ });
  return button.evaluate((el) => window.getComputedStyle(el).backgroundColor);
}

/**
 * Focus the username input, then read its computed border color. The
 * focused input consumes the accent via `border-color: var(--color-focus-ring)`
 * in src/ui/auth/LoginForm.module.css — the second accent surface sampled
 * by this test. Selected by the accessible name from its <label>, not by
 * testid, so this spec remains independent of component-level instrumentation.
 */
async function readFocusedInputBorder(page: import('@playwright/test').Page): Promise<string> {
  const input = page.getByLabel(/Benutzername|Username/i).first();
  await input.focus();
  return input.evaluate((el) => window.getComputedStyle(el).borderColor);
}

/**
 * Inject a `<style>` rule that redefines the brand accent at the document
 * root. We do NOT use `element.style.setProperty(...)` because — depending
 * on how #101 wires the chain — `--brand-accent-light` may only be read
 * from the `:root` rule inside a cascade that declares the `--color-accent`
 * semantic token. A stylesheet rule produces identical cascade behavior to
 * the production definition; inline styles on `<html>` would be strictly
 * higher specificity and could mask a real broken reference.
 *
 * Scope: we override BOTH the light and dark accent custom properties in a
 * single <style> block, then toggle `data-theme` to select which branch
 * wins. Overriding both simultaneously is safe: each rule applies only
 * inside its own cascade context.
 */
async function installAccentOverride(
  page: import('@playwright/test').Page,
  light: [number, number, number],
  dark: [number, number, number],
): Promise<void> {
  const [lR, lG, lB] = light;
  const [dR, dG, dB] = dark;
  await page.addStyleTag({
    content: `
      :root {
        --brand-accent-light: rgb(${lR}, ${lG}, ${lB});
        --brand-accent-dark: rgb(${dR}, ${dG}, ${dB});
      }
    `,
  });
}

// AC-114
test('AC-114 [vis]: configured accent value propagates to accent surfaces in both modes', async ({
  page,
}) => {
  // --- Phase 0: deterministic light baseline. ---
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Capture the DEFAULT accent resolution before any override is injected.
  // These baselines are the "before" half of the before/after contract:
  // if an override reaches the DOM but a surface does not change, the
  // wiring from --color-accent / --color-focus-ring back to the brand
  // accent custom property is broken on that surface.
  const lightSubmitBefore = await readSubmitButtonBg(page);
  const lightBorderBefore = await readFocusedInputBorder(page);

  // --- Phase 1: install both overrides, verify light-mode surfaces. ---
  await installAccentOverride(page, ACCENT_LIGHT_OVERRIDE, ACCENT_DARK_OVERRIDE);

  // Re-read the accent surfaces. In light mode, both should now match the
  // LIGHT override (dark override is silent because [data-theme="dark"]
  // is not active).
  const lightSubmitAfter = await readSubmitButtonBg(page);
  const lightBorderAfter = await readFocusedInputBorder(page);

  expect(
    lightSubmitAfter,
    `Submit button background did not change after redefining --brand-accent-light. Before: ${lightSubmitBefore}, after: ${lightSubmitAfter}. Either --color-accent does not resolve through --brand-accent-light in light mode, or the submit button is not consuming --color-accent.`,
  ).not.toBe(lightSubmitBefore);

  const lightSubmitTuple = parseRgb(lightSubmitAfter);
  expect(lightSubmitTuple, `could not parse computed color ${lightSubmitAfter}`).not.toBeNull();
  expect(
    lightSubmitTuple,
    `Submit button background resolved to ${lightSubmitAfter}, not the injected light override rgb(${ACCENT_LIGHT_OVERRIDE.join(', ')}). The override reached the DOM but the accent chain (brand accent → --color-accent → submit button) is broken somewhere along the way.`,
  ).toEqual(ACCENT_LIGHT_OVERRIDE);

  expect(
    lightBorderAfter,
    `Focused input border did not change after redefining --brand-accent-light. Before: ${lightBorderBefore}, after: ${lightBorderAfter}. --color-focus-ring is not resolving through --brand-accent-light in light mode.`,
  ).not.toBe(lightBorderBefore);

  const lightBorderTuple = parseRgb(lightBorderAfter);
  expect(lightBorderTuple, `could not parse computed color ${lightBorderAfter}`).not.toBeNull();
  expect(
    lightBorderTuple,
    `Focused input border resolved to ${lightBorderAfter}, not the injected light override rgb(${ACCENT_LIGHT_OVERRIDE.join(', ')}). The accent chain for --color-focus-ring is broken.`,
  ).toEqual(ACCENT_LIGHT_OVERRIDE);

  // --- Phase 2: switch to dark mode, verify dark override wins. ---
  // Toggle the attribute directly (AC-109/110 pattern) — this test is
  // about the PALETTE chain, not about FOUC timing.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const darkSubmitAfter = await readSubmitButtonBg(page);
  const darkBorderAfter = await readFocusedInputBorder(page);

  // Dark accent must differ from the LIGHT override — otherwise
  // [data-theme="dark"] has no effect on the accent (missing dark-branch
  // override).
  expect(
    darkSubmitAfter,
    `Submit button background in dark mode (${darkSubmitAfter}) is identical to the light override (${lightSubmitAfter}). The [data-theme="dark"] branch does not override --color-accent through --brand-accent-dark.`,
  ).not.toBe(lightSubmitAfter);

  const darkSubmitTuple = parseRgb(darkSubmitAfter);
  expect(darkSubmitTuple, `could not parse computed color ${darkSubmitAfter}`).not.toBeNull();
  expect(
    darkSubmitTuple,
    `Dark-mode submit background resolved to ${darkSubmitAfter}, not the injected dark override rgb(${ACCENT_DARK_OVERRIDE.join(', ')}). The dark accent chain (--brand-accent-dark → --color-accent → button) is broken.`,
  ).toEqual(ACCENT_DARK_OVERRIDE);

  expect(
    darkBorderAfter,
    `Focused input border in dark mode (${darkBorderAfter}) is identical to the light override (${lightBorderAfter}). --color-focus-ring does not pick up --brand-accent-dark under [data-theme="dark"].`,
  ).not.toBe(lightBorderAfter);

  const darkBorderTuple = parseRgb(darkBorderAfter);
  expect(darkBorderTuple, `could not parse computed color ${darkBorderAfter}`).not.toBeNull();
  expect(
    darkBorderTuple,
    `Dark-mode focused input border resolved to ${darkBorderAfter}, not the injected dark override rgb(${ACCENT_DARK_OVERRIDE.join(', ')}). The dark accent chain for --color-focus-ring is broken.`,
  ).toEqual(ACCENT_DARK_OVERRIDE);
});
