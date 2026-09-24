import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AssignableRole,
  AuditRow,
  RoleRow,
  TenantSecurityPolicy,
  TenantSettings,
  TenantUserRow,
} from '@daliz/shared';
import { cachedQuery } from '@/offline/cache';
import { api, type Query } from '@/lib/api';

export interface TenantDashboard {
  users: { active: number; invited: number; disabled: number; limit: number };
  roles: number;
  storageQuotaMb: number;
  plan: string;
  recentActivity:
    | null
    | {
        id: string;
        action: string;
        actorEmail: string | null;
        actorType: AuditRow['actorType'];
        occurredAt: string;
        outcome: AuditRow['outcome'];
      }[];
}

export interface PermissionCatalogEntry {
  key: string;
  group: string;
  description: string;
}

export type GeneralSettings = TenantSettings & { version: number };
export type SecuritySettings = TenantSecurityPolicy & { version: number };

export const adminKeys = {
  dashboard: ['tenant', 'dashboard'] as const,
  users: (q: Query) => ['tenant', 'users', q] as const,
  usersAll: ['tenant', 'users'] as const,
  roles: ['tenant', 'roles'] as const,
  assignableRoles: ['tenant', 'assignable-roles'] as const,
  permissions: ['tenant', 'permissions'] as const,
  general: ['tenant', 'settings', 'general'] as const,
  security: ['tenant', 'settings', 'security'] as const,
  audit: (q: Query) => ['tenant', 'audit', q] as const,
};

export function useTenantDashboard() {
  return useQuery({
    queryKey: adminKeys.dashboard,
    queryFn: () => cachedQuery(adminKeys.dashboard, () => api.get<TenantDashboard>('/dashboard')),
  });
}

export function useUsers(q: Query) {
  return useQuery({
    queryKey: adminKeys.users(q),
    queryFn: () => api.list<TenantUserRow>('/users', q),
    placeholderData: keepPreviousData,
  });
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: adminKeys.roles,
    queryFn: () => api.get<RoleRow[]>('/roles'),
    enabled,
  });
}

/** Roles the caller may grant (needs users.create); already filtered server-side. */
export function useAssignableRoles(enabled = true) {
  return useQuery({
    queryKey: adminKeys.assignableRoles,
    queryFn: () => api.get<AssignableRole[]>('/users/assignable-roles'),
    enabled,
  });
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: adminKeys.permissions,
    queryFn: () => api.get<PermissionCatalogEntry[]>('/permissions'),
    staleTime: 10 * 60_000,
  });
}

export function useGeneralSettings() {
  return useQuery({
    queryKey: adminKeys.general,
    queryFn: () => api.get<GeneralSettings>('/settings/general'),
  });
}

export function useSecuritySettings() {
  return useQuery({
    queryKey: adminKeys.security,
    queryFn: () => api.get<SecuritySettings>('/settings/security'),
  });
}

export function useTenantAudit(q: Query) {
  return useQuery({
    queryKey: adminKeys.audit(q),
    queryFn: () => api.list<AuditRow>('/audit', q),
    placeholderData: keepPreviousData,
  });
}
