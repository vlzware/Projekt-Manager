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

/**
 * Unified data-exchange envelope (ADR-0018, data-model.md §5.8).
 *
 * Mirrors the server-side `Envelope` / `ImportResult` / `DryRunPreview`
 * / `ValidationIssue` shapes verbatim. Duplicated here (rather than
 * re-exported from `src/server/**`) so client-side code can reference
 * them without violating the layer boundary enforced by eslint.config.js.
 * Domain types are the canonical cross-layer contract per architecture.md
 * §11.2.
 */

export interface EnvelopeCustomer {
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

export interface EnvelopeProject {
  id: string;
  number: string;
  title: string;
  status: WorkflowState;
  statusChangedAt: string;
  customerId: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  estimatedValue: string | null;
  notes: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface EnvelopeAssignment {
  projectId: string;
  userId: string;
}

export interface Envelope {
  schema_version: number;
  exported_at: string;
  customers: EnvelopeCustomer[];
  projects: EnvelopeProject[];
  project_workers: EnvelopeAssignment[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface DryRunPreview {
  schema_version: number;
  /**
   * True when at least one of customers / projects / project_workers has
   * rows at dry-run time. The UI uses this to gate the override-warning
   * checkbox; the server still enforces `TARGET_NOT_EMPTY` on commit
   * when override is not set (defense in depth).
   */
  target_non_empty: boolean;
  would_write: {
    customers: number;
    projects: number;
    project_workers: number;
  };
  validation_errors: ValidationIssue[];
}

export interface ImportResult {
  schema_version: number;
  summary: {
    customers: number;
    projects: number;
    project_workers: number;
  };
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
