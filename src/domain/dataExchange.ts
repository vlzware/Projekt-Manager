/**
 * Unified data-exchange contract (ADR-0018, data-model.md §5.8).
 *
 * Canonical types shared between server and UI. Lives in the domain layer
 * so both halves can import it without violating the eslint.config.js
 * layer boundary (UI cannot import from src/server/**).
 */

import type { WorkflowState } from '@/config/stateConfig';
import type { Address } from './types';

/**
 * Monotonic envelope-format version. Imports reject any mismatch outright —
 * no format-migration code (ADR-0018).
 */
export const SCHEMA_VERSION = 1;

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

export interface ImportOptions {
  dryRun: boolean;
  override: boolean;
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
   * checkbox; the server still enforces `TARGET_NOT_EMPTY` on commit when
   * override is not set (defense in depth).
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
