/**
 * SummaryArea component test — the Kanban-jump buttons must not render
 * for a caller without Kanban access. SummaryArea sits inside Header,
 * which renders on every view, so a bookkeeper on /projects would
 * otherwise see buttons that dead-end in `NotPermittedView` when
 * clicked (see `src/config/routes.ts` matrix).
 *
 * The component-level assertion catches a class of drift that the
 * route-table test in `src/config/__tests__/routes.test.ts` cannot —
 * namely, a future refactor that hardcodes the jump in the button
 * itself and bypasses the central `canAccess` predicate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AuthUser } from '@/api/client';
import type { Project } from '@/domain/types';

const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');
const { useUIStore } = await import('@/state/uiStore');
const { SummaryArea } = await import('@/ui/layout/SummaryArea');

function setAuthUser(roles: string[]): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'test',
    displayName: 'Test User',
    roles,
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({
    authUser: user,
    authError: null,
    sessionChecked: true,
  });
}

const SEED_PROJECT: Project = {
  id: 'p-1',
  number: 'P-001',
  title: 'Seed',
  status: 'anfrage',
  statusChangedAt: '2026-04-01T00:00:00Z',
  customerId: 'c-1',
  customer: { id: 'c-1', name: 'Kunde', phone: null, email: null, address: null },
  plannedStart: null,
  plannedEnd: null,
  assignedWorkers: [],
  estimatedValue: null,
  notes: null,
  deleted: false,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

beforeEach(() => {
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  useProjectStore.setState({
    projects: [{ ...SEED_PROJECT }],
    mutationInFlight: {},
    mutationError: null,
  });
  useUIStore.setState({ activeFilter: null, filterAgedOnly: false, filterNoDates: false });
});

describe('SummaryArea — Kanban-jump gating', () => {
  it('renders the action-count button for a caller with Kanban access', () => {
    setAuthUser(['worker']);
    render(<SummaryArea />);
    expect(screen.queryByTestId('summary-action-anfrage')).toBeInTheDocument();
  });

  it('omits the action-count button for a caller without Kanban access', () => {
    setAuthUser(['bookkeeper']);
    render(<SummaryArea />);
    expect(screen.queryByTestId('summary-action-anfrage')).not.toBeInTheDocument();
  });
});
