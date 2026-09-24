import { Menu, Moon, Search, Sun } from 'lucide-react';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tooltip } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { BreadcrumbProvider, RouteBreadcrumbs } from './breadcrumbs';
import { CommandPalette } from './command-palette';
import type { NavSection } from './nav';
import { SupportBanner } from './support-banner';
import { UserMenu } from './user-menu';

function SidebarNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {sections.map((s) => (
        <div key={s.title ?? 'main'} className="flex flex-col gap-0.5">
          {s.title ? <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{s.title}</div> : null}
          {s.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} aria-hidden />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function AppFrame({
  brand,
  sections,
  root,
  variant,
  sidebarFooter,
}: {
  brand: ReactNode;
  sections: NavSection[];
  root: { label: string; to: string };
  variant: 'tenant' | 'platform';
  sidebarFooter?: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { mode, toggle } = useTheme();
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const sidebarInner = (
    <>
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">{brand}</div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav sections={sections} onNavigate={() => setMobileOpen(false)} />
      </div>
      {sidebarFooter ? <div className="border-t border-sidebar-border p-3">{sidebarFooter}</div> : null}
    </>
  );

  return (
    <BreadcrumbProvider>
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <div className="flex h-dvh flex-col print:h-auto">
      <SupportBanner />
      <div className="flex min-h-0 flex-1 print:block">
        <aside className="hidden h-full w-64 print:!hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
          {sidebarInner}
        </aside>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Main navigation</SheetDescription>
            {sidebarInner}
          </SheetContent>
        </Sheet>
        <div id="scroll-root" className="flex min-w-0 flex-1 flex-col overflow-y-auto print:overflow-visible">
          <header className="sticky top-0 z-30 print:hidden flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
              <Menu />
            </Button>
            <div className="min-w-0 flex-1">
              <RouteBreadcrumbs root={root} />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="hidden w-56 justify-start gap-2 text-muted-foreground md:inline-flex"
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts="Meta+K Control+K"
            >
              <Search /> Search…
              <kbd className="ml-auto rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">⌘K</kbd>
            </Button>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search" onClick={() => setPaletteOpen(true)}>
              <Search />
            </Button>
            <Tooltip content={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <Button variant="ghost" size="icon" onClick={toggle} aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
                {mode === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </Tooltip>
            <UserMenu variant={variant} />
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 print:max-w-none print:p-0">
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} sections={sections} />
    </BreadcrumbProvider>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-label="Loading page">
      <div className="grid gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
