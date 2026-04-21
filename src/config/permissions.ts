export type Permission =
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:delete'
  | 'project:purge'
  | 'project:transition'
  | 'project:dates'
  | 'customer:read'
  | 'customer:write'
  | 'customer:delete'
  | 'user:read'
  | 'user:manage'
  | 'user:delete'
  | 'data:export'
  | 'data:restore'
  | 'audit:read'
  | 'notifications:manage'
  | 'auth:change-password';

export type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

// data:export gates the unified business-data export (api.md §14.2.4).
// data:restore gates the unified import — owner-only because a restore
// replaces all business data in a single transaction (api.md §14.3).
//
// audit:read gates the audit surface (api.md §14.2.8). Owner and office
// hold it; worker and bookkeeper do not. The destructive-action predicate
// in scope.ts narrows office-visible rows further (purges, user deletes,
// roles mutations are owner-only). The reachability predicate for workers
// was dropped when workers lost audit:read — the audit surface is
// administrative, not worker-facing, and a scoped-worker view never got
// meaningful daily use.
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'project:purge',
    'project:transition',
    'project:dates',
    'customer:read',
    'customer:write',
    'customer:delete',
    'user:read',
    'user:manage',
    'user:delete',
    'data:export',
    'data:restore',
    'audit:read',
    // notifications:manage aligns with user:manage as an admin-only gate
    // (api.md §14.3, ADR-0023). Rule edits change who-sees-what platform-
    // wide, so the least-privilege baseline is owner only.
    'notifications:manage',
    'auth:change-password',
  ],
  office: [
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'project:transition',
    'project:dates',
    'customer:read',
    'customer:write',
    'user:read',
    'data:export',
    'audit:read',
    'auth:change-password',
  ],
  worker: ['project:read', 'customer:read', 'auth:change-password'],
  bookkeeper: ['project:read', 'customer:read', 'auth:change-password'],
};

export function hasPermission(roles: string[], permission: Permission): boolean {
  return roles.some((role) => {
    const perms = ROLE_PERMISSIONS[role as Role];
    return perms?.includes(permission) ?? false;
  });
}
