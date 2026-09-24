import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../common/request-context.js';
import { PlatformDb, type PlatformDatabase } from '../../database/platform/platform-db.js';
import { platformAuditLogs, securityEvents } from '../../database/platform/schema.js';
import { auditLogs } from '../../database/tenant/schema.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';

type Outcome = 'success' | 'failure' | 'denied';
type ActorType = 'user' | 'platform_admin' | 'support' | 'system' | 'anonymous' | 'api_key';

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  outcome?: Outcome;
  metadata?: Record<string, unknown>;
}

export interface PlatformAuditEntry extends AuditEntry {
  tenantId?: string | null;
  actor?: { type: ActorType; id: string | null; email: string | null };
}

export type SecuritySeverity = 'info' | 'warning' | 'critical';

/** Keys that must never be written into audit metadata, even by mistake. */
const REDACT = /pass(word)?|secret|token|code|cookie|authorization|otp|key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/**
 * Writes audit events. Platform events go to the platform database; tenant events go to
 * the tenant's own database. Request metadata (IP, user agent, request id, actor) comes from
 * the request context, never from callers.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly platform: PlatformDb) {}

  private requestMeta() {
    const ctx = RequestContext.get();
    return {
      ipAddress: ctx?.ip ?? null,
      userAgent: ctx?.userAgent?.slice(0, 400) ?? null,
      requestId: ctx?.requestId ?? null,
    };
  }

  private defaultPlatformActor(): { type: ActorType; id: string | null; email: string | null } {
    const apiKey = RequestContext.get()?.apiKey;
    if (apiKey) return { type: 'api_key', id: apiKey.keyId, email: `api-key:${apiKey.name}` };
    const ctx = RequestContext.get();
    if (ctx?.session) {
      return {
        type: ctx.platform ? 'platform_admin' : 'user',
        id: ctx.session.accountId,
        email: ctx.session.email,
      };
    }
    return { type: ctx ? 'anonymous' : 'system', id: null, email: null };
  }

  async platformEvent(entry: PlatformAuditEntry, tx?: PlatformDatabase): Promise<void> {
    const actor = entry.actor ?? this.defaultPlatformActor();
    await (tx ?? this.platform.db).insert(platformAuditLogs).values({
      actorType: actor.type,
      actorId: actor.id,
      actorEmail: actor.email,
      tenantId: entry.tenantId ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      outcome: entry.outcome ?? 'success',
      metadata: redact(entry.metadata ?? {}) as Record<string, unknown>,
      ...this.requestMeta(),
    });
  }

  /**
   * Records an event in the current tenant's audit log. Support-session activity is also
   * mirrored into the platform log so it is visible to both sides.
   */
  async tenantEvent(entry: AuditEntry, db?: TenantDb): Promise<void> {
    const tenant = RequestContext.tenant();
    const actor = tenant.actor;
    const target = db ?? tenant.db;
    const base = {
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      outcome: entry.outcome ?? 'success',
      metadata: redact(entry.metadata ?? {}) as Record<string, unknown>,
      ...this.requestMeta(),
    };
    await target.insert(auditLogs).values({
      ...base,
      actorType: actor.type,
      actorId: actor.type === 'user' ? actor.userId : actor.type === 'support' ? actor.accountId : actor.keyId,
      actorEmail: actor.type === 'api_key' ? `api-key:${actor.name}` : actor.email,
      supportSessionId: actor.type === 'support' ? actor.supportSessionId : null,
    });
    if (actor.type === 'support') {
      await this.platformEvent({
        ...entry,
        action: `support.${entry.action}`,
        tenantId: tenant.tenantId,
        actor: { type: 'support', id: actor.accountId, email: actor.email },
        metadata: { ...entry.metadata, supportSessionId: actor.supportSessionId },
      });
    }
  }

  /** Writes to an explicit tenant database outside a request (provisioning, jobs). */
  async tenantSystemEvent(db: TenantDb, entry: AuditEntry & { actor?: { type: ActorType; id: string | null; email: string | null } }): Promise<void> {
    const actor = entry.actor ?? { type: 'system' as const, id: null, email: null };
    await db.insert(auditLogs).values({
      actorType: actor.type,
      actorId: actor.id,
      actorEmail: actor.email,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      outcome: entry.outcome ?? 'success',
      metadata: redact(entry.metadata ?? {}) as Record<string, unknown>,
      ...this.requestMeta(),
    });
  }

  async securityEvent(event: {
    type: string;
    severity: SecuritySeverity;
    accountId?: string | null;
    email?: string | null;
    tenantId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const meta = this.requestMeta();
    try {
      await this.platform.db.insert(securityEvents).values({
        type: event.type,
        severity: event.severity,
        accountId: event.accountId ?? null,
        email: event.email ?? null,
        tenantId: event.tenantId ?? null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: redact(event.metadata ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      // Security telemetry must not break authentication flows; log loudly instead.
      this.logger.error({ err: (err as Error).message, type: event.type }, 'failed to record security event');
    }
  }
}
