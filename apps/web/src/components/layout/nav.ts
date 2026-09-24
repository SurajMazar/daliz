import type { PlatformPermission, TenantPermission } from '@daliz/shared';
import {
  BookOpen,
  Building,
  Calculator,
  CalendarDays,
  Plug,
  FolderOpen,
  SquareKanban,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  Palette,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  keywords?: string;
}
export interface NavSection {
  title: string | null;
  items: NavItem[];
}

interface TenantNavItem extends NavItem {
  perm?: TenantPermission;
}
interface PlatformNavItem extends NavItem {
  perm: PlatformPermission;
}

const TENANT_NAV: { title: string | null; items: TenantNavItem[] }[] = [
  { title: null, items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, keywords: 'home overview' }] },
  {
    title: 'Finance',
    items: [
      { to: '/daybook', label: 'Daybook', icon: BookOpen, perm: 'daybook.read', keywords: 'income expense cash bank' },
      { to: '/accounting', label: 'Accounting', icon: Calculator, perm: 'accounting.read', keywords: 'journal ledger reports chart of accounts' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { to: '/planner', label: 'Planner', icon: SquareKanban, perm: 'planner.read', keywords: 'projects tasks board' },
      { to: '/events', label: 'Events', icon: CalendarDays, perm: 'events.read', keywords: 'calendar meetings reminders' },
      { to: '/files', label: 'Files', icon: FolderOpen, perm: 'files.read', keywords: 'documents library upload' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/admin/users', label: 'Users', icon: Users, perm: 'users.read', keywords: 'members people invite' },
      { to: '/admin/roles', label: 'Roles', icon: KeyRound, perm: 'roles.read', keywords: 'permissions access' },
      { to: '/admin/branding', label: 'Branding', icon: Palette, perm: 'branding.read', keywords: 'logo colors theme' },
      { to: '/admin/security', label: 'Security', icon: ShieldCheck, perm: 'security.read', keywords: 'mfa session policy' },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.read', keywords: 'activity history events' },
      { to: '/admin/settings', label: 'Settings', icon: Settings, perm: 'settings.read', keywords: 'locale timezone currency' },
      { to: '/admin/integrations', label: 'Integrations', icon: Plug, perm: 'settings.update', keywords: 'api keys tokens' },
    ],
  },
];

const PLATFORM_NAV: { title: string | null; items: PlatformNavItem[] }[] = [
  {
    title: null,
    items: [{ to: '/platform', label: 'Dashboard', icon: LayoutDashboard, end: true, perm: 'platform.dashboard.read', keywords: 'overview' }],
  },
  {
    title: 'Customers',
    items: [
      { to: '/platform/organizations', label: 'Organizations', icon: Building, perm: 'platform.organizations.read', keywords: 'companies' },
      { to: '/platform/tenants', label: 'Tenants', icon: Server, perm: 'platform.tenants.read', keywords: 'workspaces provisioning' },
    ],
  },
  {
    title: 'Security',
    items: [
      { to: '/platform/audit', label: 'Audit log', icon: ScrollText, perm: 'platform.audit.read', keywords: 'history' },
      { to: '/platform/security-events', label: 'Security events', icon: ShieldAlert, perm: 'platform.audit.read', keywords: 'logins alerts' },
      { to: '/platform/admins', label: 'Platform admins', icon: UserCog, perm: 'platform.admins.manage', keywords: 'operators staff' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/platform/settings', label: 'Settings', icon: Settings, perm: 'platform.settings.manage', keywords: 'maintenance flags' },
      { to: '/platform/health', label: 'System health', icon: HeartPulse, perm: 'platform.health.read', keywords: 'status queues' },
    ],
  },
];

function filter<T extends NavItem & { perm?: string }>(sections: { title: string | null; items: T[] }[], has: (p: string) => boolean): NavSection[] {
  return sections
    .map((s) => ({ title: s.title, items: s.items.filter((i) => !i.perm || has(i.perm)) }))
    .filter((s) => s.items.length > 0);
}

export function tenantNav(can: (p: TenantPermission) => boolean): NavSection[] {
  return filter(TENANT_NAV, (p) => can(p as TenantPermission));
}

export function platformNav(can: (p: PlatformPermission) => boolean): NavSection[] {
  return filter(PLATFORM_NAV, (p) => can(p as PlatformPermission));
}
