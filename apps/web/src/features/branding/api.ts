import { useQuery } from '@tanstack/react-query';
import type { PublicBranding, TenantBranding } from '@daliz/shared';
import { api } from '@/lib/api';

export type { TenantBranding };

export const brandingKeys = {
  tenant: (tenantId: string | undefined) => ['branding', tenantId ?? 'none'] as const,
  public: ['public-branding'] as const,
};

export function useTenantBranding(tenantId: string | undefined) {
  return useQuery({
    queryKey: brandingKeys.tenant(tenantId),
    queryFn: () => api.get<TenantBranding>('/branding'),
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
  });
}

export function usePublicBranding() {
  return useQuery({
    queryKey: brandingKeys.public,
    queryFn: () => api.get<PublicBranding>('/public/branding', undefined, { silent: true }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
