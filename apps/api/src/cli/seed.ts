/**
 * Development seed data. Idempotent: re-running skips anything that already exists.
 *
 * Creates the platform Super Admin, two organizations, and two fully provisioned tenants
 * (each with its own database) populated with users across the built-in roles.
 * Business-module sample data is added by each module's seed as those modules land.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { PasswordService } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import { PlatformDb } from '../database/platform/platform-db.js';
import { accounts, invitations, organizations, platformAdmins, tenantMemberships, tenantProvisioningJobs, tenants } from '../database/platform/schema.js';
import { userRoles, users } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { getRoleIdsByKey } from '../database/tenant/tenant-seed.js';
import { StorageService } from '../infra/storage.js';
import { PlatformAccessService } from '../modules/platform/platform-access.service.js';
import { ProvisioningService } from '../modules/platform/provisioning.service.js';
import { cliContext } from './context.js';
import { seedSampleAccounting, seedSampleWorkspace } from './sample-data.js';

interface SeedTenant {
  org: { name: string; slug: string; contactEmail: string };
  tenant: { name: string; slug: string; timezone: string; currency: string; locale: string };
  admin: { email: string; name: string };
  users: { email: string; name: string; role: 'admin' | 'accountant' | 'manager' | 'employee' | 'viewer' }[];
}

const SEED: SeedTenant[] = [
  {
    org: { name: 'Acme Corporation', slug: 'acme-corp', contactEmail: 'it@acme.example' },
    tenant: { name: 'Acme Finance', slug: 'acme', timezone: 'America/New_York', currency: 'USD', locale: 'en-US' },
    admin: { email: 'olivia.owner@acme.example', name: 'Olivia Bennett' },
    users: [
      { email: 'adam.admin@acme.example', name: 'Adam Clarke', role: 'admin' },
      { email: 'priya.accountant@acme.example', name: 'Priya Raman', role: 'accountant' },
      { email: 'marco.manager@acme.example', name: 'Marco Silva', role: 'manager' },
      { email: 'emma.employee@acme.example', name: 'Emma Johansson', role: 'employee' },
      { email: 'victor.viewer@acme.example', name: 'Victor Okafor', role: 'viewer' },
    ],
  },
  {
    org: { name: 'Globex Holdings', slug: 'globex-holdings', contactEmail: 'ops@globex.example' },
    tenant: { name: 'Globex Operations', slug: 'globex', timezone: 'Europe/London', currency: 'GBP', locale: 'en-GB' },
    admin: { email: 'grace.owner@globex.example', name: 'Grace Whitfield' },
    users: [{ email: 'henry.accountant@globex.example', name: 'Henry Osei', role: 'accountant' }],
  },
];

const app = await cliContext();
try {
  const env = app.get<Env>(ENV);
  const platform = app.get(PlatformDb);
  const passwords = app.get(PasswordService);
  const provisioning = app.get(ProvisioningService);
  const connections = app.get(TenantConnectionManager);

  await platform.migrate();
  await app.get(PlatformAccessService).syncCatalog();
  await app.get(StorageService).ensureBucket();

  const superEmail = env.SEED_SUPERADMIN_EMAIL ?? 'superadmin@daliz.local';
  const superPassword = env.SEED_SUPERADMIN_PASSWORD;
  const userPassword = env.SEED_DEFAULT_PASSWORD;
  if (!superPassword || !userPassword) throw new Error('Set SEED_SUPERADMIN_PASSWORD and SEED_DEFAULT_PASSWORD');
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');

  const activeAccount = async (email: string, name: string, password: string) => {
    const hash = await passwords.hash(password);
    const [row] = await platform.db
      .insert(accounts)
      .values({ email, name, passwordHash: hash, status: 'active', emailVerifiedAt: new Date(), passwordChangedAt: new Date() })
      .onConflictDoUpdate({ target: accounts.email, set: { status: 'active', passwordHash: hash, emailVerifiedAt: new Date() } })
      .returning({ id: accounts.id });
    return row!.id;
  };

  // --- Platform Super Admin ----------------------------------------------------
  const superId = await activeAccount(superEmail, 'Platform Administrator', superPassword);
  await platform.db
    .insert(platformAdmins)
    .values({ accountId: superId, roleKey: 'super_admin', status: 'active' })
    .onConflictDoNothing();
  console.log(`✔ super admin ${superEmail}`);

  for (const seed of SEED) {
    // --- Organization ------------------------------------------------------------
    let [org] = await platform.db.select().from(organizations).where(eq(organizations.slug, seed.org.slug));
    if (!org) [org] = await platform.db.insert(organizations).values({ ...seed.org, createdBy: superId }).returning();

    // --- Tenant (real provisioning: its own database, role, migrations, seed) ------------
    let [tenant] = await platform.db.select().from(tenants).where(eq(tenants.slug, seed.tenant.slug));
    if (!tenant) {
      const created = await provisioning.createTenant(
        {
          organizationId: org!.id,
          name: seed.tenant.name,
          slug: seed.tenant.slug,
          plan: 'business',
          limits: { maxUsers: 50, storageQuotaMb: 10_240 },
          locale: seed.tenant.locale,
          timezone: seed.tenant.timezone,
          currency: seed.tenant.currency,
          admin: seed.admin,
        },
        { accountId: superId, name: 'Platform Administrator' },
      );
      // Run synchronously so the seed doesn't depend on a worker being up.
      await provisioning.runJob(created.jobId, true);
      [tenant] = await platform.db.select().from(tenants).where(eq(tenants.id, created.tenantId));
    } else if (tenant.status === 'provisioning' || tenant.status === 'provisioning_failed') {
      const [job] = await platform.db.select().from(tenantProvisioningJobs).where(eq(tenantProvisioningJobs.tenantId, tenant.id));
      if (job) await provisioning.runJob(job.id, true);
    }
    console.log(`✔ tenant ${seed.tenant.name} (${tenant!.slug}) — database provisioned`);

    const tenantId = tenant!.id;
    const db = await connections.get(tenantId);
    const roleIds = await getRoleIdsByKey(db, ['owner', 'admin', 'accountant', 'manager', 'employee', 'viewer']);

    // In dev the seeded people skip the invitation email and get a known password.
    const addMember = async (email: string, name: string, roleKey: string, isAdmin: boolean) => {
      const accountId = await activeAccount(email, name, userPassword);
      await platform.db
        .insert(tenantMemberships)
        .values({ accountId, tenantId, status: 'active', isTenantAdmin: isAdmin })
        .onConflictDoUpdate({ target: [tenantMemberships.accountId, tenantMemberships.tenantId], set: { status: 'active' } });
      await platform.db
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invitations.accountId, accountId), eq(invitations.tenantId, tenantId), isNull(invitations.acceptedAt)));
      await db
        .insert(users)
        .values({ accountId, email, name, status: 'active' })
        .onConflictDoUpdate({ target: users.accountId, set: { status: 'active', name } });
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
      await db.insert(userRoles).values({ userId: u!.id, roleId: roleIds.get(roleKey)! }).onConflictDoNothing();
    };

    await addMember(seed.admin.email, seed.admin.name, 'owner', true);
    for (const u of seed.users) await addMember(u.email, u.name, u.role, u.role === 'admin');
    console.log(`  ✔ ${seed.users.length + 1} users`);

    const employee = seed.users.find((u) => u.role === 'employee') ?? seed.users[0]!;
    if (await seedSampleAccounting(app, tenantId, { slug: seed.tenant.slug, name: seed.tenant.name }, { ownerEmail: seed.admin.email, employeeEmail: employee.email })) {
      console.log('  ✔ sample chart of accounts, journal entries and daybook');
    }
    if (
      await seedSampleWorkspace(app, tenantId, { slug: seed.tenant.slug, name: seed.tenant.name, timezone: seed.tenant.timezone }, {
        ownerEmail: seed.admin.email,
        memberEmails: seed.users.map((u) => u.email),
      })
    ) {
      console.log('  ✔ sample projects, tasks, events and files');
    }
  }

  console.log('\nSign in at', env.APP_BASE_URL);
  console.log(`  Super Admin: ${superEmail}`);
  console.log(`  Tenant users (password from SEED_DEFAULT_PASSWORD): ${SEED.map((s) => s.admin.email).join(', ')} …`);
} finally {
  await app.close();
}
