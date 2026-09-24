import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferenceRow } from '@daliz/shared';
import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { currentPushSubscription, disablePush, enablePush } from '@/lib/push';
import { capabilities } from '@/platform';
import { notificationKeys, usePreferences, usePushConfig } from './api';

type Channel = 'inApp' | 'email' | 'push';

export function NotificationPreferencesCard() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const push = usePushConfig();
  const [draft, setDraft] = useState<NotificationPreferenceRow[] | null>(null);
  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);
  const save = useMutation({
    mutationFn: (rows: NotificationPreferenceRow[]) => api.put<NotificationPreferenceRow[]>('/notifications/preferences', { preferences: rows.map(({ type, inApp, email, push: p }) => ({ type, inApp, email, push: p })) }),
    onSuccess: (rows) => {
      qc.setQueryData(notificationKeys.preferences, rows);
      toast.success('Notification preferences saved');
    },
  });
  const dirty = !!draft && !!prefs.data && JSON.stringify(draft) !== JSON.stringify(prefs.data);
  const set = (type: string, channel: Channel, value: boolean) => setDraft((d) => d?.map((r) => (r.type === type ? { ...r, [channel]: value } : r)) ?? d);

  return (
    <Card id="notifications">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4 text-primary" aria-hidden /> Notifications
        </CardTitle>
        <CardDescription>Choose how you hear about activity in this workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 px-0 sm:px-0">
        {prefs.isPending ? (
          <SkeletonRows rows={5} cols={4} />
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-y text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <th className="px-5 py-2 sm:px-6">Activity</th>
                  <th className="w-20 px-2 py-2 text-center">In-app</th>
                  <th className="w-20 px-2 py-2 text-center">Email</th>
                  <th className="w-20 px-2 py-2 text-center">Push</th>
                </tr>
              </thead>
              <tbody>
                {(draft ?? []).map((r) => (
                  <tr key={r.type} className="border-b">
                    <td className="px-5 py-2.5 sm:px-6">{r.label}</td>
                    {(['inApp', 'email', 'push'] as const).map((c) => (
                      <td key={c} className="px-2 py-2.5 text-center">
                        <Switch checked={r[c]} onCheckedChange={(v) => set(r.type, c, v)} aria-label={`${r.label}: ${c === 'inApp' ? 'in-app' : c}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-5 sm:px-6">
          <PushSettings enabled={!!push.data?.enabled} publicKey={push.data?.publicKey ?? null} />
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant="outline" onClick={() => prefs.data && setDraft(prefs.data)} disabled={!dirty || save.isPending}>
          Reset
        </Button>
        <Button onClick={() => draft && save.mutate(draft)} loading={save.isPending} disabled={!dirty}>
          Save preferences
        </Button>
      </CardFooter>
    </Card>
  );
}

function PushSettings({ enabled, publicKey }: { enabled: boolean; publicKey: string | null }) {
  const supported = capabilities.supportsPush;
  const sub = useQuery({ queryKey: ['push', 'subscription'], queryFn: async () => !!(await currentPushSubscription()), enabled: supported });
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!enabled) return <Alert variant="default" title="Browser notifications aren’t available on this server." />;
  if (!supported) return <Alert variant="default" title="This browser doesn’t support push notifications." />;
  const on = !!sub.data;
  const blocked = 'Notification' in window && Notification.permission === 'denied';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div>
        <div className="text-sm font-medium">Browser notifications</div>
        <p className="text-sm text-muted-foreground">
          {blocked ? 'Notifications are blocked for this site in your browser settings.' : on ? 'This device receives push notifications.' : 'Get notified on this device even when Daliz isn’t open.'}
        </p>
      </div>
      <Button
        variant={on ? 'outline' : 'default'}
        loading={busy}
        disabled={blocked || !publicKey}
        onClick={async () => {
          setBusy(true);
          try {
            if (on) {
              await disablePush();
              toast.success('Browser notifications turned off');
            } else {
              await enablePush(publicKey!);
              toast.success('Browser notifications enabled');
            }
            void qc.invalidateQueries({ queryKey: ['push', 'subscription'] });
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {on ? 'Turn off' : 'Enable browser notifications'}
      </Button>
    </div>
  );
}
