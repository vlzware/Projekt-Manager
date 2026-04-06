import { test, expect } from '@playwright/test';

/**
 * AC-1: The full stack (frontend, backend, database) starts locally
 * with a documented command or minimal command sequence.
 *
 * API-level checks — no browser needed. Proves the backend is running,
 * connected to the database, migrations applied, and seed data loaded.
 */
test.describe('AC-1: local dev stack startup', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('seed user can log in', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { username: 'inhaber', password: 'changeme' },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.user.username).toBe('inhaber');
    expect(body.user.roles).toContain('owner');
  });
});
