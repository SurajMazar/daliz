import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { API_KEY_SCOPES, type ApiKeyCreated, type ApiKeyRow } from '@daliz/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { TokenService, safeEqual } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { RequestContext, type ApiKeyPrincipal } from '../../common/request-context.js';
import { PlatformDb } from '../../database/platform/platform-db.js';
import { apiKeys } from '../../database/platform/schema.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';

const KEY_FORMAT = /^dz_([0-9a-f]{12})_([A-Za-z0-9_-]{40,64})$/;
const CACHE_TTL = 60;

const status = (r: typeof apiKeys.$inferSelect): ApiKeyRow['status'] =>
  r.revokedAt ? 'revoked' : r.expiresAt && r.expiresAt < new Date() ? 'expired' : 'active';

const toRow = (r: typeof apiKeys.$inferSelect): ApiKeyRow => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
  status: status(r),
});

/**
 * Tenant API keys for integrations. Secrets look like `dz_<prefix>_<secret>`: the prefix is
 * a public lookup id, the whole token is stored only as a keyed hash and shown exactly once.
 * Keys carry explicit scopes (a subset of tenant permissions), expire, can be revoked or
 * rotated, and every use is attributable in the audit log.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly directory: TenantDirectory,
  ) {}

  private issue(): { secret: string; prefix: string; hash: string } {
    const prefix = randomBytes(6).toString('hex');
    const secret = `dz_${prefix}_${randomBytes(36).toString('base64url')}`;
    return { secret, prefix, hash: this.tokens.hash(secret, 'api_key') };
  }

  async list(): Promise<ApiKeyRow[]> {
    const { tenantId } = RequestContext.tenant();
    const rows = await this.platform.db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(desc(apiKeys.createdAt));
    return rows.map(toRow);
  }

  async create(input: { name: string; scopes: string[]; expiresInDays: number }): Promise<ApiKeyCreated> {
    const ctx = RequestContext.tenant();
    if (ctx.actor.type !== 'user') throw Errors.forbidden('API keys are created by workspace administrators.');
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s))) throw Errors.badRequest('Unsupported scope.');
    // A key can't do more than the person creating it.
    const missing = scopes.filter((s) => !ctx.permissions.has(s as never));
    if (missing.length) throw Errors.forbidden(`You can't grant scopes you don't have: ${missing.join(', ')}`);
    const { secret, prefix, hash } = this.issue();
    const [row] = await this.platform.db
      .insert(apiKeys)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        prefix,
        keyHash: hash,
        scopes,
        createdBy: ctx.actor.userId,
        expiresAt: new Date(Date.now() + input.expiresInDays * 86400_000),
      })
      .returning();
    await this.audit.tenantEvent({ action: 'integrations.api_key_created', resourceType: 'api_key', resourceId: row!.id, metadata: { name: input.name, prefix, scopes, expiresInDays: input.expiresInDays } });
    return { ...toRow(row!), secret };
  }

  private async owned(id: string) {
    const { tenantId } = RequestContext.tenant();
    const [row] = await this.platform.db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)));
    if (!row) throw Errors.notFound();
    return row;
  }

  async revoke(id: string): Promise<void> {
    const row = await this.owned(id);
    if (row.revokedAt) return;
    await this.platform.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    await this.redis.del(RedisKeys.platformKey('api_key', row.keyHash));
    await this.audit.tenantEvent({ action: 'integrations.api_key_revoked', resourceType: 'api_key', resourceId: id, metadata: { name: row.name, prefix: row.prefix } });
  }

  /** Issues a replacement secret with the same name, scopes and lifetime, and revokes the old one. */
  async rotate(id: string): Promise<ApiKeyCreated> {
    const old = await this.owned(id);
    if (status(old) !== 'active') throw Errors.conflict('Only active keys can be rotated.');
    const lifetimeDays = old.expiresAt ? Math.max(1, Math.round((old.expiresAt.getTime() - old.createdAt.getTime()) / 86400_000)) : 90;
    const created = await this.create({ name: old.name, scopes: old.scopes, expiresInDays: Math.min(365, lifetimeDays) });
    await this.revoke(id);
    await this.audit.tenantEvent({ action: 'integrations.api_key_rotated', resourceType: 'api_key', resourceId: created.id, metadata: { replaced: id } });
    return created;
  }

  /** Resolves a bearer token. Returns null for anything unknown, revoked, expired or malformed. */
  async authenticate(token: string): Promise<ApiKeyPrincipal | null> {
    const m = KEY_FORMAT.exec(token);
    if (!m) return null;
    const hash = this.tokens.hash(token, 'api_key');
    const cacheKey = RedisKeys.platformKey('api_key', hash);
    let principal = await this.redis.getJson<ApiKeyPrincipal & { expiresAt: string | null }>(cacheKey);
    if (!principal) {
      const [row] = await this.platform.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.prefix, m[1]!), isNull(apiKeys.revokedAt)))
        .limit(1);
      if (!row?.tenantId || !safeEqual(row.keyHash, hash)) return null;
      principal = { keyId: row.id, tenantId: row.tenantId, name: row.name, scopes: row.scopes, expiresAt: row.expiresAt?.toISOString() ?? null };
      await this.redis.setJson(cacheKey, principal, CACHE_TTL);
      // Throttled usage stamp (the cache hides most calls).
      await this.platform.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    }
    if (principal.expiresAt && new Date(principal.expiresAt) < new Date()) return null;
    const tenant = await this.directory.get(principal.tenantId);
    if (!tenant || tenant.status !== 'active' || tenant.organizationStatus !== 'active') return null;
    return { keyId: principal.keyId, tenantId: principal.tenantId, name: principal.name, scopes: principal.scopes };
  }
}
