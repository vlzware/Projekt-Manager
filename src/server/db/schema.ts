/**
 * Drizzle ORM schema — PostgreSQL tables for Projekt-Manager.
 *
 * Tables: customers, projects, project_workers, users, sessions, audit_log,
 * notification_rule, push_subscriptions. See data-model.md for entity
 * definitions.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  timestamp,
  date,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------
// Audit entity types — data-model.md §5.10
// ---------------------------------------------------------------
/**
 * The closed set of domain entities that produce `audit_log` rows.
 * Declared here so repositories and services can import the type and
 * so the architecture check (scripts/check-audit-mutations.sh) can
 * derive its audited-tables list from a single source (AC-179).
 */
export const AUDIT_ENTITY_TYPES = ['project', 'customer', 'user', 'project_worker'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Maps each `AuditEntityType` to its physical table representation: the
 * SQL table name (used by raw-SQL scanners) and the Drizzle export name
 * (used by builder-call scanners). The architecture check at
 * `scripts/check-audit-mutations.sh` reads this map via
 * `scripts/print-audited-tables.ts` — AC-179 requires the audited-table
 * set to be derived from `AuditEntityType`, not hand-maintained.
 *
 * `Record<AuditEntityType, …>` + `satisfies` forces a tsc error when a
 * new `AuditEntityType` value lands without a corresponding mapping:
 * that is the build-time seam AC-179 Part 2 pins.
 *
 * AC-179 Part 2 also pins `attachment` as an audited table even though
 * `attachment` is NOT a member of `AuditEntityType`: attachment rows are
 * audited as sub-entities of the owning project (entityType = 'project',
 * action in `attachment:add` / `attachment:remove`). The explicit
 * `attachment` key is tracked separately below so the arch-check sees
 * the table while the enum stays the authoritative one-audit-row-per-
 * entity catalog.
 */
export const AUDIT_ENTITY_TO_TABLE = {
  project: { sqlName: 'projects', drizzleExport: 'projects' },
  customer: { sqlName: 'customers', drizzleExport: 'customers' },
  user: { sqlName: 'users', drizzleExport: 'users' },
  project_worker: { sqlName: 'project_workers', drizzleExport: 'projectWorkers' },
  // Sub-entity surface — AC-179 Part 2. Not a member of `AuditEntityType`;
  // rows are audited as `entityType = 'project'`. Listed here so the CI
  // architecture check observes the table; `scripts/print-audited-tables.ts`
  // uses only the value names, so no satisfies-type drift.
  attachment: { sqlName: 'attachments', drizzleExport: 'attachments' },
} as const satisfies Record<
  AuditEntityType | 'attachment',
  { sqlName: string; drizzleExport: string }
>;

// ---------------------------------------------------------------
// Users (data-model.md §5.3, §5.7)
// ---------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: varchar('username', { length: 255 }).notNull().unique(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: text('roles').array().notNull().default([]),
    email: varchar('email', { length: 255 }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // Audit references — nullable for seeded/bootstrapped records (data-model.md §5.5).
    // No FK back to users.id: self-referential FKs complicate bootstrapping
    // and deletion without adding meaningful integrity guarantees here.
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    // data-model.md §5.7: 'light' | 'dark' | 'system'. DB default matches
    // the documented new-user default; the CHECK constraint below is the
    // defense-in-depth backstop pinned by AT-57 / AC-115.
    themePreference: text('theme_preference').notNull().default('system'),
    // data-model.md §5.3 / §5.12: single self-settable boolean controlling
    // push delivery. Mute is a delivery-time filter — activity-feed
    // inclusion is independent.
    pushMuted: boolean('push_muted').notNull().default(false),
  },
  (table) => [
    check(
      'users_valid_theme_preference',
      sql`${table.themePreference} IN ('light', 'dark', 'system')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Sessions (data-model.md §5.4)
// ---------------------------------------------------------------
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 64 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_sessions_expires_at').on(table.expiresAt),
    index('idx_sessions_user_id').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Customers (data-model.md §5.6)
// ---------------------------------------------------------------
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 100 }),
  email: varchar('email', { length: 255 }),
  address: jsonb('address').$type<{
    street: string;
    zip: string;
    city: string;
  } | null>(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// ---------------------------------------------------------------
// Projects (data-model.md §5.1)
// ---------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: varchar('number', { length: 20 }).notNull().unique(),
    title: varchar('title', { length: 500 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('anfrage'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),

    plannedStart: date('planned_start', { mode: 'date' }),
    plannedEnd: date('planned_end', { mode: 'date' }),

    estimatedValue: numeric('estimated_value', { precision: 12, scale: 2 }),
    notes: text('notes'),
    deleted: boolean('deleted').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_projects_status').on(table.status),
    index('idx_projects_status_changed_at').on(table.statusChangedAt),
    index('idx_projects_customer_id').on(table.customerId),
    check(
      'projects_end_requires_start',
      sql`${table.plannedEnd} IS NULL OR ${table.plannedStart} IS NOT NULL`,
    ),
    check(
      'projects_end_not_before_start',
      sql`${table.plannedEnd} IS NULL OR ${table.plannedStart} IS NULL OR ${table.plannedEnd} >= ${table.plannedStart}`,
    ),
    check(
      'projects_valid_status',
      sql`${table.status} IN ('anfrage', 'angebot', 'beauftragt', 'geplant', 'in_arbeit', 'abnahme', 'rechnung_faellig', 'abgerechnet', 'erledigt')`,
    ),
  ],
);

// ---------------------------------------------------------------
// Project–Worker assignments (m:n join table)
// ---------------------------------------------------------------
export const projectWorkers = pgTable(
  'project_workers',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('idx_project_workers_user_id').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Backup status (data-model.md §5.9, ADR-0020)
//
// Single-row table. The `singleton` primary key is a fixed sentinel
// enforced by a CHECK so the app never has to distinguish "first
// write" from "nth write" — it always upserts the same row. A row
// is pre-seeded by the migration so repositories can rely on its
// existence (upsert on the sentinel PK).
// ---------------------------------------------------------------
export const metaBackupStatus = pgTable(
  'meta_backup_status',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),
    lastBackupOk: boolean('last_backup_ok').notNull().default(false),
    lastDrillAt: timestamp('last_drill_at', { withTimezone: true }),
    // `lastDrillOk: boolean | null` per data-model.md §5.9 —
    // null is the authoritative "never-run" signal, distinct from "skipped".
    lastDrillOk: boolean('last_drill_ok'),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('meta_backup_status_singleton', sql`${table.singleton} = true`)],
);

// ---------------------------------------------------------------
// Audit log (data-model.md §5.10, ADR-0021)
//
// Append-only record of every domain-entity state change. Written
// atomically with the state change by the service-layer `mutate()`
// helper. The compound CHECK constraint pins the actor_kind /
// actor_id / actor_reason invariant:
//
//   - actor_kind='user'   → actor_id NOT NULL, actor_reason NULL
//   - actor_kind='system' → actor_id NULL,     actor_reason non-empty
//
// The non-empty `actor_reason` is the defense-in-depth backstop for
// AC-178: without it a bootstrap entry would be invisible in the
// activity feed.
// ---------------------------------------------------------------
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // ON DELETE SET NULL mirrors AC-98 for createdBy/updatedBy: hard-deleting
    // a user must not cascade their audit trail away. entity_id deliberately
    // has no FK — a `purge` removes the target row while the audit entry
    // remains (data-model.md §5.10 "Referential integrity").
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull(),
    actorReason: text('actor_reason'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    // Human-readable label for the entity at the time of the event
    // (e.g. "Firma Weber GmbH", "Innenraumgestaltung Weber"). Captured
    // at write time so the activity feed remains readable even after
    // the target row is renamed or purged. Nullable for paths that
    // cannot supply a label (import, retention cleanup); the client
    // falls back to the UUID.
    entityLabel: text('entity_label'),
    action: text('action').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    correlationId: text('correlation_id'),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entityType, table.entityId, table.createdAt.desc()),
    index('audit_log_actor_idx').on(table.actorId, table.createdAt.desc()),
    index('audit_log_created_at_idx').on(table.createdAt.desc()),
    // GIN trigram index powers the Aktivität view's substring search on
    // entity_label (ui/management.md §8.13.2). Without it, `ILIKE '%q%'`
    // falls back to a seq scan. The pg_trgm extension itself is enabled
    // by a hand-edit in 0000_baseline.sql — drizzle-kit does not emit
    // CREATE EXTENSION statements.
    index('audit_log_entity_label_trgm_idx').using('gin', sql`${table.entityLabel} gin_trgm_ops`),
    check('audit_log_actor_kind_valid', sql`${table.actorKind} IN ('user', 'system')`),
    check(
      'audit_log_entity_type_valid',
      sql`${table.entityType} IN ('project', 'customer', 'user', 'project_worker')`,
    ),
    // Compound invariant — AC-178 defense in depth. Missing this CHECK
    // would let a bootstrap write land with actor_reason=NULL, making
    // the first-admin creation invisible to the activity feed.
    //
    // actor_id is deliberately NOT required for user-kind rows: when
    // the authoring user is hard-deleted, the FK's ON DELETE SET NULL
    // clause nullifies this column — per data-model.md §5.10
    // "Referential integrity" (parity with AC-98). Write-time
    // validation lives in the service layer (`validateContext()` in
    // mutate.ts); the CHECK here pins only the invariants that must
    // hold regardless of cascades.
    check(
      'audit_log_actor_shape',
      sql`(
        (${table.actorKind} = 'user'
          AND ${table.actorReason} IS NULL)
        OR
        (${table.actorKind} = 'system'
          AND ${table.actorId} IS NULL
          AND ${table.actorReason} IS NOT NULL
          AND length(trim(${table.actorReason})) > 0)
      )`,
    ),
  ],
);

// ---------------------------------------------------------------
// Notification rule (data-model.md §5.11, ADR-0023)
//
// Admin-editable rules mapping the closed event catalog to recipient
// specs. CRUD does NOT route through `mutate()` — rule changes are
// administrative config, not audited domain events (ADR-0023).
// ---------------------------------------------------------------
export const notificationRule = pgTable('notification_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Event class — closed enum (data-model.md §5.11 NotificationEventClass).
  // Application-level validation restricts the value set; left as text at
  // the DB level so seed migrations do not need a CHECK update per rule.
  eventClass: text('event_class').notNull(),
  // Transition-only filter — matches when `after.status` equals the value;
  // null means no state filter. Application validation rejects non-null
  // values on non-transition classes.
  stateFilter: text('state_filter'),
  // Additive recipient spec: `{ roles, includeAssignedWorkers, userIds }`.
  // Shape pinned by data-model.md §5.11 NotificationRecipientSpec.
  recipientSpec: jsonb('recipient_spec').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// ---------------------------------------------------------------
// Push subscriptions (data-model.md §5.12, ADR-0023)
//
// Per-device push subscription. A user may hold multiple rows (phone,
// desktop). Unique on (user_id, endpoint) so re-subscribe upserts.
// Hard-delete of the user cascades; deactivation retains rows (mute is
// a delivery-time filter).
// ---------------------------------------------------------------
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_subscriptions_user_endpoint_uq').on(table.userId, table.endpoint),
    index('push_subscriptions_user_id_idx').on(table.userId),
  ],
);

// ---------------------------------------------------------------
// Attachments (data-model.md §5.13)
// ---------------------------------------------------------------
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    originalKey: text('original_key').notNull(),
    thumbKey: text('thumb_key'),
    hasThumbnail: boolean('has_thumbnail').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('attachments_project_id_idx').on(table.projectId),
    index('attachments_created_by_idx').on(table.createdBy),
    uniqueIndex('attachments_original_key_uq').on(table.originalKey),
    check('attachments_valid_status', sql`${table.status} IN ('pending', 'ready')`),
    check('attachments_valid_kind', sql`${table.kind} IN ('photo', 'binary')`),
    check(
      'attachments_valid_label',
      sql`${table.label} IN ('angebot', 'auftragsbestaetigung', 'rechnung', 'aufmass', 'foto', 'sonstiges')`,
    ),
    check(
      'attachments_valid_mime_type',
      sql`${table.mimeType} IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`,
    ),
  ],
);
