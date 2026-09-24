import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env.js';
import { RedisKeys, RedisService } from '../../infra/redis.js';
import { TenantDirectory } from './tenant-directory.js';

const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * Maps a request Host to a tenant:
 *   <slug>.<TENANT_BASE_DOMAIN>  → tenant with that slug
 *   verified custom domain       → tenant owning the domain
 *   app / platform admin hosts   → no tenant
 *
 * The result constrains which tenant a session may act on for that host. It is derived
 * only from the Host header (as seen through trusted proxies), never from client payloads.
 */
@Injectable()
export class DomainResolver {
  private readonly appHost: string;
  private readonly appUrl: URL;
  private readonly baseDomain: string;
  private readonly platformHosts: Set<string>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly directory: TenantDirectory,
    private readonly redis: RedisService,
  ) {
    this.appUrl = new URL(env.APP_BASE_URL);
    this.appHost = this.appUrl.hostname.toLowerCase();
    this.baseDomain = env.TENANT_BASE_DOMAIN.toLowerCase();
    this.platformHosts = new Set(env.PLATFORM_ADMIN_HOSTS.map((h) => h.toLowerCase()));
  }

  isPlatformHost(host: string | null): boolean {
    if (this.platformHosts.size === 0) return true;
    return !!host && this.platformHosts.has(host);
  }

  async resolveTenantId(host: string): Promise<string | null> {
    if (host === this.appHost || this.platformHosts.has(host) || host === this.baseDomain) return null;
    const key = RedisKeys.platformKey('domain', host);
    const cached = await this.redis.client.get(key);
    if (cached !== null) return cached === '-' ? null : cached;

    let tenantId: string | null = null;
    const suffix = `.${this.baseDomain}`;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (SLUG.test(label)) tenantId = await this.directory.findIdBySlug(label);
    } else {
      tenantId = await this.directory.findIdByVerifiedDomain(host);
    }
    await this.redis.client.set(key, tenantId ?? '-', 'EX', 60);
    return tenantId;
  }

  async invalidateHost(host: string): Promise<void> {
    await this.redis.del(RedisKeys.platformKey('domain', host.toLowerCase()));
  }

  /**
   * Browser origins allowed to call the API with credentials: the app origin, explicitly
   * configured extras, and tenant hosts served with the app's scheme and port.
   */
  async isAllowedOrigin(origin: string, extra: readonly string[]): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.origin === this.appUrl.origin || extra.includes(url.origin)) return true;
    if (url.protocol !== this.appUrl.protocol || url.port !== this.appUrl.port) return false;
    const host = url.hostname.toLowerCase();
    if (this.platformHosts.has(host)) return true;
    return (await this.resolveTenantId(host)) !== null;
  }
}
