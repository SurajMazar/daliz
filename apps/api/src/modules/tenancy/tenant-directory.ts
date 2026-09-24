import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { organizations, tenantDomains, tenants } from '../../database/platform/schema.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: (typeof tenants.$inferSelect)['status'];
  organizationId: string;
  organizationName: string;
  organizationStatus: 'active' | 'suspended';
  locale: string;
  timezone: string;
  currency: string;
  maxUsers: number;
  storageQuotaMb: number;
}

const TTL_SECONDS = 30;

/** Cached, read-only view of tenant metadata from the platform database. */
@Injectable()
export class TenantDirectory {
  constructor(
    private readonly platform: PlatformDb,
    private readonly redis: RedisService,
  ) {}

  async get(tenantId: string): Promise<TenantSummary | null> {
    const key = RedisKeys.platformKey('tenant', tenantId);
    const cached = await this.redis.getJson<TenantSummary | { missing: true }>(key);
    if (cached) return 'missing' in cached ? null : cached;
    const [row] = await this.platform.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        organizationId: tenants.organizationId,
        organizationName: organizations.name,
        organizationStatus: organizations.status,
        locale: tenants.locale,
        timezone: tenants.timezone,
        currency: tenants.currency,
        maxUsers: tenants.maxUsers,
        storageQuotaMb: tenants.storageQuotaMb,
      })
      .from(tenants)
      .innerJoin(organizations, eq(organizations.id, tenants.organizationId))
      .where(eq(tenants.id, tenantId))
      .limit(1);
    await this.redis.setJson(key, row ?? { missing: true }, TTL_SECONDS);
    return row ?? null;
  }

  async findIdBySlug(slug: string): Promise<string | null> {
    const [row] = await this.platform.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return row?.id ?? null;
  }

  async findIdByVerifiedDomain(domain: string): Promise<string | null> {
    const [row] = await this.platform.db
      .select({ id: tenantDomains.tenantId })
      .from(tenantDomains)
      .where(and(eq(tenantDomains.domain, domain), isNotNull(tenantDomains.verifiedAt)))
      .limit(1);
    return row?.id ?? null;
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(RedisKeys.platformKey('tenant', tenantId));
  }
}
