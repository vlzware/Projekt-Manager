export type Permission =
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:delete'
  | 'project:transition'
  | 'project:dates'
  | 'customer:read'
  | 'customer:write'
  | 'customer:delete'
  | 'user:read'
  | 'user:manage'
  | 'auth:change-password';

export type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'project:transition',
    'project:dates',
    'customer:read',
    'customer:write',
    'customer:delete',
    'user:read',
    'user:manage',
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
