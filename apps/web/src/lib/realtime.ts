/**
 * Realtime channel (socket.io over WebSocket, same origin, session cookie). One connection
 * per tenant session; torn down on sign-out and workspace switch. Reconnects with backoff
 * and stays quiet about it.
 */
import type { NotificationRow, RealtimeMessage } from '@daliz/shared';
import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { navigateTo } from './navigation';
import { queryClient } from './query-client';
import { refreshMe } from './session';

/** Server topics → query-key prefixes to invalidate. */
const TOPIC_KEYS: Record<string, readonly unknown[][]> = {
  planner: [['planner']],
  events: [['events']],
  reminders: [['events', 'reminders']],
  files: [['files']],
  accounting: [['accounting']],
  daybook: [['daybook'], ['accounting']],
  notifications: [['notifications']],
  users: [
    ['tenant', 'users'],
    ['tenant', 'dashboard'],
  ],
  roles: [['tenant', 'roles']],
  branding: [['branding'], ['public-branding']],
  settings: [['tenant', 'settings'], ['me']],
  dashboard: [['tenant', 'dashboard']],
};

function onNotification(n: NotificationRow, unread: number) {
  queryClient.setQueryData(['notifications', 'unread'], { unread });
  void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
  const link = n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : null;
  toast(n.title, {
    description: n.body || undefined,
    action: link ? { label: 'Open', onClick: () => navigateTo(link) } : undefined,
  });
}

export function handleRealtimeMessage(msg: RealtimeMessage): void {
  switch (msg.type) {
    case 'notification':
      onNotification(msg.notification, msg.unread);
      break;
    case 'invalidate':
      for (const topic of msg.topics) {
        const prefixes = TOPIC_KEYS[topic] ?? [[topic]];
        for (const queryKey of prefixes) void queryClient.invalidateQueries({ queryKey });
      }
      break;
    case 'session_ended':
      // /auth/me decides: signed out → login; tenant lost → workspace picker.
      void refreshMe();
      break;
  }
}

/** Connects while `sessionKey` is set (tenant id + account id); reconnects on change. */
export function useRealtime(sessionKey: string | null): void {
  useEffect(() => {
    if (!sessionKey) return;
    let socket: Socket | null = null;
    // Deferred a tick so a mount/unmount pair (StrictMode, fast workspace switches) never
    // opens a socket only to close it mid-handshake.
    const timer = window.setTimeout(() => {
      socket = io(window.location.origin, {
        path: '/api/v1/realtime',
        transports: ['websocket'],
        withCredentials: true,
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
        randomizationFactor: 0.5,
      });
      socket.on('message', (msg: RealtimeMessage) => handleRealtimeMessage(msg));
      // After a reconnect, anything missed while disconnected is refetched quietly.
      socket.io.on('reconnect', () => {
        for (const queryKey of [['notifications'], ['planner'], ['events']])
          void queryClient.invalidateQueries({ queryKey });
      });
    }, 50);
    return () => {
      window.clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.io.removeAllListeners();
      socket?.disconnect();
      socket = null;
    };
  }, [sessionKey]);
}
