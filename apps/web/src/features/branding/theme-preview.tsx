import type { ThemeInput } from '@daliz/shared';
import { Bell, LayoutDashboard, Palette, Search, Users } from 'lucide-react';
import { themeStyle, type ResolvedMode } from '@/lib/theme';
import { cn } from '@/lib/utils';

export interface PreviewLogos {
  header?: string;
  sidebar?: string;
  login?: string;
}

/**
 * A miniature app rendered with a draft theme. The theme's derived CSS variables are set as
 * inline style on this container only, so nothing outside it changes until the theme is saved.
 */
export function ThemePreview({ theme, mode, name, logos, loginMessage }: { theme: ThemeInput; mode: ResolvedMode; name: string; logos: PreviewLogos; loginMessage: string }) {
  const style = themeStyle(theme, mode);
  return (
    <figure className="grid gap-2">
      <figcaption className="text-xs font-medium text-muted-foreground">{mode === 'dark' ? 'Dark mode' : 'Light mode'}</figcaption>
      <div
        style={style}
        className={cn('overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm', mode === 'dark' && 'dark')}
        role="group"
        aria-label={`${mode} mode preview`}
      >
        <div className="flex min-h-[300px] text-[13px]">
          {/* Sidebar */}
          <div className="hidden w-40 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground sm:flex">
            <div className="flex h-11 items-center border-b border-sidebar-border px-3">
              {logos.sidebar ? (
                <img src={logos.sidebar} alt="" className="h-6 max-w-[120px] object-contain object-left" />
              ) : (
                <span className="flex items-center gap-1.5 font-semibold">
                  <span className="flex size-5 items-center justify-center rounded-sm bg-primary text-[10px] font-bold text-primary-foreground">{name.charAt(0)}</span>
                  <span className="truncate">{name}</span>
                </span>
              )}
            </div>
            <div className="grid gap-0.5 p-2">
              <span className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 font-medium text-sidebar-accent-foreground">
                <LayoutDashboard className="size-3.5 text-primary" aria-hidden /> Dashboard
              </span>
              <span className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-80">
                <Users className="size-3.5 text-muted-foreground" aria-hidden /> Users
              </span>
              <span className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-80">
                <Palette className="size-3.5 text-muted-foreground" aria-hidden /> Branding
              </span>
            </div>
          </div>
          {/* Main */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              {logos.header ? <img src={logos.header} alt="" className="h-5 max-w-[100px] object-contain object-left sm:hidden" /> : null}
              <span className="flex-1 truncate text-muted-foreground">Dashboard</span>
              <span className="hidden items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-muted-foreground md:flex">
                <Search className="size-3" aria-hidden /> Search…
              </span>
              <Bell className="size-3.5 text-muted-foreground" aria-hidden />
            </div>
            <div className="grid gap-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground">
                  Primary
                </span>
                <span className="rounded-md bg-secondary px-2.5 py-1 font-medium text-secondary-foreground">
                  Secondary
                </span>
                <span className="rounded-md border border-input bg-background px-2.5 py-1 font-medium">
                  Outline
                </span>
                <span className="rounded-md bg-destructive px-2.5 py-1 font-medium text-destructive-foreground">
                  Delete
                </span>
              </div>
              <div className="rounded-lg border border-border bg-card text-card-foreground">
                <div className="border-b border-border px-3 py-2">
                  <div className="font-semibold">Team</div>
                  <div className="text-[11px] text-muted-foreground">
                    Members of {name}. <span className="font-medium text-primary underline underline-offset-2">View all</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">OO</span>
                  <span className="min-w-0 flex-1 truncate">Olivia Owner</span>
                  <span className="rounded-sm border border-success/25 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">Active</span>
                  <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">Owner</span>
                </div>
                <div className="flex items-center gap-2 border-t border-border bg-muted/60 px-3 py-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">AA</span>
                  <span className="min-w-0 flex-1 truncate">Adam Admin</span>
                  <span className="rounded-sm border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">Invited</span>
                </div>
              </div>
              {/* Login card */}
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <div className="mx-auto grid max-w-[220px] gap-2 rounded-md border border-border bg-card p-3 text-center">
                  {logos.login ? (
                    <img src={logos.login} alt="" className="mx-auto h-7 max-w-[160px] object-contain" />
                  ) : (
                    <div className="font-semibold">{name}</div>
                  )}
                  {loginMessage ? <div className="line-clamp-2 text-[10px] text-muted-foreground">{loginMessage}</div> : null}
                  <div className="h-6 rounded-md border border-input bg-background" />
                  <div className="rounded-md bg-primary py-1 text-[11px] font-medium text-primary-foreground">
                    Sign in
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
