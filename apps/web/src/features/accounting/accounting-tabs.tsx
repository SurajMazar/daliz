import { NavLink } from 'react-router';
import { useAccess } from '@/lib/session';
import { cn } from '@/lib/utils';

/** Secondary navigation inside Accounting. */
export function AccountingTabs() {
  const { can } = useAccess();
  const tabs = [
    { to: '/accounting', label: 'Journal', end: true },
    { to: '/accounting/accounts', label: 'Chart of accounts' },
    { to: '/accounting/reports', label: 'Reports' },
    ...(can('accounting.approve') && can('settings.update') ? [{ to: '/accounting/settings', label: 'Settings' }] : []),
  ];
  return (
    <nav aria-label="Accounting" className="mb-6 flex gap-1 overflow-x-auto border-b print:hidden">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
