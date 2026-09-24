import type { ReminderRow } from '@daliz/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BellPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { eventsKeys } from '@/features/events/api';
import { createReminder } from '@/features/events/reminders-panel';
import {
  formatDateTimeIn,
  fromLocalInput,
  startOfDayUtc,
  dayKey,
  toLocalInput,
} from '@/features/events/tz';
import { errorMessage } from '@/lib/api';
import { useIdempotencyKey, withIdempotency } from '@/lib/idempotency';
import { useTenantFormat } from '@/lib/tenant-format';

/** "Remind me" for a task: POST /reminders with taskId + remindAt (queued when offline). */
export function RemindMe({ task }: { task: { id: string; title: string } }) {
  const fmt = useTenantFormat();
  const zone = fmt.timezone;
  const qc = useQueryClient();
  const idem = useIdempotencyKey();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  const [channel, setChannel] = useState<ReminderRow['channel']>('in_app');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const presets = () => {
    const now = new Date();
    const inHour = new Date(now.getTime() + 60 * 60_000);
    const tomorrow = startOfDayUtc(dayKey(new Date(now.getTime() + 86_400_000), zone), zone);
    const tomorrow9 = new Date(tomorrow.getTime() + 9 * 3_600_000);
    return [
      { label: 'In 1 hour', value: toLocalInput(inHour, zone) },
      { label: 'Tomorrow 9:00', value: toLocalInput(tomorrow9, zone) },
    ];
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const at = fromLocalInput(when, zone);
    if (!at) return setError('Pick a date and time.');
    if (at.getTime() <= Date.now()) return setError('Pick a time in the future.');
    const body = { title: task.title, taskId: task.id, remindAt: at.toISOString(), channel };
    setSaving(true);
    try {
      const result = await withIdempotency(idem, body, (key) => createReminder(body, key));
      toast.success(result === 'queued' ? 'Reminder saved offline' : 'Reminder set', {
        description: formatDateTimeIn(at, zone, fmt.locale),
      });
      void qc.invalidateQueries({ queryKey: eventsKeys.reminders });
      setOpen(false);
      setWhen('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <BellPlus /> Remind me
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <div className="text-sm font-medium">Remind me about this task</div>
          <div className="flex flex-wrap gap-1.5">
            {presets().map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setWhen(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remind-at">When ({zone.replace(/_/g, ' ')})</Label>
            <Input
              id="remind-at"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remind-channel">Notify via</Label>
            <NativeSelect
              id="remind-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as ReminderRow['channel'])}
            >
              <option value="in_app">In-app</option>
              <option value="email">Email</option>
              <option value="both">In-app and email</option>
            </NativeSelect>
          </div>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <Button type="submit" size="sm" loading={saving}>
            Set reminder
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
