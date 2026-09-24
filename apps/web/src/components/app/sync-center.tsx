import { CircleAlert, RotateCcw, Trash } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/utils';
import { useConnectivity } from '@/offline/connectivity';
import { applyMineAgain, discardOp, keepServer, replayQueue, retryOp, useQueueState } from '@/offline/queue';

function describe(value: unknown): string {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
  }
  return String(value ?? '—');
}

/** Pending offline changes, failed ones (retry / discard) and conflicts (server vs mine). */
export function SyncCenter({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const state = useConnectivity();
  const queue = useQueueState();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Sync</DialogTitle>
          <DialogDescription>
            {state === 'OFFLINE' ? 'You’re offline. These changes are saved on this device and will be sent when you reconnect.' : 'Changes made while offline.'}
          </DialogDescription>
        </DialogHeader>
        {queue.conflicts.length ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">Conflicts</h3>
            {queue.conflicts.map((c) => (
              <div key={c.operationId} className="grid gap-2 rounded-lg border border-destructive/30 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <CircleAlert className="size-4 text-destructive" aria-hidden /> {c.op.label}
                </div>
                <p className="text-xs text-muted-foreground">Someone changed this task while you were offline.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md bg-muted/60 p-2">
                    <div className="text-xs font-medium text-muted-foreground">On the server</div>
                    <div className="text-xs">{c.server ? describe({ title: c.server.title, status: c.server.status }) : 'Unavailable'}</div>
                  </div>
                  <div className="rounded-md bg-primary/5 p-2">
                    <div className="text-xs font-medium text-muted-foreground">Your change</div>
                    <div className="text-xs">{describe(c.op.payload.patch)}</div>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" loading={busy === `k${c.operationId}`} onClick={() => run(`k${c.operationId}`, () => keepServer(c.operationId))}>
                    Keep server
                  </Button>
                  <Button size="sm" loading={busy === `a${c.operationId}`} onClick={() => run(`a${c.operationId}`, () => applyMineAgain(c.operationId))}>
                    Apply mine again
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {queue.errors.length ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">Couldn’t sync</h3>
            {queue.errors.map((op) => (
              <div key={op.operationId} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{op.label}</div>
                  <div className="text-xs text-destructive">{op.error}</div>
                </div>
                <Button size="sm" variant="outline" loading={busy === `r${op.operationId}`} onClick={() => run(`r${op.operationId}`, () => retryOp(op.operationId))}>
                  <RotateCcw /> Retry
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => run(`d${op.operationId}`, () => discardOp(op.operationId))}>
                  <Trash /> Discard
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Waiting to sync</h3>
          {queue.pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {queue.pending.map((op) => (
                <li key={op.operationId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{op.label}</span>
                  <Badge variant="muted">{ago(new Date(op.createdAt).toISOString())}</Badge>
                </li>
              ))}
            </ul>
          )}
          {queue.pending.length && state !== 'OFFLINE' ? (
            <Button variant="outline" size="sm" className="justify-self-start" loading={state === 'SYNCING'} onClick={() => void replayQueue()}>
              <RotateCcw /> Sync now
            </Button>
          ) : null}
        </section>
        {queue.pending.some((o) => o.type === 'daybook.create') ? (
          <Alert variant="info" title="Daybook entries recorded offline are sent as pending — they are never posted until an approver posts them online." />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
