import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link, Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useTenantBranding } from '@/features/branding/api';
import { useAccess } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { AppFrame } from './app-frame';
import { tenantNav } from './nav';

export function TenantBrand({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${name} home`}>
      {logoUrl ? (
        <img src={logoUrl} alt={name} className="h-8 max-w-[180px] object-contain object-left" />
      ) : (
        <>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground" aria-hidden>
            {name.charAt(0).toUpperCase()}
          </span>
          <span className="truncate text-sm font-semibold">{name}</span>
        </>
      )}
    </Link>
  );
}

/** Tenant app shell. Applies the tenant's theme, favicon and nav filtered by permission. */
export function TenantShell() {
  const { me, can } = useAccess();
  const tenant = me.tenant;
  const branding = useTenantBranding(tenant?.id);
  const { setBrand } = useTheme();
  const displayName = tenant?.settings.displayName || tenant?.name || 'Workspace';

  useEffect(() => {
    if (!tenant) return;
    if (branding.data) {
      setBrand({ theme: branding.data.theme, name: displayName, favicon: branding.data.logo?.urls['favicon-32'] ?? null });
    }
  }, [branding.data, tenant, displayName, setBrand]);

  const sections = useMemo(() => tenantNav(can), [can]);

  if (!tenant) {
    if (me.platform && me.memberships.length === 0) return <Navigate to="/platform" replace />;
    return <Navigate to="/select-workspace" replace />;
  }

  const switchable = me.memberships.filter((m) => m.status === 'active').length > 1;

  return (
    <AppFrame
      variant="tenant"
      brand={<TenantBrand name={displayName} logoUrl={branding.data?.logo?.urls.sidebar ?? null} />}
      sections={sections}
      root={{ label: displayName, to: '/' }}
      sidebarFooter={
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{tenant.name}</div>
            <div className="truncate text-xs text-muted-foreground">{tenant.roles.map((r) => r.name).join(', ') || (me.support ? 'Support session' : 'Member')}</div>
          </div>
          {switchable ? (
            <Button asChild variant="ghost" size="icon-sm" aria-label="Switch workspace">
              <Link to="/select-workspace">
                <ArrowLeftRight />
              </Link>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
