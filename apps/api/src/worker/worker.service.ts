import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { ENV, type Env } from '../config/env.js';
import { RequestContext } from '../common/request-context.js';
import { PlatformDb } from '../database/platform/platform-db.js';
import { emailTokens, invitations, securityEvents, sessions, tenantDatabases, tenantProvisioningJobs, tenants } from '../database/platform/schema.js';
import { idempotencyKeys } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { TenantMigrator } from '../database/tenant/tenant-migrator.js';
import { MailSender } from '../infra/mail.js';
import { QUEUES, QueueService, redisConnection, type EmailJob, type FileScanJob, type MigrateAllJob, type NotificationDeliveryJob, type ProvisioningJob } from '../infra/queue.js';
import { RemindersService } from '../modules/events/reminders.service.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { FilesService } from '../modules/files/files.service.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { BrandingService } from '../modules/branding/branding.service.js';
import { ProvisioningService } from '../modules/platform/provisioning.service.js';

/**
 * Background processing. Every job payload carries its tenant id explicitly; jobs never
 * infer tenant context from ambient state, and each runs inside its own context scope.
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly platform: PlatformDb,
    private readonly provisioning: ProvisioningService,
    private readonly migrator: TenantMigrator,
    private readonly mail: MailSender,
    private readonly branding: BrandingService,
    private readonly connections: TenantConnectionManager,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly reminders: RemindersService,
  ) {}

  private scoped<T>(job: Job, fn: () => Promise<T>): Promise<T> {
    return RequestContext.run({ requestId: `job:${job.queueName}:${job.id}`, ip: null, userAgent: 'daliz-worker', host: null }, fn);
  }

  async start(): Promise<void> {
    const connection = redisConnection(this.env);

    this.workers.push(
      new Worker<ProvisioningJob | MigrateAllJob>(
        QUEUES.provisioning,
        (job) =>
          this.scoped(job, async () => {
            if (job.data.kind === 'migrate-all') {
              const results = await this.migrator.migrateAll(4);
              const failed = results.filter((r) => !r.ok);
              await this.audit.platformEvent({
                action: 'tenant.migrate_all_completed',
                outcome: failed.length ? 'failure' : 'success',
                actor: { type: 'system', id: null, email: null },
                metadata: { total: results.length, failed: failed.map((f) => ({ tenantId: f.tenantId, error: f.error })) },
              });
              return { total: results.length, failed: failed.length };
            }
            const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            await this.provisioning.runJob(job.data.provisioningJobId, final);
            return { ok: true };
          }),
        { connection, concurrency: 2, lockDuration: 10 * 60_000 },
      ),
    );

    this.workers.push(
      new Worker<EmailJob>(
        QUEUES.email,
        (job) =>
          this.scoped(job, async () => {
            const data = { ...job.data.data };
            if (job.data.tenantId && !data.brandName) {
              Object.assign(data, await this.branding.emailBranding(job.data.tenantId).catch(() => ({})));
            }
            await this.mail.send(job.data.to, job.data.template, data);
          }),
        { connection, concurrency: 5, limiter: { max: 50, duration: 1000 } },
      ),
    );

    this.workers.push(
      new Worker<FileScanJob>(
        QUEUES.files,
        (job) => this.scoped(job, async () => ({ result: await this.files.scanVersion(job.data.tenantId, job.data.fileVersionId) })),
        { connection, concurrency: 3, lockDuration: 5 * 60_000 },
      ),
    );

    this.workers.push(
      new Worker<NotificationDeliveryJob>(
        QUEUES.notifications,
        (job) =>
          this.scoped(job, () =>
            this.notifications.deliver(
              job.data.tenantId,
              job.data.deliveryId,
              job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
              (to, data) => this.mail.send(to, 'notification', data),
              async () => ({ ...(await this.branding.emailBranding(job.data.tenantId).catch(() => ({}))) }),
            ),
          ),
        { connection, concurrency: 5 },
      ),
    );

    this.workers.push(
      new Worker(QUEUES.reminders, (job) => this.scoped(job, async () => ({ fired: await this.reminders.fireDue() })), { connection, concurrency: 1 }),
    );
    await this.queues.queue(QUEUES.reminders).upsertJobScheduler('reminders-tick', { every: 30_000 }, { name: 'tick', data: {} });

    this.workers.push(
      new Worker(QUEUES.maintenance, (job) => this.scoped(job, () => this.maintenance()), { connection, concurrency: 1 }),
    );
    await this.queues.queue(QUEUES.maintenance).upsertJobScheduler('purge-expired', { every: 60 * 60_000 }, { name: 'purge-expired', data: { kind: 'purge-expired' } });

    for (const w of this.workers) {
      w.on('failed', (job, err) => this.logger.error({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
      w.on('error', (err) => this.logger.error({ queue: w.name, err: err.message }, 'worker error'));
    }
    this.logger.log(`worker started: ${this.workers.map((w) => w.name).join(', ')}`);
  }

  /** Hourly housekeeping with explicit retention windows. */
  async maintenance(): Promise<Record<string, number>> {
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 86400_000);
    const deletedSessions = await this.platform.db
      .delete(sessions)
      .where(or(lt(sessions.absoluteExpiresAt, days(30)), and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, days(30)))))
      .returning({ id: sessions.id });
    const deletedTokens = await this.platform.db.delete(emailTokens).where(lt(emailTokens.expiresAt, days(30))).returning({ id: emailTokens.id });
    const deletedInvites = await this.platform.db.delete(invitations).where(lt(invitations.expiresAt, days(90))).returning({ id: invitations.id });
    const deletedEvents = await this.platform.db.delete(securityEvents).where(lt(securityEvents.createdAt, days(365))).returning({ id: securityEvents.id });
    await this.platform.db
      .update(tenantProvisioningJobs)
      .set({ status: 'failed', lastError: 'Timed out while running', updatedAt: new Date() })
      .where(and(eq(tenantProvisioningJobs.status, 'running'), lt(tenantProvisioningJobs.updatedAt, new Date(now - 60 * 60_000))));

    let idempotency = 0;
    let uploads = 0;
    let trashed = 0;
    let reindexed = 0;
    const live = await this.platform.db
      .select({ id: tenants.id })
      .from(tenants)
      .innerJoin(tenantDatabases, eq(tenantDatabases.tenantId, tenants.id))
      .where(and(inArray(tenants.status, ['active', 'suspended']), eq(tenantDatabases.status, 'ready')));
    for (const t of live) {
      try {
        const db = await this.connections.get(t.id);
        const rows = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date())).returning({ key: idempotencyKeys.key });
        idempotency += rows.length;
        uploads += await this.branding.purgeAbandonedUploads(t.id, db, days(1));
        trashed += await this.files.purgeExpiredTrash(t.id, db, days(30));
        reindexed += await this.reminders.reindexTenant(t.id, new Date(now + 2 * 3600_000));
      } catch (err) {
        this.logger.warn({ tenantId: t.id, err: (err as Error).message }, 'tenant maintenance failed');
      }
    }
    const summary = {
      sessions: deletedSessions.length,
      emailTokens: deletedTokens.length,
      invitations: deletedInvites.length,
      securityEvents: deletedEvents.length,
      idempotencyKeys: idempotency,
      abandonedUploads: uploads,
      expiredTrash: trashed,
      remindersIndexed: reindexed,
    };
    this.logger.log(summary, 'maintenance complete');
    return summary;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
  }
}
