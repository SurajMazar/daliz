import { ShieldCheck } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { NotFoundPage } from '@/features/errors/not-found';
import { useAccess } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { humanize } from '@/lib/utils';
import { AppFrame } from './app-frame';
import { platformNav } from './nav';

export function PlatformBrand() {
  return (
    <Link to="/platform" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden>
        <ShieldCheck className="size-4" />
      </span>
      <span className="text-sm font-semibold">Daliz Platform</span>
    </Link>
  );
}

/** Super Admin console shell. Always uses the default Daliz theme. */
export function PlatformShell() {
  const { me, canPlatform } = useAccess();
  const { resetBrand } = useTheme();
  useEffect(() => {
    resetBrand();
  }, [resetBrand]);
  const sections = useMemo(() => platformNav(canPlatform), [canPlatform]);

  if (!me.platform) return <NotFoundPage />;

  return (
    <AppFrame
      variant="platform"
      brand={<PlatformBrand />}
      sections={sections}
      root={{ label: 'Platform', to: '/platform' }}
      sidebarFooter={
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-muted-foreground">{me.account.email}</span>
          <Badge variant="info">{humanize(me.platform.role)}</Badge>
        </div>
      }
    />
  );
}
