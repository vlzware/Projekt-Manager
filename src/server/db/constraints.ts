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
  attachments: {
    pkey: 'attachments_pkey',
    projectFk: 'attachments_project_id_projects_id_fk',
    createdByFk: 'attachments_created_by_users_id_fk',
    originalKeyUnique: 'attachments_original_key_uq',
    validStatus: 'attachments_valid_status',
    validKind: 'attachments_valid_kind',
    validLabel: 'attachments_valid_label',
    validMimeType: 'attachments_valid_mime_type',
  },
} as const;
