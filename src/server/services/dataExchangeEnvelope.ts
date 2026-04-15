/**
 * Shared types and constants for the unified export/import envelope.
 * See docs/spec/data-model.md §5.8 and ADR-0018.
 */

import type { WorkflowState } from '../../config/stateConfig.js';

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
  address: { street: string; zip: string; city: string } | null;
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
