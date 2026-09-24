import { useMemo } from 'react';
import { money } from './money';
import { todayIn } from './dates';
import { useSession } from './session';

/** Currency, locale and time zone of the current workspace, plus formatters. */
export function useTenantFormat() {
  const me = useSession();
  const s = me.tenant?.settings;
  return useMemo(() => {
    const currency = s?.currency ?? 'USD';
    const locale = s?.locale ?? 'en-US';
    const timezone = s?.timezone ?? 'UTC';
    return {
      currency,
      locale,
      timezone,
      money: (v: string | null | undefined) => money(v, currency, locale),
      today: () => todayIn(timezone),
    };
  }, [s?.currency, s?.locale, s?.timezone]);
}
