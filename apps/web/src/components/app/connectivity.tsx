import { CloudOff, LoaderCircle, RefreshCw, TriangleAlert, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getConnectivity, setConnectivity, useConnectivity } from '@/offline/connectivity';
import { replayQueue, useQueueState } from '@/offline/queue';
import { SyncCenter } from './sync-center';

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/public/branding`, { cache: 'no-store', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Drives ONLINE / OFFLINE / RECONNECTING / SYNCING / SYNC_ERROR: browser online/offline
 * events, failed requests (set by the API client) and a light ping while offline. When the
 * connection returns, queued offline changes are replayed in order.
 */
export function ConnectivityManager() {
  useEffect(() => {
    let timer: number | undefined;
    const recover = async () => {
      if (!navigator.onLine) return;
      setConnectivity('RECONNECTING');
      if (await ping()) await replayQueue();
      else setConnectivity('OFFLINE');
    };
    const onOffline = () => setConnectivity('OFFLINE');
    const onOnline = () => void recover();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    timer = window.setInterval(() => {
      if (getConnectivity() === 'OFFLINE') void recover();
    }, 8_000);
    // Replay anything left from a previous visit.
    if (navigator.onLine) void replayQueue();
    else setConnectivity('OFFLINE');
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, []);
  return null;
}

const LABEL = {
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  RECONNECTING: 'Reconnecting…',
  SYNCING: 'Syncing…',
  SYNC_ERROR: 'Sync problem',
} as const;

/** Small status pill in the top bar; opens the sync centre. Hidden while all is well. */
export function ConnectivityPill() {
  const state = useConnectivity();
  const queue = useQueueState();
  const [open, setOpen] = useState(false);
  const outstanding = queue.pending.length + queue.errors.length + queue.conflicts.length;
  if (state === 'ONLINE' && outstanding === 0) return null;
  const Icon = state === 'OFFLINE' ? CloudOff : state === 'SYNC_ERROR' || queue.conflicts.length ? TriangleAlert : state === 'ONLINE' ? Wifi : LoaderCircle;
  return (
    <>
      <Tooltip content={outstanding ? `${outstanding} change${outstanding === 1 ? '' : 's'} waiting to sync` : LABEL[state]}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className={cn(
            'h-8 gap-1.5 rounded-full px-3 text-xs',
            state === 'OFFLINE' && 'border-warning/40 text-warning',
            (state === 'SYNC_ERROR' || queue.conflicts.length > 0) && 'border-destructive/40 text-destructive',
          )}
          aria-label={`${LABEL[state]}${outstanding ? `, ${outstanding} changes waiting` : ''}. Open sync centre`}
        >
          <Icon className={cn((state === 'SYNCING' || state === 'RECONNECTING') && 'animate-spin')} />
          <span className="hidden sm:inline">{queue.conflicts.length ? 'Conflicts' : LABEL[state]}</span>
          {outstanding ? <span className="tabular-nums">· {outstanding}</span> : null}
        </Button>
      </Tooltip>
      <SyncCenter open={open} onOpenChange={setOpen} />
    </>
  );
}

export function OfflineBanner() {
  const state = useConnectivity();
  if (state !== 'OFFLINE') return null;
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-sm text-foreground print:hidden">
      <CloudOff className="size-4 text-warning" aria-hidden />
      Offline — changes will sync when you’re back online.
      <Button variant="link" size="sm" className="h-auto" onClick={() => window.dispatchEvent(new Event('online'))}>
        <RefreshCw className="size-3.5" /> Retry
      </Button>
    </div>
  );
}
