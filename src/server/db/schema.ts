/**
 * Drizzle ORM schema — PostgreSQL tables for Projekt-Manager.
 *
 * Three tables: projects, users, sessions.
 * See data-model.md for entity definitions.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------
// Users (data-model.md §5.3)
// ---------------------------------------------------------------
export const users = pgTable('users', {
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
});

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
// Projects (data-model.md §5.1)
// Customer and address stored as JSONB.
// ---------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: varchar('number', { length: 20 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('anfrage'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),

    customer: jsonb('customer').notNull().$type<{
      name: string;
      phone?: string;
      email?: string;
    }>(),

    address: jsonb('address').$type<{
      street: string;
      zip: string;
      city: string;
    } | null>(),

    plannedStart: timestamp('planned_start', { withTimezone: true }),
    plannedEnd: timestamp('planned_end', { withTimezone: true }),

    assignedWorkers: text('assigned_workers').array(),
    estimatedValue: numeric('estimated_value', { precision: 12, scale: 2 }),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    // Used by future dashboard queries (count by status, filter by status).
    index('idx_projects_status').on(table.status),
    // Used by future "recently changed" and aging threshold queries.
    index('idx_projects_status_changed_at').on(table.statusChangedAt),
  ],
);
