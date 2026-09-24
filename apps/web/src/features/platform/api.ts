import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  HealthReport,
  OrganizationRow,
  PlatformAdminRow,
  PlatformDashboard,
  PlatformSettings,
  SecurityEventRow,
  TenantDetail,
  TenantRow,
  TenantStatus,
} from '@daliz/shared';
import { api, type Query } from '@/lib/api';

export interface PlatformMeta {
  plans: string[];
  tenantStatuses: TenantStatus[];
}

export interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
}

export const platformKeys = {
  all: ['platform'] as const,
  dashboard: ['platform', 'dashboard'] as const,
  health: ['platform', 'health'] as const,
  meta: ['platform', 'meta'] as const,
  organizations: (q: Query) => ['platform', 'organizations', q] as const,
  organizationsAll: ['platform', 'organizations'] as const,
  tenants: (q: Query) => ['platform', 'tenants', q] as const,
  tenantsAll: ['platform', 'tenants'] as const,
  tenant: (id: string) => ['platform', 'tenant', id] as const,
  tenantAudit: (id: string) => ['platform', 'tenant', id, 'audit'] as const,
  audit: ['platform', 'audit'] as const,
  securityEvents: (q: Query) => ['platform', 'security-events', q] as const,
  admins: ['platform', 'admins'] as const,
  settings: ['platform', 'settings'] as const,
  flags: ['platform', 'flags'] as const,
};

export function usePlatformDashboard() {
  return useQuery({ queryKey: platformKeys.dashboard, queryFn: () => api.get<PlatformDashboard>('/platform/dashboard'), refetchInterval: 30_000 });
}

export function useHealth() {
  return useQuery({ queryKey: platformKeys.health, queryFn: () => api.get<HealthReport>('/platform/health'), refetchInterval: 15_000 });
}

export function usePlatformMeta() {
  return useQuery({ queryKey: platformKeys.meta, queryFn: () => api.get<PlatformMeta>('/platform/meta'), staleTime: Infinity });
}

export function useOrganizations(q: Query, enabled = true) {
  return useQuery({
    queryKey: platformKeys.organizations(q),
    queryFn: () => api.list<OrganizationRow>('/platform/organizations', q),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTenants(q: Query) {
  return useQuery({
    queryKey: platformKeys.tenants(q),
    queryFn: () => api.list<TenantRow>('/platform/tenants', q),
    placeholderData: keepPreviousData,
  });
}

function isProvisioning(t: TenantDetail | undefined): boolean {
  if (!t) return false;
  return t.status === 'provisioning' || t.provisioning?.status === 'queued' || t.provisioning?.status === 'running' || t.databaseStatus === 'migrating';
}

/** Polls every 2s while the tenant is being provisioned (or migrated). */
export function useTenantDetail(id: string) {
  return useQuery({
    queryKey: platformKeys.tenant(id),
    queryFn: () => api.get<TenantDetail>(`/platform/tenants/${id}`),
    refetchInterval: (query) => (isProvisioning(query.state.data) ? 2000 : false),
  });
}

export function useSecurityEvents(q: Query) {
  return useQuery({
    queryKey: platformKeys.securityEvents(q),
    queryFn: () => api.list<SecurityEventRow>('/platform/security-events', q),
    placeholderData: keepPreviousData,
  });
}

export function usePlatformAdmins() {
  return useQuery({ queryKey: platformKeys.admins, queryFn: () => api.get<PlatformAdminRow[]>('/platform/admins') });
}

export function usePlatformSettings(enabled = true) {
  return useQuery({ queryKey: platformKeys.settings, queryFn: () => api.get<PlatformSettings>('/platform/settings'), enabled });
}

export function useFeatureFlags() {
  return useQuery({ queryKey: platformKeys.flags, queryFn: () => api.get<FeatureFlag[]>('/platform/feature-flags') });
}
