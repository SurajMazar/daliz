import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReminderRow } from '@daliz/shared';
import { Bell, BellOff, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useTenantFormat } from '@/lib/tenant-format';
import { isNetworkError } from '@/offline/cache';
import { isOffline } from '@/offline/connectivity';
import { enqueue } from '@/offline/queue';
import { eventsKeys, useReminders } from './api';
import { formatDateTimeIn, fromLocalInput, toLocalInput } from './tz';

type Channel = ReminderRow['channel'];

/** Creates a reminder, or queues it when offline (reminders are offline-safe). */
export async function createReminder(body: { title: string; notes?: string; remindAt: string; channel: Channel; taskId?: string | null }, key: string): Promise<'sent' | 'queued'> {
  const run = async () => {
    await api.post<ReminderRow>('/reminders', body, { idempotencyKey: key });
    return 'sent' as const;
  };
  if (isOffline()) {
    await enqueue('reminder.create', { body }, `Reminder: ${body.title}`);
    return 'queued';
  }
  try {
    return await run();
  } catch (e) {
    if (isNetworkError(e)) {
      await enqueue('reminder.create', { body }, `Reminder: ${body.title}`);
      return 'queued';
    }
    throw e;
  }
}

export function RemindersPanel() {
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const reminders = useReminders();
  const idem = useIdempotencyKey();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000), fmt.timezone));
  const [notes, setNotes] = useState('');
  const [channel, setChannel] = useState<Channel>('in_app');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dismiss = useMutation({
    mutationFn: (id: string) => api.delete(`/reminders/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: eventsKeys.reminders }),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const at = fromLocalInput(when, fmt.timezone);
    if (!title.trim()) return setError('Give the reminder a title.');
    if (!at) return setError('Choose a date and time.');
    setSaving(true);
    const body = { title: title.trim(), notes, remindAt: at.toISOString(), channel };
    try {
      const result = await withIdempotency(idem, body, (key) => createReminder(body, key));
      toast.success(result === 'queued' ? 'Reminder saved offline — it will sync when you’re back online' : 'Reminder set');
      setTitle('');
      setNotes('');
      void qc.invalidateQueries({ queryKey: eventsKeys.reminders });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const active = (reminders.data ?? []).filter((r) => r.status === 'scheduled');
  const past = (reminders.data ?? []).filter((r) => r.status !== 'scheduled').slice(0, 20);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card>
        <CardHeader>
          <CardTitle>New reminder</CardTitle>
          <CardDescription>Times are in {fmt.timezone.replace(/_/g, ' ')}.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4" noValidate>
            {error ? <Alert variant="destructive" title={error} /> : null}
            <FormField label="Title" required>
              <Input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call the bank" />
            </FormField>
            <FormField label="Remind me at" required>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </FormField>
            <FormField label="Notify via">
              <NativeSelect value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                <option value="in_app">In the app</option>
                <option value="email">Email</option>
                <option value="both">App and email</option>
              </NativeSelect>
            </FormField>
            <FormField label="Notes">
              <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
            <Button type="submit" loading={saving}>
              <Plus /> Add reminder
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader className="pb-4 sm:pb-4">
          <CardTitle>My reminders</CardTitle>
        </CardHeader>
        {reminders.isPending ? (
          <SkeletonRows rows={4} cols={2} />
        ) : reminders.isError ? (
          <ErrorState error={reminders.error} onRetry={() => void reminders.refetch()} />
        ) : active.length === 0 && past.length === 0 ? (
          <EmptyState icon={Bell} title="No reminders" />
        ) : (
          <ul className="divide-y border-t">
            {[...active, ...past].map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3 sm:px-6">
                <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {r.title}
                    {r.status !== 'scheduled' ? <Badge variant="muted">{r.status === 'sent' ? 'Sent' : r.status === 'dismissed' ? 'Dismissed' : 'Cancelled'}</Badge> : null}
                    {r.channel !== 'in_app' ? <Badge variant="outline">{r.channel === 'email' ? 'Email' : 'App + email'}</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTimeIn(r.remindAt, fmt.timezone, fmt.locale)}
                    {r.minutesBefore !== null ? ` · ${r.minutesBefore} min before` : ''}
                  </div>
                  {r.notes ? <p className="mt-1 text-sm text-muted-foreground">{r.notes}</p> : null}
                  <div className="mt-1 flex gap-3 text-xs">
                    {r.eventId ? (
                      <Link className="text-primary hover:underline" to={`/events?event=${r.eventId}`}>
                        Open event
                      </Link>
                    ) : null}
                    {r.taskId ? (
                      <Link className="text-primary hover:underline" to={`/planner?task=${r.taskId}`}>
                        Open task
                      </Link>
                    ) : null}
                  </div>
                </div>
                {r.status === 'scheduled' ? (
                  <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(r.id)} loading={dismiss.isPending && dismiss.variables === r.id}>
                    <BellOff /> Dismiss
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
