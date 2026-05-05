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
 * no format-migration code (ADR-0018). Bumped to `2` when the takeout-zip
 * restore landed (issue #163): the attachments slot dropped its crypto
 * fields, opaque storage keys, and ciphertext sizes. Pre-#163 (`v1`)
 * envelopes are not consumable on the importing instance and are
 * rejected via SCHEMA_VERSION_MISMATCH.
 */
export const SCHEMA_VERSION = 2;

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
 * Under the takeout-zip restore design (issue #163) crypto fields
 * (`wrappedDek`, `wrappedThumbDek`, `wrappedDekVersion`), opaque
 * storage keys (`originalKey`, `thumbKey`), and ciphertext sizes
 * (`ciphertextSizeBytes`, `ciphertextThumbSizeBytes`) are NOT carried
 * on the envelope: they are not consumable on the importing instance,
 * and the wrapped envelopes additionally remain inside the exporting
 * instance's confidentiality boundary (ADR-0024). The client
 * orchestrator re-uploads each attachment via the standard `init`
 * (with `restore` block) + presigned PUT + `complete` pipeline — fresh
 * DEKs are minted in the browser and wrapped under the importing
 * instance's `BINARY_AGE_RECIPIENT`.
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
   * Attachments — every row with `status = 'ready'`. The export emits
   * the field unconditionally (empty array when no ready rows exist);
   * `/api/import` rejects bodies that carry an `attachments` key
   * (issue #163 / AC-253) — the field rides the takeout zip, not the
   * `/api/import` request body.
   */
  attachments: EnvelopeAttachment[];
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
