import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { ENV, type Env } from '../config/env.js';

export const QUEUES = {
  provisioning: 'provisioning',
  email: 'email',
  maintenance: 'maintenance',
  files: 'files',
  notifications: 'notifications',
  reminders: 'reminders',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Every job carries explicit tenant context (or null for platform jobs) and an id. */
export interface ProvisioningJob {
  kind: 'provision' | 'decommission' | 'migrate';
  tenantId: string;
  provisioningJobId: string;
}

export interface MigrateAllJob {
  kind: 'migrate-all';
  requestedBy: string;
}

export interface EmailJob {
  tenantId: string | null;
  to: string;
  template: EmailTemplate;
  data: Record<string, string>;
}

export type EmailTemplate =
  | 'invitation'
  | 'password_reset'
  | 'email_verification'
  | 'password_changed'
  | 'mfa_changed'
  | 'new_login'
  | 'notification';

export interface FileScanJob {
  tenantId: string;
  fileVersionId: string;
}

export interface NotificationDeliveryJob {
  tenantId: string;
  deliveryId: string;
}

export interface MaintenanceJob {
  kind: 'purge-expired';
}

export function redisConnection(env: Env) {
  return { url: env.REDIS_URL, maxRetriesPerRequest: null } as const;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redisConnection(this.env), defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Provisioning jobs use the provisioning job row id as the BullMQ job id, so enqueueing
   * the same job twice is a no-op (idempotent).
   */
  async enqueueProvisioning(job: ProvisioningJob, delayMs = 0): Promise<void> {
    await this.queue(QUEUES.provisioning).add(job.kind, job, {
      jobId: `${job.kind}-${job.provisioningJobId}`,
      attempts: 3,
      delay: delayMs,
    });
  }

  async enqueueMigrateAll(job: MigrateAllJob): Promise<string> {
    const added = await this.queue(QUEUES.provisioning).add('migrate-all', job, { attempts: 1 });
    return added.id!;
  }

  async enqueueFileScan(job: FileScanJob): Promise<void> {
    await this.queue(QUEUES.files).add('scan', job, { jobId: `scan-${job.tenantId}-${job.fileVersionId}`, attempts: 5 });
  }

  async enqueueNotificationDelivery(job: NotificationDeliveryJob): Promise<void> {
    await this.queue(QUEUES.notifications).add('deliver', job, { jobId: `delivery-${job.tenantId}-${job.deliveryId}`, attempts: 6 });
  }

  async enqueueEmail(job: EmailJob): Promise<void> {
    await this.queue(QUEUES.email).add(job.template, job, { attempts: 6 });
  }

  async counts(): Promise<{ name: string; waiting: number; active: number; failed: number; delayed: number }[]> {
    return Promise.all(
      Object.values(QUEUES).map(async (name) => {
        const c = await this.queue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
        return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0, delayed: c.delayed ?? 0 };
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }
}
