/**
 * Drizzle ORM schema — PostgreSQL tables for Projekt-Manager.
 *
 * Five tables: customers, projects, project_workers, users, sessions.
 * See data-model.md for entity definitions.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  numeric,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

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
