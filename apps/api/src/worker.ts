import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loggerModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { CoreModule } from './core.module.js';
import { MailSender } from './infra/mail.js';
import { MalwareScanService } from './infra/malware.js';
import { FilesService } from './modules/files/files.service.js';
import { RealtimePublisher } from './infra/realtime.js';
import { EventsService } from './modules/events/events.service.js';
import { ReminderIndex } from './modules/events/reminder-index.js';
import { RemindersService } from './modules/events/reminders.service.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { PlannerAccessService } from './modules/planner/planner-access.js';
import { BrandingService } from './modules/branding/branding.service.js';
import { LogoProcessor } from './modules/branding/logo-processor.js';
import { ProvisioningService } from './modules/platform/provisioning.service.js';
import { WorkerService } from './worker/worker.service.js';

@Module({
  imports: [loggerModule(), CoreModule],
  providers: [
    WorkerService,
    ProvisioningService,
    MailSender,
    BrandingService,
    LogoProcessor,
    FilesService,
    MalwareScanService,
    NotificationsService,
    RealtimePublisher,
    RemindersService,
    EventsService,
    ReminderIndex,
    PlannerAccessService,
  ],
})
export class WorkerModule {}

async function main() {
  loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.get(WorkerService).start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
