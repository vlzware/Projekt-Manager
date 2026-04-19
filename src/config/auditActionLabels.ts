/**
 * German labels for audit-log actions.
 *
 * Mapping from the API's action vocabulary (api.md §14.2.8, data-model.md
 * §5.10) to a user-facing German label rendered in both the project-
 * detail activity feed (ui/workflow-views.md §8.4.1) and the global
 * Aktivität view (ui/management.md §8.13).
 *
 * [C] customer-configurable per architecture.md §12.2. Mirrors the
 * pattern in `stateConfig.ts` / `backupThresholds.ts`: the config layer
 * owns the mapping, the UI layer reads it through a small resolver.
 *
 * New action vocabulary values must be added here — `labelForAuditAction`
 * falls back to the raw action string if a label is missing, so a new
 * server-side action does not break rendering, but the fallback is a
 * visible reminder that a translation row is owed.
 */

/**
 * The server-side action vocabulary. Kept here (not imported from the
 * server module) because the config layer cannot depend on server code
 * (eslint layering rule, architecture.md §11.2). A new action on the
 * server side lands without breaking the UI — the resolver falls back
 * to the raw action string, and a PR reviewer catches the drift when
 * the UI-facing label is empty.
 */
export const AUDIT_ACTION_KEYS = [
  'create',
  'update',
  'delete',
  'transition:forward',
  'transition:backward',
  'purge',
  'reactivate',
  'deactivate',
  'password-reset',
  'password-change',
] as const;

export type AuditActionKey = (typeof AUDIT_ACTION_KEYS)[number];

/**
 * Primary action-to-label mapping. Rendered as the one-line description
 * of an audit row when no richer payload-aware derivation applies.
 *
 * Localized German, consistent with the project's "German UI, English
 * code" rule.
 */
export const AUDIT_ACTION_LABELS: Record<AuditActionKey, string> = {
  create: 'Erstellt',
  update: 'Aktualisiert',
  delete: 'Gelöscht',
  'transition:forward': 'Status weiter',
  'transition:backward': 'Status zurück',
  purge: 'Endgültig gelöscht',
  reactivate: 'Reaktiviert',
  deactivate: 'Deaktiviert',
  'password-reset': 'Passwort zurückgesetzt',
  'password-change': 'Passwort geändert',
};

/**
 * Resolve a raw action string to its German label. Falls back to the
 * raw value for unknown actions — see module docstring for the rationale.
 */
export function labelForAuditAction(action: string): string {
  if ((AUDIT_ACTION_KEYS as readonly string[]).includes(action)) {
    return AUDIT_ACTION_LABELS[action as AuditActionKey];
  }
  return action;
}
