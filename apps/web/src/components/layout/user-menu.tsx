import { ArrowLeftRight, CircleUser, LogOut, Monitor, Moon, ShieldCheck, Sun, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAccess, useSignOut, useSignOutEverywhere } from '@/lib/session';
import { useTheme } from '@/lib/theme';

export function UserMenu({ variant }: { variant: 'tenant' | 'platform' }) {
  const { me } = useAccess();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const signOutAll = useSignOutEverywhere();
  const { preference, setPreference } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account menu for ${me.account.name}`}>
          <Avatar name={me.account.name} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium text-foreground">{me.account.name}</div>
          <div className="truncate text-xs text-muted-foreground">{me.account.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => navigate('/account')}>
            <CircleUser /> Account
          </DropdownMenuItem>
          {me.memberships.length > 1 || (variant === 'platform' && me.memberships.length > 0) ? (
            <DropdownMenuItem onSelect={() => navigate('/select-workspace')}>
              <ArrowLeftRight /> Switch workspace
            </DropdownMenuItem>
          ) : null}
          {me.platform && variant === 'tenant' ? (
            <DropdownMenuItem onSelect={() => navigate('/platform')}>
              <ShieldCheck /> Platform console
            </DropdownMenuItem>
          ) : null}
          {variant === 'platform' && me.tenant ? (
            <DropdownMenuItem onSelect={() => navigate('/')}>
              <Users /> Open {me.tenant.name}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference ?? 'default'}
          onValueChange={(v) => setPreference(v === 'default' ? null : (v as 'light' | 'dark' | 'system'))}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="text-muted-foreground" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="text-muted-foreground" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="text-muted-foreground" /> System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default">Workspace default</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut.mutate()} disabled={signOut.isPending}>
          <LogOut /> Sign out
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => signOutAll.mutate()} disabled={signOutAll.isPending}>
          <LogOut /> Sign out everywhere
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
