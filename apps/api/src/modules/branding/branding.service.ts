import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_THEME,
  LOGO_VARIANTS,
  checkThemeContrast,
  themeHasBlockingIssues,
  themeInputSchema,
  type LogoAnalysis,
  type LogoVariant,
  type PublicBranding,
  type TenantBranding,
  type ThemeInput,
} from '@daliz/shared';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { ENV, type Env } from '../../config/env.js';
import { TokenService, safeEqual } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { brandingAssets, settings } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { DEFAULT_BRANDING, type BrandingSettings } from '../../database/tenant/tenant-seed.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';
import { StorageService } from '../../infra/storage.js';
import { AuditService } from '../audit/audit.service.js';
import type { EmailBranding } from '../auth/accounts.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';
import { LogoProcessor } from './logo-processor.js';

const PUBLIC_CACHE_TTL = 60;

@Injectable()
export class BrandingService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly storage: StorageService,
    private readonly processor: LogoProcessor,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnectionManager,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  private assetKey(tenantId: string, assetId: string, file: string): string {
    return StorageService.tenantKey(tenantId, 'branding', assetId, file);
  }

  /**
   * Public logo URLs are signed, so only URLs the API issued resolve — nobody can probe
   * for another tenant's uploads by guessing ids.
   */
  publicAssetUrl(tenantId: string, assetId: string, variant: LogoVariant, absolute = false): string {
    const sig = this.tokens.sign(`logo:${tenantId}:${assetId}:${variant}`).slice(0, 32);
    const path = `/api/v1/public/branding/assets/${tenantId}/${assetId}/${variant}.png?s=${sig}`;
    return absolute ? `${this.env.APP_BASE_URL}${path}` : path;
  }

  verifyAssetSignature(tenantId: string, assetId: string, variant: string, sig: string): boolean {
    return safeEqual(this.tokens.sign(`logo:${tenantId}:${assetId}:${variant}`).slice(0, 32), sig);
  }

  async readSettings(db: TenantDb): Promise<BrandingSettings> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'branding'));
    const value = (row?.value ?? {}) as Partial<BrandingSettings>;
    const theme = themeInputSchema.safeParse(value.theme);
    return {
      theme: theme.success ? theme.data : DEFAULT_THEME,
      activeLogoId: typeof value.activeLogoId === 'string' ? value.activeLogoId : null,
      loginMessage: typeof value.loginMessage === 'string' ? value.loginMessage : null,
      revision: typeof value.revision === 'number' ? value.revision : 1,
    };
  }

  private async toPublic(tenantId: string, name: string, db: TenantDb): Promise<PublicBranding> {
    const s = await this.readSettings(db);
    let logo: PublicBranding['logo'] = null;
    if (s.activeLogoId) {
      const [asset] = await db.select().from(brandingAssets).where(eq(brandingAssets.id, s.activeLogoId));
      if (asset && asset.status === 'active') {
        logo = {
          version: `${asset.id}.${s.revision}`,
          width: asset.width,
          height: asset.height,
          urls: Object.fromEntries(LOGO_VARIANTS.map((v) => [v, this.publicAssetUrl(tenantId, asset.id, v)])) as Record<LogoVariant, string>,
        };
      }
    }
    return { tenantId, name, theme: s.theme, logo, loginMessage: s.loginMessage };
  }

  static defaultBranding(): PublicBranding {
    return { tenantId: null, name: 'Daliz', theme: DEFAULT_THEME, logo: null, loginMessage: null };
  }

  /** Branding for the login page, resolved from the Host header only. */
  async publicForHost(): Promise<PublicBranding> {
    const tenantId = RequestContext.get()?.domainTenantId;
    if (!tenantId) return BrandingService.defaultBranding();
    const cacheKey = RedisKeys.tenantKey(tenantId, 'branding', 'public');
    const cached = await this.redis.getJson<PublicBranding>(cacheKey);
    if (cached) return cached;
    const tenant = await this.directory.get(tenantId);
    if (!tenant || !['active', 'suspended'].includes(tenant.status)) return BrandingService.defaultBranding();
    const db = await this.connections.get(tenantId);
    const branding = await this.toPublic(tenantId, tenant.name, db);
    await this.redis.setJson(cacheKey, branding, PUBLIC_CACHE_TTL);
    return branding;
  }

  async current(): Promise<TenantBranding> {
    const ctx = RequestContext.tenant();
    const branding = await this.toPublic(ctx.tenantId, ctx.name, ctx.db);
    const [row] = await ctx.db.select({ version: settings.version }).from(settings).where(eq(settings.key, 'branding'));
    const s = await this.readSettings(ctx.db);
    return { ...branding, logoAssetId: branding.logo ? s.activeLogoId : null, version: row?.version ?? 0, contrast: checkThemeContrast(branding.theme) };
  }

  async uploadLogo(file: Buffer, mime: string): Promise<LogoAnalysis> {
    const ctx = RequestContext.tenant();
    const processed = await this.processor.process(file, mime);
    const [asset] = await ctx.db
      .insert(brandingAssets)
      .values({
        kind: 'logo',
        status: 'uploaded',
        storagePrefix: StorageService.tenantKey(ctx.tenantId, 'branding', 'pending'),
        originalFormat: processed.format,
        originalBytes: processed.bytes,
        sha256: processed.sha256,
        width: processed.width,
        height: processed.height,
        hasTransparency: processed.hasTransparency,
        palette: processed.palette.map((c) => [...c] as [number, number, number]),
        createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning({ id: brandingAssets.id });
    const assetId = asset!.id;
    const prefix = StorageService.tenantKey(ctx.tenantId, 'branding', assetId);
    await Promise.all([
      this.storage.put(
        this.assetKey(ctx.tenantId, assetId, `original.${processed.sanitizedOriginal.ext}`),
        processed.sanitizedOriginal.body,
        processed.sanitizedOriginal.contentType,
      ),
      ...LOGO_VARIANTS.map((v) => this.storage.put(this.assetKey(ctx.tenantId, assetId, `${v}.png`), processed.variants[v], 'image/png')),
    ]);
    await ctx.db.update(brandingAssets).set({ storagePrefix: prefix }).where(eq(brandingAssets.id, assetId));
    await this.audit.tenantEvent({
      action: 'branding.logo_uploaded',
      resourceType: 'branding_asset',
      resourceId: assetId,
      metadata: { format: processed.format, bytes: processed.bytes, width: processed.width, height: processed.height },
    });
    return {
      uploadId: assetId,
      width: processed.width,
      height: processed.height,
      format: processed.format,
      aspectRatio: Math.round((processed.width / processed.height) * 100) / 100,
      hasTransparency: processed.hasTransparency,
      palette: processed.palette.map((c) => [...c] as [number, number, number]),
      dominant: [...processed.dominant] as [number, number, number],
      suggestedTheme: processed.suggestedTheme,
      warnings: processed.warnings,
      previewUrls: Object.fromEntries(LOGO_VARIANTS.map((v) => [v, `/api/v1/branding/uploads/${assetId}/${v}.png`])),
    };
  }

  /** Streams a variant of one of the current tenant's uploads (preview before saving). */
  async previewVariant(assetId: string, variant: string) {
    const ctx = RequestContext.tenant();
    if (!(LOGO_VARIANTS as readonly string[]).includes(variant)) throw Errors.notFound();
    const [asset] = await ctx.db.select({ id: brandingAssets.id }).from(brandingAssets).where(eq(brandingAssets.id, assetId));
    if (!asset) throw Errors.notFound();
    const obj = await this.storage.get(this.assetKey(ctx.tenantId, assetId, `${variant}.png`));
    if (!obj) throw Errors.notFound();
    return obj;
  }

  async publicVariant(tenantId: string, assetId: string, variant: string, sig: string) {
    if (!(LOGO_VARIANTS as readonly string[]).includes(variant)) throw Errors.notFound();
    if (!this.verifyAssetSignature(tenantId, assetId, variant, sig)) throw Errors.notFound();
    const obj = await this.storage.get(this.assetKey(tenantId, assetId, `${variant}.png`));
    if (!obj) throw Errors.notFound();
    return obj;
  }

  async save(input: { theme: ThemeInput; logoAssetId: string | null; loginMessage: string | null; version: number }) {
    const ctx = RequestContext.tenant();
    const platformSettings = await this.platformAccess.settings();
    if (!platformSettings.allowTenantSelfBranding && ctx.actor.type === 'user') {
      throw Errors.forbidden('Branding changes are managed by your provider.');
    }
    if (themeHasBlockingIssues(input.theme)) {
      const failing = checkThemeContrast(input.theme).filter((c) => c.severity === 'error' && !c.passes);
      throw Errors.validation(failing.map((c) => ({ path: `theme.${c.id}`, message: `${c.label}: contrast ${c.ratio}:1 is below ${c.required}:1` })));
    }
    const current = await this.readSettings(ctx.db);
    if (input.logoAssetId) {
      const [asset] = await ctx.db.select().from(brandingAssets).where(eq(brandingAssets.id, input.logoAssetId));
      if (!asset || asset.status === 'discarded') throw Errors.badRequest('That logo upload no longer exists. Upload it again.');
    }
    const next: BrandingSettings = {
      theme: input.theme,
      activeLogoId: input.logoAssetId,
      loginMessage: input.loginMessage,
      revision: current.revision + 1,
    };
    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(settings)
        .set({ value: { ...next }, version: input.version + 1, updatedAt: new Date(), updatedBy: ctx.actor.type === 'user' ? ctx.actor.userId : null })
        .where(and(eq(settings.key, 'branding'), eq(settings.version, input.version)))
        .returning({ key: settings.key });
      if (!updated.length) {
        if (input.version !== 0) throw Errors.versionConflict();
        await tx.insert(settings).values({ key: 'branding', value: { ...DEFAULT_BRANDING, ...next } });
      }
      if (input.logoAssetId !== current.activeLogoId) {
        if (current.activeLogoId) {
          await tx.update(brandingAssets).set({ status: 'superseded' }).where(eq(brandingAssets.id, current.activeLogoId));
        }
        if (input.logoAssetId) {
          await tx.update(brandingAssets).set({ status: 'active', activatedAt: new Date() }).where(eq(brandingAssets.id, input.logoAssetId));
        }
      }
    });
    await this.redis.del(RedisKeys.tenantKey(ctx.tenantId, 'branding', 'public'));
    await this.audit.tenantEvent({
      action: 'branding.updated',
      resourceType: 'settings',
      resourceId: 'branding',
      metadata: { theme: input.theme, logoChanged: input.logoAssetId !== current.activeLogoId, logoAssetId: input.logoAssetId },
    });
    return this.current();
  }

  /** Branding values for emails sent on behalf of a tenant. */
  async emailBranding(tenantId: string, db?: TenantDb): Promise<EmailBranding> {
    const tenant = await this.directory.get(tenantId);
    const tdb = db ?? (await this.connections.get(tenantId));
    const s = await this.readSettings(tdb);
    return {
      brandName: tenant?.name ?? 'Daliz',
      primaryColor: s.theme.primary,
      logoUrl: s.activeLogoId ? this.publicAssetUrl(tenantId, s.activeLogoId, 'email', true) : '',
    };
  }

  /** Removes uploads that were never activated (maintenance job). */
  async purgeAbandonedUploads(tenantId: string, db: TenantDb, olderThan: Date): Promise<number> {
    const stale = await db
      .select({ id: brandingAssets.id })
      .from(brandingAssets)
      .where(and(eq(brandingAssets.status, 'uploaded'), lt(brandingAssets.createdAt, olderThan)));
    for (const a of stale) await this.storage.deletePrefix(`${StorageService.tenantKey(tenantId, 'branding', a.id)}/`);
    if (stale.length) {
      await db.update(brandingAssets).set({ status: 'discarded' }).where(inArray(brandingAssets.id, stale.map((s) => s.id)));
    }
    return stale.length;
  }
}
