import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process domain events, published after a change commits. Every event names its tenant
 * explicitly so subscribers (notifications, real-time fan-out) never guess the tenant.
 */
/** An event change attendees are told about; timezone/allDay let the text match the event's own clock. */
export interface EventChange {
  tenantId: string;
  eventId: string;
  title: string;
  startsAt: string;
  timezone: string;
  allDay: boolean;
  attendeeIds: string[];
  actorId: string | null;
}

export interface DomainEventMap {
  'task.assigned': { tenantId: string; taskId: string; taskKey: string; title: string; assigneeId: string; actorId: string | null };
  'task.status_changed': { tenantId: string; taskId: string; taskKey: string; title: string; from: string; to: string; actorId: string | null; watcherIds: string[] };
  'task.commented': { tenantId: string; taskId: string; taskKey: string; title: string; commentId: string; actorId: string | null; watcherIds: string[] };
  'event.invited': EventChange;
  'event.updated': EventChange;
  'event.cancelled': EventChange;
  'reminder.due': { tenantId: string; reminderId: string; userId: string; title: string; eventId: string | null; dueAt: string };
  'accounting.entry_submitted': { tenantId: string; entryId: string; description: string; actorId: string | null };
  'realtime.invalidate': { tenantId: string; userIds: string[] | 'all'; topics: string[] };
}

type Listener<K extends keyof DomainEventMap> = (payload: DomainEventMap[K]) => void | Promise<void>;

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter({ captureRejections: true });
  private readonly logger = new Logger(DomainEvents.name);

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof DomainEventMap>(event: K, listener: Listener<K>): void {
    this.emitter.on(event, (payload: DomainEventMap[K]) => {
      Promise.resolve(listener(payload)).catch((err: Error) =>
        this.logger.error({ event, tenantId: (payload as { tenantId?: string }).tenantId, err: err.message }, 'domain event handler failed'),
      );
    });
  }
}
