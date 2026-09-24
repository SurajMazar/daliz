import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../config/env.js';
import { CoreModule } from '../core.module.js';
import { AccountingService } from '../modules/accounting/accounting.service.js';
import { DaybookService } from '../modules/accounting/daybook.service.js';
import { ProvisioningService } from '../modules/platform/provisioning.service.js';
import { MalwareScanService } from '../infra/malware.js';
import { RealtimePublisher } from '../infra/realtime.js';
import { EventsService } from '../modules/events/events.service.js';
import { ReminderIndex } from '../modules/events/reminder-index.js';
import { FilesService } from '../modules/files/files.service.js';
import { PlannerAccessService } from '../modules/planner/planner-access.js';
import { PlannerService } from '../modules/planner/planner.service.js';
import { TasksService } from '../modules/planner/tasks.service.js';

@Module({
  imports: [CoreModule],
  providers: [
    ProvisioningService,
    AccountingService,
    DaybookService,
    FilesService,
    MalwareScanService,
    PlannerAccessService,
    PlannerService,
    TasksService,
    EventsService,
    ReminderIndex,
    RealtimePublisher,
  ],
})
class CliModule {}

export async function cliContext(): Promise<INestApplicationContext> {
  loadEnv();
  return NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
}
