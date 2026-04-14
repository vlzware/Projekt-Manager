import type { WorkflowState } from '@/config/stateConfig';
import type { ThemePreference } from '@/config/themeStorage';

export interface Address {
  street: string;
  zip: string;
  city: string;
}

/** Nested customer summary as returned in project API responses. */
export interface CustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: Address | null;
}

export interface Project {
  id: string;
  number: string;
  title: string;
  status: WorkflowState;
  statusChangedAt: string;

  customerId: string;
  customer: CustomerSummary | null;

  plannedStart: string | null;
  plannedEnd: string | null;

  assignedWorkers: { userId: string; displayName: string }[] | null;
  estimatedValue: number | null;
  notes: string | null;
  deleted: boolean;

  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: Address | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  active: boolean;
  /**
   * Server-authoritative color-scheme preference — see data-model.md §5.7.
   * New users default to `'system'` at the DB level (see migration 0013
   * and the CHECK constraint `users_valid_theme_preference`).
   */
  themePreference: ThemePreference;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Profile shape returned by the authenticated-user endpoints (login,
 * GET /api/auth/me, PATCH /api/auth/me). A narrower projection than
 * `User`; see api.md §14.2.1 and the AuthUser interface in the server
 * middleware.
 */
export interface AuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  themePreference: ThemePreference;
}

export interface ImportResult {
  imported: number;
  updated?: number;
  errors: { index: number; message: string }[];
}

export interface SummaryData {
  actionCounts: Partial<Record<WorkflowState, number>>;
  agedBufferCounts: { state: WorkflowState; count: number; thresholdDays: number }[];
  projectsWithoutDates: number;
}

/**
 * Available view modes. Extend this union and App.tsx when adding new views.
 * See architecture.md §11.5.
 */
export type ViewMode = 'kanban' | 'kalender' | 'kunden' | 'projekte' | 'benutzer' | 'daten';
