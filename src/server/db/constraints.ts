/**
 * Named DB constraints the service layer matches against when classifying
 * pg integrity-violation errors (SQLSTATE 23xxx + `constraint` property).
 *
 * Centralising them here means a future migration that renames one forces
 * a compile-error at every call site instead of silently mis-classifying
 * a 23505 as "wrong constraint" → wrong HTTP status.
 */
export const DB_CONSTRAINTS = {
  customers: { pkey: 'customers_pkey' },
  projects: { pkey: 'projects_pkey', numberUnique: 'projects_number_unique' },
} as const;
