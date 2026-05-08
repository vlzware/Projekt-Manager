import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../src/test/seedAssumptions';

/**
 * Regression — `project_changed` SSE channel must work after the actual
 * login flow, not just when storageState is pre-baked into the browser
 * context.
 *
 * Bug shape (issue #176 deploy verification, 2026-05-08): the SPA opens
 * its `/api/events` EventSource at module top-level in `main.tsx`, which
 * runs while the user is still on the login screen. With no session
 * cookie, the server's `authenticate` preHandler answers 401 and per
 * WHATWG the EventSource transitions to CLOSED with no spec-mandated
 * reconnect. The post-login navigation to `/kanban` is an in-SPA route
 * change, so `main.tsx` does not rerun and the dead EventSource sits
 * closed for the page lifetime. Result: every `project_changed` frame
 * is dropped on the floor.
 *
 * Why the existing AC-277 spec missed this: it preloads
 * `STORAGE_STATES.office` into the browser context, so cookies are
 * already present when the SPA boots and the bootstrap-time EventSource
 * succeeds. This spec exercises the actual login-form flow so a
 * regression to the bootstrap-time subscription pattern surfaces here.
 *
 * Fix: subscribe under an auth-gated `useEffect` in `App.tsx`. See
 * `src/App.tsx` and `src/state/projectSseSubscription.ts`.
 *
 * Runs under `chromium-mutating` (one project row archives + restores
 * via the owner request context).
 */

const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

/**
 * Pick a project that no other mutating spec touches, so this spec can
 * run in any order within the chromium-mutating sequence. `-011`
 * (Tapezierarbeiten Café Sonnenschein, in_arbeit) is unused by
 * project-lifecycle-multi-user (which uses 007/008/009/010) and by
 * worker-advance flows (workers are not assigned to it for kanban
 * forward arrows).
 */
const TARGET_SUFFIX = '011';

async function resolveProjectIdBySuffix(
  ownerRequest: APIRequestContext,
  suffix: string,
): Promise<{ id: string; number: string; title: string }> {
  const resp = await ownerRequest.get(`/api/projects?search=${encodeURIComponent(`-${suffix}`)}`);
  expect(resp.ok(), `project search failed: ${resp.status()} ${await resp.text()}`).toBe(true);
  const body = (await resp.json()) as {
    projects: Array<{ id: string; number: string; title: string }>;
  };
  const match = body.projects.find((p) => p.number.endsWith(`-${suffix}`));
  if (!match) {
    throw new Error(`seed project with suffix -${suffix} not found in /api/projects response`);
  }
  return match;
}

interface RowReadout {
  matchCount: number;
  text: string;
}

async function readProjectRow(officePage: Page, numberRegex: RegExp): Promise<RowReadout> {
  const rows = officePage.getByRole('row', { name: numberRegex });
  const matchCount = await rows.count();
  if (matchCount === 0) return { matchCount: 0, text: '' };
  const parts: string[] = [];
  for (let i = 0; i < matchCount; i++) {
    parts.push((await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  return { matchCount, text: parts.join(' || ') };
}

async function expectOfficeRowChanges(
  officePage: Page,
  numberRegex: RegExp,
  before: RowReadout,
  description: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await readProjectRow(officePage, numberRegex);
        return now.matchCount !== before.matchCount || now.text !== before.text;
      },
      {
        message: `office project-list did not reflect ${description} within the AC-277 propagation budget`,
        timeout: SSE_PROPAGATION_TIMEOUT_MS,
      },
    )
    .toBe(true);
}

// Override the chromium-mutating project's default storageState to
// none — the whole point is to exercise the bootstrap-time SSE
// subscription before a session cookie exists. Using `{ storageState:
// undefined }` would pass the literal string "undefined" to the
// fixture; the empty-state object is the documented neutral form.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe.serial('SSE channel survives the actual login flow', () => {
  test('office observer reflects an owner archive within 2s after a fresh login', async ({
    browser,
    page,
  }) => {
    // ── 1. Fresh login from the actual form, NOT preloaded cookies ──
    // This is the path the production user takes: open the app, type
    // credentials, submit, land on the post-login surface. If the SPA's
    // SSE subscription happens at module-load time (i.e., before the
    // cookie is set), the bootstrap-time `/api/events` request returns
    // 401 and the EventSource transitions to CLOSED with no spec-
    // mandated reconnect — and every subsequent `project_changed`
    // frame is dropped on the floor.
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await page.getByTestId('login-username').fill(SEED_USERS.office.username);
    await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });

    // Park the office observer on the project list. This is an in-SPA
    // navigation — main.tsx does NOT rerun, so any module-load-time
    // EventSource that 401'd at boot would still be CLOSED here.
    await page.goto('/projekte');
    await expect(page.getByTestId('project-table')).toBeVisible();

    // Surface archived rows so the post-archive readout still finds the
    // row by number — we assert on the row's text changing (the
    // Archiviert badge appears), not on row disappearance.
    await page.getByTestId('project-show-archived-toggle').check();

    // ── 2. Snapshot the row, then issue the mutation from a SEPARATE
    //      authenticated context (the bug only manifests when the
    //      mutation comes from another session — same-session mutations
    //      get the optimistic local update). ──
    const numberRegex = new RegExp(`-${TARGET_SUFFIX}\\b`);
    const before = await readProjectRow(page, numberRegex);
    expect(before.matchCount, 'seed project should be visible to office observer').toBeGreaterThan(
      0,
    );

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    let target: { id: string; number: string; title: string };
    try {
      const ownerRequest = ownerContext.request;
      target = await resolveProjectIdBySuffix(ownerRequest, TARGET_SUFFIX);
      const resp = await ownerRequest.delete(`/api/projects/${target.id}`);
      expect(resp.ok(), `archive failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    // ── 3. Assert the office row's text changed within the AC-277 2s
    //      budget — driven SOLELY by the SSE channel (no goto, no
    //      reload, no visibility change between snapshot and assert). ──
    await expectOfficeRowChanges(page, numberRegex, before, 'owner archive after fresh login');

    // ── 4. Net-zero teardown — restore the project so subsequent specs
    //      see the seed state intact. The office observer will see this
    //      second mutation propagate too; that is fine, the assertion
    //      already passed for the archive step. ──
    const restoreContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const resp = await restoreContext.request.post(`/api/projects/${target.id}/restore`);
      expect(resp.ok(), `restore failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await restoreContext.close();
    }
  });
});
