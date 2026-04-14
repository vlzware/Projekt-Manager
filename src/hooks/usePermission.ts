import { useAuthStore } from '@/state/authStore';
import { hasPermission, type Permission } from '@/config/permissions';

export function usePermission(permission: Permission): boolean {
  return useAuthStore((s) => hasPermission(s.authUser?.roles ?? [], permission));
}
