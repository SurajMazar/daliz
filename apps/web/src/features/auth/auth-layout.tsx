import { Moon, Sun } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePublicBranding } from '@/features/branding/api';
import { useTheme } from '@/lib/theme';

/**
 * Layout for sign-in and account-recovery pages. Branding (name, logo, theme, message) comes
 * from GET /public/branding, which the API resolves from the Host — acme.localhost gets Acme.
 */
export function AuthLayout() {
  const branding = usePublicBranding();
  const { setBrand, mode, toggle } = useTheme();
  const data = branding.data;

  useEffect(() => {
    if (data) setBrand({ theme: data.theme, name: data.name, favicon: data.logo?.urls['favicon-32'] ?? null });
  }, [data, setBrand]);

  return (
    <div className="relative flex min-h-dvh flex-col bg-muted/40">
      <div className="absolute top-4 right-4">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {mode === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </div>
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {branding.isPending ? (
            <Skeleton className="h-10 w-40" />
          ) : data?.logo ? (
            <img src={data.logo.urls.login} alt={data.name} className="h-14 max-w-[260px] object-contain" />
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground" aria-hidden>
                {(data?.name ?? 'Daliz').charAt(0)}
              </span>
              <span className="text-xl font-semibold tracking-tight">{data?.name ?? 'Daliz'}</span>
            </div>
          )}
          {data?.loginMessage ? <p className="max-w-sm text-sm whitespace-pre-line text-muted-foreground">{data.loginMessage}</p> : null}
        </div>
        <div className="w-full max-w-[420px]">
          <Outlet />
        </div>
      </main>
      <footer className="pb-6 text-center text-xs text-muted-foreground">
        {data?.tenantId ? `${data.name} · powered by Daliz` : 'Daliz'}
      </footer>
    </div>
  );
}

export function AuthCard({ title, description, children, wide }: { title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'mx-auto w-full max-w-lg' : undefined}>
      <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="mb-6 space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}
