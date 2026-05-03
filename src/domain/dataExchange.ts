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

/**
 * Attachment row in the export envelope — `status = 'ready'` only per
 * data-model.md §5.8. Bytes remain storage-owned (ADR-0018); this
 * envelope carries only the metadata row.
 *
 * Under ADR-0024 the wrapped envelope ride the export envelope so
 * attachments restore decryptable post-import (AC-220). The export
 * envelope is therefore sensitive material with the same handling
 * discipline as a DB dump — but the audit-exclusion contract still
 * applies (the wrapped envelopes never appear in `audit_log` payloads).
 */
export interface EnvelopeAttachment {
  id: string;
  projectId: string;
  status: 'ready';
  kind: 'photo' | 'binary';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Ciphertext byte count — ADR-0024 / api.md §14.2.11. */
  ciphertextSizeBytes: number;
  /** Ciphertext byte count of the thumbnail; null for non-photo. */
  ciphertextThumbSizeBytes: number | null;
  originalKey: string;
  thumbKey: string | null;
  hasThumbnail: boolean;
  /** Base64 of the wrapped envelope of the per-blob DEK for the original. */
  wrappedDek: string;
  /** Base64 of the wrapped envelope for the thumbnail; null for non-photo. */
  wrappedThumbDek: string | null;
  /**
   * Wrapped-envelope format discriminator (ADR-0024). Shared between
   * `wrappedDek` and `wrappedThumbDek`. Import validates against the
   * known set and refuses unknown values BEFORE inserting the row.
   */
  wrappedDekVersion: number;
  createdAt: string;
  createdBy: string | null;
}

export interface Envelope {
  schema_version: number;
  exported_at: string;
  customers: EnvelopeCustomer[];
  projects: EnvelopeProject[];
  project_workers: EnvelopeAssignment[];
  /**
   * Attachments — every row with `status = 'ready'`. Optional on the
   * type so legacy fixtures without the field still parse; imports
   * default to an empty list when absent.
   */
  attachments?: EnvelopeAttachment[];
}

export interface ImportOptions {
  dryRun: boolean;
  override: boolean;
  /**
   * Typed confirmation phrase from the caller. Required by the server when
   * `override` is true AND the target database is non-empty (AC-160);
   * ignored on the dry-run and empty-target paths. `null` indicates the
   * request body omitted the field entirely.
   */
  confirmationPhrase: string | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * One envelope reference site whose `userId` is absent from the target
 * `users` table. `path` follows the same shape as `ValidationIssue.path`
 * (e.g. `customers[0].createdBy`, `project_workers[2].userId`).
 */
export interface MissingUserReference {
  path: string;
  userId: string;
}

/**
 * Payload for the `MISSING_USER_REFS` error code and the dry-run preview.
 * See api.md §14.4.1.
 */
export interface MissingUserRefsPayload {
  missingUserIds: string[];
  references: MissingUserReference[];
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
  /**
   * Missing-user references surfaced by the dry-run path (AC-162b). The
   * commit-path error code `MISSING_USER_REFS` uses the same payload shape
   * under `details`. The spec (api.md §14.2.4) deliberately does not mint
   * a wire-field name for the preview, so this sibling field carries the
   * same payload shape as the commit-path `details` for symmetry. `null`
   * when no missing references were found; optional so pre-existing test
   * fixtures that only care about `validation_errors` remain valid without
   * spelling it out.
   */
  missing_user_refs?: MissingUserRefsPayload | null;
}

export interface ImportResult {
  schema_version: number;
  summary: {
    customers: number;
    projects: number;
    project_workers: number;
  };
}
