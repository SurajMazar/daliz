import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './config/env.js';
import { EncryptionService, PasswordService, TokenService } from './common/crypto.js';
import { DomainEvents } from './common/domain-events.js';
import { PlatformDb } from './database/platform/platform-db.js';
import { TenantConnectionManager } from './database/tenant/tenant-connection-manager.js';
import { TenantMigrator } from './database/tenant/tenant-migrator.js';
import { QueueService } from './infra/queue.js';
import { RateLimiter, RedisService } from './infra/redis.js';
import { StorageService } from './infra/storage.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AccountsService } from './modules/auth/accounts.service.js';
import { MfaService } from './modules/auth/mfa.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { PlatformAccessService } from './modules/platform/platform-access.service.js';
import { DomainResolver } from './modules/tenancy/domain-resolver.js';
import { TenantContextService } from './modules/tenancy/tenant-context.service.js';
import { TenantDirectory } from './modules/tenancy/tenant-directory.js';

const providers = [
  { provide: ENV, useFactory: () => loadEnv() },
  EncryptionService,
  TokenService,
  PasswordService,
  DomainEvents,
  PlatformDb,
  RedisService,
  RateLimiter,
  QueueService,
  StorageService,
  TenantConnectionManager,
  TenantMigrator,
  AuditService,
  TenantDirectory,
  DomainResolver,
  TenantContextService,
  PlatformAccessService,
  SessionService,
  AccountsService,
  MfaService,
];

/** Infrastructure and cross-cutting services shared by the API, the worker and the CLI. */
@Global()
@Module({ providers, exports: providers })
export class CoreModule {}
