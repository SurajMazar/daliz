import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  auditQuerySchema,
  inviteUserSchema,
  paginationQuerySchema,
  roleInputSchema,
  tenantSecurityPolicySchema,
  tenantSettingsSchema,
  updateRoleSchema,
  updateTenantUserSchema,
} from '@daliz/shared';
import { z } from 'zod';
import { RequirePermissions, RequireStepUp, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { TenantRolesService } from './roles.service.js';
import { TenantSettingsService } from './settings.service.js';
import { TenantUsersService } from './users.service.js';

const userListQuery = paginationQuerySchema.extend({ status: z.enum(['invited', 'active', 'disabled']).optional() });
const generalUpdate = tenantSettingsSchema.extend({ version: z.number().int().min(0) });
const securityUpdate = tenantSecurityPolicySchema.extend({ version: z.number().int().min(0) });

/**
 * Tenant-scoped administration. The tenant is never part of the URL or body: it comes
 * from the authenticated session, and every query runs on that tenant's own database.
 */
@ApiTags('tenant')
@TenantScoped()
@Controller()
export class TenantAdminController {
  constructor(
    private readonly users: TenantUsersService,
    private readonly roles: TenantRolesService,
    private readonly settings: TenantSettingsService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.users.dashboard();
  }

  // --- Users ---------------------------------------------------------------------

  @RequirePermissions('users.read')
  @Get('users')
  listUsers(@ZQuery(userListQuery) q: z.infer<typeof userListQuery>) {
    return this.users.list(q);
  }

  /** Roles the caller can assign when inviting or editing users (no roles.read needed). */
  @Get('users/assignable-roles')
  assignableRoles() {
    return this.users.assignableRoles();
  }

  @RequirePermissions('users.read')
  @Get('users/:id')
  getUser(@IdParam() id: string) {
    return this.users.get(id);
  }

  @RequirePermissions('users.create')
  @Post('users')
  invite(@ZBody(inviteUserSchema) body: z.infer<typeof inviteUserSchema>) {
    return this.users.invite(body);
  }

  @RequirePermissions('users.update')
  @Patch('users/:id')
  updateUser(@IdParam() id: string, @ZBody(updateTenantUserSchema) body: z.infer<typeof updateTenantUserSchema>) {
    return this.users.update(id, body);
  }

  @RequirePermissions('users.create')
  @Post('users/:id/resend-invitation')
  @HttpCode(202)
  async resend(@IdParam() id: string) {
    await this.users.resendInvitation(id);
    return { ok: true };
  }

  @RequirePermissions('users.delete')
  @Delete('users/:id')
  async removeUser(@IdParam() id: string) {
    await this.users.removeInvited(id);
    return { ok: true };
  }

  // --- Roles & permissions -----------------------------------------------------------

  @RequirePermissions('roles.read')
  @Get('roles')
  listRoles() {
    return this.roles.list();
  }

  @RequirePermissions('roles.read')
  @Get('permissions')
  permissions() {
    return this.roles.catalog();
  }

  @RequirePermissions('roles.create')
  @Post('roles')
  createRole(@ZBody(roleInputSchema) body: z.infer<typeof roleInputSchema>) {
    return this.roles.create(body);
  }

  @RequirePermissions('roles.update')
  @Put('roles/:id')
  async updateRole(@IdParam() id: string, @ZBody(updateRoleSchema) body: z.infer<typeof updateRoleSchema>) {
    await this.roles.update(id, body);
    return { ok: true };
  }

  @RequirePermissions('roles.delete')
  @Delete('roles/:id')
  async deleteRole(@IdParam() id: string) {
    await this.roles.remove(id);
    return { ok: true };
  }

  // --- Settings ------------------------------------------------------------------------

  @RequirePermissions('settings.read')
  @Get('settings/general')
  general() {
    return this.settings.general();
  }

  @RequirePermissions('settings.update')
  @Put('settings/general')
  async updateGeneral(@ZBody(generalUpdate) body: z.infer<typeof generalUpdate>) {
    const { version, ...value } = body;
    await this.settings.updateGeneral(value, version);
    return this.settings.general();
  }

  @RequirePermissions('security.read')
  @Get('settings/security')
  security() {
    return this.settings.security();
  }

  @RequirePermissions('security.update')
  @RequireStepUp()
  @Put('settings/security')
  async updateSecurity(@ZBody(securityUpdate) body: z.infer<typeof securityUpdate>) {
    const { version, ...value } = body;
    await this.settings.updateSecurity(value, version);
    return this.settings.security();
  }

  // --- Audit -----------------------------------------------------------------------------

  @RequirePermissions('audit.read')
  @Get('audit')
  audit(@ZQuery(auditQuerySchema) q: z.infer<typeof auditQuerySchema>) {
    return this.settings.auditLog(q);
  }
}
