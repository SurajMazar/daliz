import { Injectable } from '@nestjs/common';
import {
  tenantSecurityPolicySchema,
  tenantSettingsSchema,
  type AuditRow,
  type Paginated,
  type TenantSecurityPolicy,
  type TenantSettings,
} from '@daliz/shared';
import { and, count, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { auditLogs, settings } from '../../database/tenant/schema.js';
import { DEFAULT_SECURITY_POLICY } from '../../database/tenant/tenant-seed.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';

@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly directory: TenantDirectory,
  ) {}

  private async read(key: string) {
    const { db } = RequestContext.tenant();
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    return row ?? null;
  }

  async general(): Promise<TenantSettings & { version: number }> {
    const ctx = RequestContext.tenant();
    const row = await this.read('general');
    const parsed = tenantSettingsSchema.safeParse(row?.value);
    if (parsed.success) return { ...parsed.data, version: row!.version };
    const t = (await this.directory.get(ctx.tenantId))!;
    return { displayName: t.name, locale: t.locale, timezone: t.timezone, currency: t.currency, dateFormat: 'yyyy-MM-dd', weekStartsOn: 1, version: row?.version ?? 0 };
  }

  async security(): Promise<TenantSecurityPolicy & { version: number }> {
    const row = await this.read('security');
    const parsed = tenantSecurityPolicySchema.safeParse(row?.value);
    return { ...(parsed.success ? parsed.data : DEFAULT_SECURITY_POLICY), version: row?.version ?? 0 };
  }

  async updateGeneral(value: TenantSettings, version: number): Promise<void> {
    const before = await this.general();
    await this.write('general', value, version);
    await this.audit.tenantEvent({ action: 'settings.general_updated', resourceType: 'settings', resourceId: 'general', metadata: { changed: diff(before, value) } });
  }

  async updateSecurity(value: TenantSecurityPolicy, version: number): Promise<void> {
    const ctx = RequestContext.tenant();
    const before = await this.security();
    // Don't let an administrator lock themselves out: they must use MFA before requiring it.
    if (value.requireMfa && !before.requireMfa && ctx.actor.type === 'user' && !RequestContext.session().mfaEnabled) {
      throw Errors.badRequest('Turn on two-factor authentication for your own account before requiring it for everyone.');
    }
    await this.write('security', value, version);
    await this.tenantContext.invalidateSettings(ctx.tenantId, 'security');
    await this.audit.tenantEvent({ action: 'settings.security_updated', resourceType: 'settings', resourceId: 'security', metadata: { changed: diff(before, value), policy: value } });
  }

  private async write(key: string, value: Record<string, unknown>, version: number): Promise<void> {
    const ctx = RequestContext.tenant();
    const updatedBy = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    if (version === 0) {
      const inserted = await ctx.db.insert(settings).values({ key, value, updatedBy }).onConflictDoNothing().returning({ key: settings.key });
      if (inserted.length) return;
      throw Errors.versionConflict();
    }
    const updated = await ctx.db
      .update(settings)
      .set({ value, updatedBy, updatedAt: new Date(), version: version + 1 })
      .where(and(eq(settings.key, key), eq(settings.version, version)))
      .returning({ key: settings.key });
    if (!updated.length) throw Errors.versionConflict();
  }

  async auditLog(q: { page: number; pageSize: number; q?: string; action?: string; actorId?: string; outcome?: string; from?: Date; to?: Date }): Promise<Paginated<AuditRow>> {
    const { db } = RequestContext.tenant();
    const where = and(
      q.action ? ilike(auditLogs.action, `${q.action}%`) : undefined,
      q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
      q.outcome ? eq(auditLogs.outcome, q.outcome as AuditRow['outcome']) : undefined,
      q.from ? gte(auditLogs.occurredAt, q.from) : undefined,
      q.to ? lte(auditLogs.occurredAt, q.to) : undefined,
      q.q ? or(ilike(auditLogs.actorEmail, `%${q.q}%`), ilike(auditLogs.action, `%${q.q}%`)) : undefined,
    );
    const [total] = await db.select({ n: count() }).from(auditLogs).where(where);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.occurredAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        actorType: r.actorType,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        outcome: r.outcome,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        requestId: r.requestId,
        metadata: { ...r.metadata, ...(r.supportSessionId ? { supportSessionId: r.supportSessionId } : {}) },
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }
}

function diff(before: object, after: object): string[] {
  return Object.keys(after).filter(
    (k) => k !== 'version' && JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]),
  );
}
