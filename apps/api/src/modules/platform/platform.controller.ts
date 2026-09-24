import { Controller, Delete, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PLAN_KEYS,
  TENANT_STATUSES_PUBLIC,
  addTenantAdminSchema,
  addTenantDomainSchema,
  createOrganizationSchema,
  createPlatformAdminSchema,
  createTenantSchema,
  decommissionTenantSchema,
  featureFlagSchema,
  paginationQuerySchema,
  platformSettingsSchema,
  supportAccessSchema,
  tenantStatusChangeSchema,
  updateOrganizationSchema,
  updatePlatformAdminSchema,
  updateTenantSchema,
  uuidSchema,
} from '@daliz/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RATE_LIMITS } from '../../infra/redis.js';
import { RateLimit, RequirePlatform, RequireStepUp } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { RequestContext } from '../../common/request-context.js';
import { SessionService } from '../auth/session.service.js';
import { HealthService } from '../health/health.service.js';
import { PlatformAccessService } from './platform-access.service.js';
import { PlatformService } from './platform.service.js';
import { ProvisioningService } from './provisioning.service.js';

const tenantListQuery = paginationQuerySchema.extend({
  status: z.enum(TENANT_STATUSES_PUBLIC).optional(),
  organizationId: uuidSchema.optional(),
});
const auditQuery = paginationQuerySchema.extend({
  action: z.string().trim().max(100).optional(),
  tenantId: uuidSchema.optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const securityQuery = paginationQuerySchema.extend({ severity: z.enum(['info', 'warning', 'critical']).optional() });
const resetAdminSchema = z.object({ resetMfa: z.boolean().default(false) });

@ApiTags('platform')
@RateLimit(RATE_LIMITS.admin)
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly provisioning: ProvisioningService,
    private readonly access: PlatformAccessService,
    private readonly health: HealthService,
    private readonly sessions: SessionService,
  ) {}

  @RequirePlatform('platform.dashboard.read')
  @Get('dashboard')
  dashboard() {
    return this.platform.dashboard();
  }

  @RequirePlatform('platform.health.read')
  @Get('health')
  healthReport() {
    return this.health.report();
  }

  @RequirePlatform('platform.tenants.read')
  @Get('meta')
  meta() {
    return { plans: PLAN_KEYS, tenantStatuses: TENANT_STATUSES_PUBLIC };
  }

  // --- Organizations -----------------------------------------------------------

  @RequirePlatform('platform.organizations.read')
  @Get('organizations')
  organizations(@ZQuery(paginationQuerySchema) q: z.infer<typeof paginationQuerySchema>) {
    return this.platform.listOrganizations(q);
  }

  @RequirePlatform('platform.organizations.manage')
  @Post('organizations')
  createOrganization(@ZBody(createOrganizationSchema) body: z.infer<typeof createOrganizationSchema>) {
    return this.platform.createOrganization(body);
  }

  @RequirePlatform('platform.organizations.manage')
  @Patch('organizations/:id')
  async updateOrganization(@IdParam() id: string, @ZBody(updateOrganizationSchema) body: z.infer<typeof updateOrganizationSchema>) {
    await this.platform.updateOrganization(id, body);
    return { ok: true };
  }

  // --- Tenants -------------------------------------------------------------------

  @RequirePlatform('platform.tenants.read')
  @Get('tenants')
  tenants(@ZQuery(tenantListQuery) q: z.infer<typeof tenantListQuery>) {
    return this.platform.listTenants(q);
  }

  @RequirePlatform('platform.tenants.create')
  @Post('tenants')
  createTenant(@ZBody(createTenantSchema) body: z.infer<typeof createTenantSchema>) {
    const s = RequestContext.session();
    return this.provisioning.createTenant(body, { accountId: s.accountId, name: s.name });
  }

  @RequirePlatform('platform.tenants.migrate')
  @RequireStepUp()
  @Post('tenants/migrate-all')
  @HttpCode(202)
  migrateAll() {
    return this.platform.enqueueMigrateAll();
  }

  @RequirePlatform('platform.tenants.read')
  @Get('tenants/:id')
  tenant(@IdParam() id: string) {
    return this.platform.tenantDetail(id);
  }

  @RequirePlatform('platform.tenants.update')
  @Patch('tenants/:id')
  async updateTenant(@IdParam() id: string, @ZBody(updateTenantSchema) body: z.infer<typeof updateTenantSchema>) {
    await this.platform.updateTenant(id, body);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.suspend')
  @Post('tenants/:id/suspend')
  @HttpCode(200)
  async suspend(@IdParam() id: string, @ZBody(tenantStatusChangeSchema) body: z.infer<typeof tenantStatusChangeSchema>) {
    await this.provisioning.suspend(id, body.reason);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.suspend')
  @Post('tenants/:id/activate')
  @HttpCode(200)
  async activate(@IdParam() id: string, @ZBody(tenantStatusChangeSchema) body: z.infer<typeof tenantStatusChangeSchema>) {
    await this.provisioning.activate(id, body.reason);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.create')
  @Post('tenants/:id/retry-provisioning')
  @HttpCode(202)
  retry(@IdParam() id: string) {
    return this.provisioning.retryProvisioning(id, RequestContext.session().accountId);
  }

  @RequirePlatform('platform.tenants.migrate')
  @Post('tenants/:id/migrate')
  @HttpCode(202)
  migrate(@IdParam() id: string) {
    return this.platform.enqueueTenantMigration(id);
  }

  @RequirePlatform('platform.tenants.decommission')
  @RequireStepUp()
  @Post('tenants/:id/decommission')
  @HttpCode(202)
  decommission(@IdParam() id: string, @ZBody(decommissionTenantSchema) body: z.infer<typeof decommissionTenantSchema>) {
    return this.provisioning.scheduleDecommission(id, body.reason, body.confirmSlug, RequestContext.session().accountId);
  }

  @RequirePlatform('platform.tenants.decommission')
  @Post('tenants/:id/decommission/cancel')
  @HttpCode(200)
  async cancelDecommission(@IdParam() id: string) {
    await this.provisioning.cancelDecommission(id);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.update')
  @Post('tenants/:id/domains')
  addDomain(@IdParam() id: string, @ZBody(addTenantDomainSchema) body: z.infer<typeof addTenantDomainSchema>) {
    return this.platform.addDomain(id, body.domain);
  }

  @RequirePlatform('platform.tenants.update')
  @Post('tenants/:id/domains/:domainId/verify')
  @HttpCode(200)
  verifyDomain(@IdParam() id: string, @IdParam('domainId') domainId: string) {
    return this.platform.verifyDomain(id, domainId);
  }

  @RequirePlatform('platform.tenants.update')
  @Delete('tenants/:id/domains/:domainId')
  async removeDomain(@IdParam() id: string, @IdParam('domainId') domainId: string) {
    await this.platform.removeDomain(id, domainId);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.update')
  @Post('tenants/:id/admins')
  async addAdmin(@IdParam() id: string, @ZBody(addTenantAdminSchema) body: z.infer<typeof addTenantAdminSchema>) {
    await this.platform.addTenantAdmin(id, body.email, body.name);
    return { ok: true };
  }

  @RequirePlatform('platform.tenants.update')
  @RequireStepUp()
  @Post('tenants/:id/admins/:accountId/reset-access')
  @HttpCode(200)
  async resetAdmin(@IdParam() id: string, @IdParam('accountId') accountId: string, @ZBody(resetAdminSchema) body: z.infer<typeof resetAdminSchema>) {
    await this.platform.resetTenantAdminAccess(id, accountId, body.resetMfa);
    return { ok: true };
  }

  @RequirePlatform('platform.audit.read')
  @Get('tenants/:id/audit')
  tenantAudit(@IdParam() id: string, @ZQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    return this.platform.auditLog({ ...q, tenantId: id });
  }

  // --- Support access ---------------------------------------------------------------

  @RequirePlatform('platform.support_access')
  @RequireStepUp()
  @Post('tenants/:id/support-access')
  @HttpCode(200)
  async startSupport(
    @IdParam() id: string,
    @ZBody(supportAccessSchema) body: z.infer<typeof supportAccessSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const canWrite = RequestContext.require().platform?.permissions.has('platform.tenants.update') ?? false;
    const started = await this.platform.startSupportSession(id, body, canWrite);
    this.sessions.setCookie(res, started.token, started.absoluteExpiresAt);
    return { expiresAt: started.expiresAt.toISOString() };
  }

  @RequirePlatform('platform.support_access')
  @Post('support-access/end')
  @HttpCode(200)
  async endSupport() {
    await this.platform.endSupportSession();
    return { ok: true };
  }

  // --- Audit ----------------------------------------------------------------------------

  @RequirePlatform('platform.audit.read')
  @Get('audit')
  auditLog(@ZQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    return this.platform.auditLog(q);
  }

  @RequirePlatform('platform.audit.read')
  @Get('security-events')
  securityEvents(@ZQuery(securityQuery) q: z.infer<typeof securityQuery>) {
    return this.platform.securityEvents(q);
  }

  // --- Platform admins ----------------------------------------------------------------------

  @RequirePlatform('platform.admins.manage')
  @Get('admins')
  admins() {
    return this.platform.listAdmins();
  }

  @RequirePlatform('platform.admins.manage')
  @RequireStepUp()
  @Post('admins')
  async createAdmin(@ZBody(createPlatformAdminSchema) body: z.infer<typeof createPlatformAdminSchema>) {
    await this.platform.createAdmin(body.email, body.name, body.role);
    return { ok: true };
  }

  @RequirePlatform('platform.admins.manage')
  @RequireStepUp()
  @Patch('admins/:accountId')
  async updateAdmin(@IdParam('accountId') accountId: string, @ZBody(updatePlatformAdminSchema) body: z.infer<typeof updatePlatformAdminSchema>) {
    await this.platform.updateAdmin(accountId, body);
    return { ok: true };
  }

  // --- Settings & flags ---------------------------------------------------------------------

  @RequirePlatform('platform.settings.manage')
  @Get('settings')
  settings() {
    return this.access.settings();
  }

  @RequirePlatform('platform.settings.manage')
  @RequireStepUp()
  @Put('settings')
  async updateSettings(@ZBody(platformSettingsSchema) body: z.infer<typeof platformSettingsSchema>) {
    await this.platform.updateSettings(body);
    return { ok: true };
  }

  @RequirePlatform('platform.settings.manage')
  @Get('feature-flags')
  flags() {
    return this.platform.listFlags();
  }

  @RequirePlatform('platform.settings.manage')
  @Put('feature-flags')
  async upsertFlag(@ZBody(featureFlagSchema) body: z.infer<typeof featureFlagSchema>) {
    await this.platform.upsertFlag(body);
    return { ok: true };
  }
}
