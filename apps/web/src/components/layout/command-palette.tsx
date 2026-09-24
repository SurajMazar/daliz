import { ArrowLeftRight, CircleUser, LogOut, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { errorMessage } from '@/lib/api';
import { useAccess, useSignOut, useSwitchWorkspace } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import type { NavSection } from './nav';

export function CommandPalette({
  open,
  onOpenChange,
  sections,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sections: NavSection[];
}) {
  const navigate = useNavigate();
  const { me } = useAccess();
  const { mode, toggle } = useTheme();
  const signOut = useSignOut();
  const switcher = useSwitchWorkspace();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const otherWorkspaces = me.memberships.filter(
    (m) => m.tenantId !== me.tenant?.id && m.status === 'active',
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {sections.map((s) => (
          <CommandGroup key={s.title ?? 'main'} heading={s.title ?? 'Navigate'}>
            {s.items.map((item) => (
              <CommandItem
                key={item.to}
                value={`${item.label} ${item.keywords ?? ''}`}
                onSelect={() => run(() => navigate(item.to))}
              >
                <item.icon /> {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandGroup heading="Account">
          <CommandItem
            value="account profile password sessions"
            onSelect={() => run(() => navigate('/account'))}
          >
            <CircleUser /> Account settings
          </CommandItem>
          {me.platform ? (
            <CommandItem
              value="platform console super admin"
              onSelect={() => run(() => navigate('/platform'))}
            >
              <ShieldCheck /> Platform console
            </CommandItem>
          ) : null}
        </CommandGroup>
        {otherWorkspaces.length > 0 ? (
          <CommandGroup heading="Switch workspace">
            {otherWorkspaces.map((m) => (
              <CommandItem
                key={m.tenantId}
                value={`switch workspace ${m.tenantName} ${m.organizationName}`}
                onSelect={() =>
                  run(() => {
                    switcher
                      .switchTo(m.tenantId)
                      .catch((e: unknown) => toast.error(errorMessage(e)));
                  })
                }
              >
                <ArrowLeftRight /> {m.tenantName}
                <span className="text-xs text-muted-foreground">{m.organizationName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="toggle theme dark light mode appearance" onSelect={() => run(toggle)}>
            {mode === 'dark' ? <Sun /> : <Moon />} Switch to {mode === 'dark' ? 'light' : 'dark'}{' '}
            mode
          </CommandItem>
          <CommandItem value="sign out log out" onSelect={() => run(() => signOut.mutate())}>
            <LogOut /> Sign out
            <CommandShortcut />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
