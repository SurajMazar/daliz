import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { navigateTo } from '@/lib/navigation';
import { ME_KEY, refreshMe, useAccess } from '@/lib/session';
import { formatDuration, relativeTime } from '@/lib/utils';
import { useNow } from './use-now';

/** Non-dismissable banner shown during a Super Admin support (impersonation) session. */
export function SupportBanner() {
  const { me, canPlatform } = useAccess();
  const support = me.support;
  const qc = useQueryClient();
  const now = useNow(1000);
  const expiredHandled = useRef(false);

  const end = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/platform/support-access/end'),
    onSuccess: async () => {
      const tenantId = support?.tenantId;
      // Leave the tenant app first so its guards don't redirect while the session refreshes.
      navigateTo(tenantId ? `/platform/tenants/${tenantId}` : '/platform', { replace: true });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      await refreshMe();
    },
  });

  const remainingMs = support ? new Date(support.expiresAt).getTime() - now : 0;

  useEffect(() => {
    if (!support) {
      expiredHandled.current = false;
      return;
    }
    if (remainingMs <= 0 && !expiredHandled.current) {
      expiredHandled.current = true;
      navigateTo('/platform', { replace: true });
      void refreshMe();
    }
  }, [remainingMs, support]);

  if (!support) return null;
  const urgent = remainingMs < 5 * 60_000;

  return (
    <div
      role="region"
      aria-label="Support session"
      className="relative z-40 flex shrink-0 print:hidden flex-wrap items-center gap-x-4 gap-y-2 bg-[#7a1f12] px-4 py-2 text-sm text-white shadow-md sm:px-6"
    >
      <LifeBuoy className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Support session in {support.tenantName}</span>
        <span className="mx-1.5 opacity-70">—</span>
        <span className="rounded bg-white/15 px-1.5 py-0.5 text-xs font-semibold tracking-wide uppercase">
          {support.allowWrite ? 'Write access' : 'Read-only'}
        </span>
        <span className="mx-1.5 opacity-70">—</span>
        <span>
          ends {relativeTime(support.expiresAt, now)}{' '}
          <span
            className={urgent ? 'font-semibold' : 'opacity-80'}
            aria-live={urgent ? 'polite' : 'off'}
          >
            ({formatDuration(remainingMs / 1000)} left)
          </span>
        </span>
        <span className="mx-1.5 opacity-70">—</span>
        <span className="opacity-90">reason: {support.reason}</span>
      </p>
      {canPlatform('platform.support_access') ? (
        <Button
          size="sm"
          variant="outline"
          className="border-white/40 bg-transparent text-white hover:bg-white/15 hover:text-white"
          loading={end.isPending}
          onClick={() => end.mutate()}
        >
          End session
        </Button>
      ) : null}
    </div>
  );
}
