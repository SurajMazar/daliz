import type { RoleRow, TenantUserRow } from '@daliz/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv, uniqueSlug, type TestTenant } from './harness.js';

/** RBAC is enforced server-side; the UI hiding a button is never the control. */
describe('authorization', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let roles: Record<string, RoleRow>;

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    const owner = await t.loggedIn(tenant.ownerEmail);
    const list = await owner.get<RoleRow[]>('/roles');
    roles = Object.fromEntries(list.data.map((r) => [r.key ?? r.name, r]));
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('enforces permissions on every endpoint regardless of what the client shows', async () => {
    const employee = await t.loggedIn((await t.addUser(tenant.tenantId, 'employee')).email);
    expect((await employee.get('/users')).status).toBe(403);
    expect((await employee.get('/roles')).status).toBe(403);
    expect((await employee.get('/audit')).status).toBe(403);
    expect((await employee.put('/settings/general', {})).status).toBe(403);
    expect((await employee.post('/roles', { name: 'Mine', description: '', permissions: [] })).status).toBe(403);
    expect((await employee.get('/dashboard')).status).toBe(200);
  });

  it('records denied access in the tenant audit log', async () => {
    const employeeEmail = (await t.addUser(tenant.tenantId, 'employee')).email;
    const employee = await t.loggedIn(employeeEmail);
    await employee.get('/audit');
    const owner = await t.loggedIn(tenant.ownerEmail);
    const log = await owner.get<{ action: string; outcome: string; actorEmail: string }[]>('/audit?action=access.denied');
    expect(log.data.some((e) => e.actorEmail === employeeEmail && e.outcome === 'denied')).toBe(true);
  });

  it("stops non-owners from granting the Owner role or permissions they don't hold", async () => {
    const admin = await t.loggedIn((await t.addUser(tenant.tenantId, 'admin')).email);
    const email = `target-${uniqueSlug()}@example.test`;
    const ownerGrant = await admin.post('/users', { email, name: 'Target', roleIds: [roles.owner!.id] });
    expect(ownerGrant.status).toBe(403);

    // A manager-like custom role with users.* but without finance.approve can't create a role containing it.
    const limited = await t.loggedIn(tenant.ownerEmail);
    const custom = await limited.post<{ id: string }>('/roles', {
      name: `People lead ${uniqueSlug()}`,
      description: '',
      permissions: ['users.read', 'users.create', 'users.update', 'roles.read', 'roles.create', 'roles.update'],
    });
    const lead = await t.addUser(tenant.tenantId, 'viewer');
    const leadRow = await limited.get<TenantUserRow>(`/users/${lead.userId}`);
    await limited.patch(`/users/${lead.userId}`, { roleIds: [custom.data.id], version: leadRow.data.version });
    const leadClient = await t.loggedIn(lead.email);
    const escalate = await leadClient.post('/roles', { name: 'Sneaky', description: '', permissions: ['finance.approve'] });
    expect(escalate.status).toBe(403);
    // Nor can they assign an existing role that carries more than they have.
    const target = await t.addUser(tenant.tenantId, 'viewer');
    const targetRow = await leadClient.get<TenantUserRow>(`/users/${target.userId}`);
    const assign = await leadClient.patch(`/users/${target.userId}`, { roleIds: [roles.accountant!.id], version: targetRow.data.version });
    expect(assign.status).toBe(403);
    // Nor edit their own role to add more.
    const editOwn = await leadClient.put(`/roles/${custom.data.id}`, {
      name: (await limited.get<RoleRow[]>('/roles')).data.find((r) => r.id === custom.data.id)!.name,
      description: '',
      permissions: ['users.read', 'users.create', 'users.update', 'roles.read', 'roles.create', 'roles.update', 'audit.read'],
      version: 1,
    });
    expect(editOwn.status).toBe(403);
  });

  it("doesn't let anyone change their own roles or status", async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const me = await owner.me();
    const self = await owner.get<TenantUserRow>(`/users/${me.data.tenant!.userId}`);
    const res = await owner.patch(`/users/${self.data.id}`, { status: 'disabled', version: self.data.version });
    expect(res.status).toBe(403);
  });

  it('keeps at least one active Owner', async () => {
    const t2 = await t.createTenant();
    const second = await t.addUser(t2.tenantId, 'owner');
    const owner = await t.loggedIn(t2.ownerEmail);
    // Role ids are per tenant database, so look them up in t2.
    const adminRole = (await owner.get<RoleRow[]>('/roles')).data.find((r) => r.key === 'admin')!;
    const row = await owner.get<TenantUserRow>(`/users/${second.userId}`);
    // Two owners: demoting the second to Admin is fine.
    expect((await owner.patch(`/users/${second.userId}`, { roleIds: [adminRole.id], version: row.data.version })).status).toBe(200);
    // Now the original owner is the last one, and an Admin can't disable them.
    const adminClient = await t.loggedIn(second.email);
    const me = await owner.me();
    const ownerRow = await adminClient.get<TenantUserRow>(`/users/${me.data.tenant!.userId}`);
    const disable = await adminClient.patch(`/users/${ownerRow.data.id}`, { status: 'disabled', version: ownerRow.data.version });
    expect(disable.status).toBe(403);
  });

  it('protects the Owner role and built-in roles', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const ownerRole = roles.owner!;
    expect((await owner.put(`/roles/${ownerRole.id}`, { name: 'Owner', description: '', permissions: [], version: ownerRole.version })).status).toBe(403);
    expect((await owner.del(`/roles/${roles.viewer!.id}`)).status).toBe(403);
    expect((await owner.put(`/roles/${roles.viewer!.id}`, { name: 'Renamed', description: '', permissions: [], version: roles.viewer!.version })).status).toBe(400);
  });

  it('applies role changes immediately (no stale permission cache)', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const u = await t.addUser(tenant.tenantId, 'viewer');
    const client = await t.loggedIn(u.email);
    expect((await client.get('/users')).status).toBe(200); // viewer has users.read
    const row = await owner.get<TenantUserRow>(`/users/${u.userId}`);
    await owner.patch(`/users/${u.userId}`, { roleIds: [roles.employee!.id], version: row.data.version });
    expect((await client.get('/users')).status).toBe(403);
  });

  it('signs a disabled user out of the tenant at once', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const u = await t.addUser(tenant.tenantId, 'employee');
    const client = await t.loggedIn(u.email);
    expect((await client.get('/dashboard')).status).toBe(200);
    const row = await owner.get<TenantUserRow>(`/users/${u.userId}`);
    expect((await owner.patch(`/users/${u.userId}`, { status: 'disabled', version: row.data.version })).status).toBe(200);
    expect((await client.get('/dashboard')).status).toBe(401);
    expect((await t.client().login(u.email)).status).toBe(200); // account still valid…
    const again = await t.loggedIn(u.email);
    expect((await again.get('/dashboard')).status).toBe(403); // …but not in this tenant
  });

  it('detects concurrent edits with optimistic locking', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const u = await t.addUser(tenant.tenantId, 'viewer');
    const row = await owner.get<TenantUserRow>(`/users/${u.userId}`);
    expect((await owner.patch(`/users/${u.userId}`, { name: 'First edit', version: row.data.version })).status).toBe(200);
    const stale = await owner.patch(`/users/${u.userId}`, { name: 'Second edit', version: row.data.version });
    expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it("enforces the tenant's user limit", async () => {
    const small = await t.createTenant(uniqueSlug(), 2);
    const owner = await t.loggedIn(small.ownerEmail);
    const list = await owner.get<RoleRow[]>('/roles');
    const viewer = list.data.find((r) => r.key === 'viewer')!;
    expect((await owner.post('/users', { email: `a-${uniqueSlug()}@example.test`, name: 'A', roleIds: [viewer.id] })).status).toBe(201);
    const over = await owner.post('/users', { email: `b-${uniqueSlug()}@example.test`, name: 'B', roleIds: [viewer.id] });
    expect(over.code).toBe('QUOTA_EXCEEDED');
  });

  it('validates input and never leaks internals in errors', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const bad = await owner.post('/users', { email: 'not-an-email', name: '', roleIds: ['nope'] });
    expect(bad.status).toBe(422);
    expect(bad.code).toBe('VALIDATION_FAILED');
    const notUuid = await owner.get("/users/1' OR '1'='1");
    expect(notUuid.status).toBe(404);
    const raw = JSON.stringify(notUuid.body);
    expect(raw).not.toMatch(/stack|select|postgres|drizzle/i);
  });
});
