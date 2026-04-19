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
  | 'auth:change-password';

export type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

// data:export gates the unified business-data export (api.md §14.2.4).
// data:restore gates the unified import — owner-only because a restore
// replaces all business data in a single transaction (api.md §14.3).
//
// audit:read gates the audit surface (api.md §14.2.8). The permission is
// deliberately coarse; visibility is narrowed by orthogonal scope predicates
// at the repository layer (auditReachabilityScopeForCaller and
// auditDestructiveScopeForCaller — see scope.ts and api.md §14.3 design
// notes). Bookkeeper holds no audit:read as of the post-refinement matrix;
// workers hold it, their visibility is scoped by the reachability
// predicate.
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
  worker: ['project:read', 'customer:read', 'audit:read', 'auth:change-password'],
  bookkeeper: ['project:read', 'customer:read', 'auth:change-password'],
};

export function hasPermission(roles: string[], permission: Permission): boolean {
  return roles.some((role) => {
    const perms = ROLE_PERMISSIONS[role as Role];
    return perms?.includes(permission) ?? false;
  });
}
