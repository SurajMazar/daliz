import type { TenantUserRow } from '@daliz/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '../infra/redis.js';
import { TestEnv, type TestTenant } from './harness.js';

/**
 * The most important property of the system: nothing crosses tenant boundaries.
 * A user from tenant A must never read or change tenant B, whatever they send.
 */
describe('tenant isolation', () => {
  let t: TestEnv;
  let a: TestTenant;
  let b: TestTenant;
  let bUserId: string;

  beforeAll(async () => {
    t = await TestEnv.start();
    a = await t.createTenant();
    b = await t.createTenant();
    bUserId = (await t.addUser(b.tenantId, 'employee')).userId;
  });
  afterAll(async () => t?.stop());

  describe('database layer', () => {
    it('gives each tenant its own physical database', async () => {
      const ca = await t.tenantDbPassword(a.tenantId);
      const cb = await t.tenantDbPassword(b.tenantId);
      expect(ca.database).not.toEqual(cb.database);
      expect(ca.user).not.toEqual(cb.user);
    });

    it("prevents a tenant's database role from connecting to another tenant's database", async () => {
      const ca = await t.tenantDbPassword(a.tenantId);
      const cb = await t.tenantDbPassword(b.tenantId);
      const attempt = new pg.Client({ host: t.env.TENANT_DB_HOST, port: t.env.TENANT_DB_PORT, user: ca.user, password: ca.password, database: cb.database });
      await expect(attempt.connect()).rejects.toThrow(/permission denied/);
      await attempt.end().catch(() => undefined);
    });

    it('prevents the platform role from connecting to tenant databases', async () => {
      const cb = await t.tenantDbPassword(b.tenantId);
      const attempt = new pg.Client({
        host: t.env.TENANT_DB_HOST,
        port: t.env.TENANT_DB_PORT,
        user: t.env.PLATFORM_DB_USER,
        password: t.env.PLATFORM_DB_PASSWORD,
        database: cb.database,
      });
      await expect(attempt.connect()).rejects.toThrow(/permission denied/);
      await attempt.end().catch(() => undefined);
    });

    it('rejects edits to the tenant audit log at the database level', async () => {
      const ca = await t.tenantDbPassword(a.tenantId);
      const c = new pg.Client({ host: t.env.TENANT_DB_HOST, port: t.env.TENANT_DB_PORT, user: ca.user, password: ca.password, database: ca.database });
      await c.connect();
      await expect(c.query('delete from tenant_audit_logs')).rejects.toThrow(/append-only/);
      await expect(c.query("update tenant_audit_logs set action = 'x'")).rejects.toThrow(/append-only/);
      await c.end();
    });
  });

  describe('API layer', () => {
    it("only ever returns the caller's own tenant data", async () => {
      const client = await t.loggedIn(a.ownerEmail);
      const res = await client.get<TenantUserRow[]>('/users');
      expect(res.status).toBe(200);
      expect(res.data.map((u) => u.email)).toEqual([a.ownerEmail]);
    });

    it('ignores tenant ids supplied in query strings, bodies and headers', async () => {
      const client = await t.loggedIn(a.ownerEmail);
      const viaQuery = await client.get<TenantUserRow[]>(`/users?tenantId=${b.tenantId}&tenant=${b.slug}`);
      expect(viaQuery.data.map((u) => u.email)).toEqual([a.ownerEmail]);
      const viaHeader = await client.get<TenantUserRow[]>('/users', { headers: { 'X-Tenant-Id': b.tenantId } });
      expect(viaHeader.data.map((u) => u.email)).toEqual([a.ownerEmail]);
      const created = await client.post<{ id: string }>('/roles', { name: 'Smuggled', description: '', permissions: [], tenantId: b.tenantId });
      expect(created.status).toBe(201);
      const bClient = await t.loggedIn(b.ownerEmail);
      const bRoles = await bClient.get<{ name: string }[]>('/roles');
      expect(bRoles.data.map((r) => r.name)).not.toContain('Smuggled');
    });

    it("returns 404 for another tenant's resource ids (no IDOR)", async () => {
      const client = await t.loggedIn(a.ownerEmail);
      const read = await client.get(`/users/${bUserId}`);
      expect(read.status).toBe(404);
      const write = await client.patch(`/users/${bUserId}`, { status: 'disabled', version: 1 });
      expect(write.status).toBe(404);
      // And tenant B's user is untouched.
      const bClient = await t.loggedIn(b.ownerEmail);
      const bUser = await bClient.get<TenantUserRow>(`/users/${bUserId}`);
      expect(bUser.data.status).toBe('active');
    });

    it('refuses to switch the session into a tenant the account does not belong to', async () => {
      const client = await t.loggedIn(a.ownerEmail);
      const res = await client.post('/auth/tenant', { tenantId: b.tenantId });
      expect(res.status).toBe(404);
      const me = await client.me();
      expect(me.data.tenant?.id).toBe(a.tenantId);
    });

    it("rejects a session used on a different tenant's domain", async () => {
      const client = await t.loggedIn(a.ownerEmail, a.host);
      expect((await client.get('/users')).status).toBe(200);
      client.host = b.host;
      const res = await client.get('/users');
      expect(res.status).toBe(403);
      expect(res.code).toBe('TENANT_DOMAIN_MISMATCH');
    });

    it("refuses sign-in on a tenant's domain for accounts that aren't members", async () => {
      const client = t.client(b.host);
      const res = await client.login(a.ownerEmail);
      expect(res.status).toBe(403);
    });

    it('serves public branding by host only', async () => {
      const onA = await t.client(a.host).get<{ tenantId: string; name: string }>('/public/branding');
      expect(onA.data.tenantId).toBe(a.tenantId);
      const onApp = await t.client('localhost').get<{ tenantId: string | null }>('/public/branding');
      expect(onApp.data.tenantId).toBeNull();
    });

    it('namespaces every tenant cache key by tenant id', async () => {
      const client = await t.loggedIn(a.ownerEmail);
      await client.get('/users');
      const keys = await t.get(RedisService).client.keys('tenant:*');
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(k).toMatch(/^tenant:[0-9a-f-]{36}:/);
    });
  });
});
