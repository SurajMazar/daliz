import { randomUUID } from 'node:crypto';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv } from './config/env.js';
import { AllExceptionsFilter } from './common/http/exception.filter.js';
import { RequestContextMiddleware } from './common/http/context.middleware.js';
import { IdempotencyInterceptor } from './common/http/idempotency.interceptor.js';
import { ResponseEnvelopeInterceptor } from './common/http/response.interceptor.js';
import { AccountingController, DaybookController } from './modules/accounting/accounting.controller.js';
import { AccountingService } from './modules/accounting/accounting.service.js';
import { DaybookService } from './modules/accounting/daybook.service.js';
import { ReportsService } from './modules/accounting/reports.service.js';
import { CoreModule } from './core.module.js';
import { AccessGuard } from './modules/auth/access.guard.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { BrandingController } from './modules/branding/branding.controller.js';
import { FilesController } from './modules/files/files.controller.js';
import { EventsController } from './modules/events/events.controller.js';
import { EventsService } from './modules/events/events.service.js';
import { ReminderIndex } from './modules/events/reminder-index.js';
import { RemindersService } from './modules/events/reminders.service.js';
import { NotificationSubscribers } from './modules/notifications/notification-subscribers.js';
import { NotificationsController } from './modules/notifications/notifications.controller.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { RealtimeGateway } from './modules/realtime/realtime.gateway.js';
import { RealtimePublisher } from './infra/realtime.js';
import { ApiKeysController } from './modules/integrations/api-keys.controller.js';
import { ApiKeysService } from './modules/integrations/api-keys.service.js';
import { PlannerAccessService } from './modules/planner/planner-access.js';
import { PlannerController } from './modules/planner/planner.controller.js';
import { PlannerService } from './modules/planner/planner.service.js';
import { TasksService } from './modules/planner/tasks.service.js';
import { FilesService } from './modules/files/files.service.js';
import { MalwareScanService } from './infra/malware.js';
import { BrandingService } from './modules/branding/branding.service.js';
import { LogoProcessor } from './modules/branding/logo-processor.js';
import { HealthController } from './modules/health/health.controller.js';
import { HealthService } from './modules/health/health.service.js';
import { PlatformController } from './modules/platform/platform.controller.js';
import { PlatformService } from './modules/platform/platform.service.js';
import { ProvisioningService } from './modules/platform/provisioning.service.js';
import { TenantAdminController } from './modules/tenant-admin/tenant-admin.controller.js';
import { TenantRolesService } from './modules/tenant-admin/roles.service.js';
import { TenantSettingsService } from './modules/tenant-admin/settings.service.js';
import { TenantUsersService } from './modules/tenant-admin/users.service.js';

const REQUEST_ID = /^[a-zA-Z0-9-]{8,64}$/;

export function loggerModule() {
  const env = loadEnv();
  return LoggerModule.forRoot({
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        req.headers['x-request-id'] = id;
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Never log credentials, cookies or CSRF tokens.
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          // Drop query strings: they can carry tokens.
          url: req.url.split('?')[0],
          remoteAddress: req.remoteAddress,
        }),
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } } : undefined,
    },
  });
}

@Module({
  imports: [loggerModule(), CoreModule],
  controllers: [
    AuthController,
    PlatformController,
    TenantAdminController,
    BrandingController,
    AccountingController,
    DaybookController,
    FilesController,
    PlannerController,
    EventsController,
    NotificationsController,
    ApiKeysController,
    HealthController,
  ],
  providers: [
    AuthService,
    PlatformService,
    ProvisioningService,
    TenantUsersService,
    TenantRolesService,
    TenantSettingsService,
    BrandingService,
    LogoProcessor,
    HealthService,
    AccountingService,
    ReportsService,
    DaybookService,
    FilesService,
    MalwareScanService,
    PlannerAccessService,
    PlannerService,
    TasksService,
    EventsService,
    RemindersService,
    ReminderIndex,
    NotificationsService,
    NotificationSubscribers,
    RealtimePublisher,
    RealtimeGateway,
    ApiKeysService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: the envelope wraps whatever the idempotency layer returns (fresh or replayed).
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
