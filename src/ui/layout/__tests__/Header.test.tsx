/**
 * Header component test — verifies the per-role nav buttons render
 * exactly per the central route table (AC-75).
 *
 * Why this test exists even though `src/config/__tests__/routes.test.ts`
 * already pins the matrix at the table level: if a future refactor
 * reintroduces a hardcoded nav list in `Header.tsx` that _happens_ to
 * match the matrix for 3 of 4 roles, the table test still passes. This
 * component-level assertion catches that drift by rendering the real
 * Header and asserting on the DOM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

const { useAuthStore } = await import('@/state/authStore');
const { Header } = await import('@/ui/layout/Header');

function setAuthUser(roles: string[]): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'test',
    displayName: 'Test User',
    roles,
    email: null,
    themePreference: 'system',
  };
  useAuthStore.setState({
    authUser: user,
    authError: null,
    sessionChecked: true,
  });
}

const MATRIX: Record<string, readonly string[]> = {
  owner: ['kanban', 'kalender', 'projekte', 'kunden', 'benutzer', 'daten'],
  office: ['kanban', 'kalender', 'projekte', 'kunden', 'daten'],
  worker: ['kanban', 'kalender'],
  bookkeeper: ['projekte', 'kunden'],
};

beforeEach(() => {
  useAuthStore.setState({
    authUser: null,
    authError: null,
    sessionChecked: true,
  });
});

describe('Header — per-role nav visibility (AC-75)', () => {
  for (const role of Object.keys(MATRIX)) {
    it(`renders exactly the matrix nav for role '${role}'`, () => {
      setAuthUser([role]);
      render(<Header />);

      // Every view in the matrix is rendered as a button.
      for (const view of MATRIX[role]) {
        expect(screen.queryByTestId(`view-toggle-${view}`)).toBeInTheDocument();
      }

      // No other view is rendered.
      const allViews = ['kanban', 'kalender', 'projekte', 'kunden', 'benutzer', 'daten'];
      const forbidden = allViews.filter((v) => !MATRIX[role].includes(v));
      for (const view of forbidden) {
        expect(screen.queryByTestId(`view-toggle-${view}`)).not.toBeInTheDocument();
      }
    });
  }
});
