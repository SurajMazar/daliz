import type { ApiKeyCreated, ApiKeyRow, AuditRow, ProjectRow, TaskDetail } from '@daliz/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatformDb } from '../database/platform/platform-db.js';
import { apiKeys, tenants } from '../database/platform/schema.js';
import { RedisService } from '../infra/redis.js';
import { TenantDirectory } from '../modules/tenancy/tenant-directory.js';
import { TestEnv, type ApiClient, type TestTenant } from './harness.js';

describe('API keys', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let admin: ApiClient;
  let projectId: string;

  const bearer = (secret: string, host?: string) => {
    const call = (method: 'get' | 'post', path: string, body?: object) => {
      const r = request(t.server)[method](`/api/v1${path}`).set('Authorization', `Bearer ${secret}`);
      if (host) r.set('Host', host);
      return body ? r.send(body) : r;
    };
    return { get: (p: string) => call('get', p), post: (p: string, b: object) => call('post', p, b) };
  };

  const createKey = async (scopes: string[], name = `Integration ${Math.random().toString(36).slice(2, 7)}`) => {
    await admin.stepUp();
    const res = await admin.post<ApiKeyCreated>('/api-keys', { name, scopes, expiresInDays: 30 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data;
  };

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    admin = await t.loggedIn((await t.addUser(tenant.tenantId, 'admin')).email);
    const ws = await admin.post<{ id: string }>('/planner/workspaces', { name: 'Integrations' });
    projectId = (await admin.post<ProjectRow>('/planner/projects', { workspaceId: ws.data.id, key: 'INT', name: 'Integration project' })).data.id;
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('shows the secret once and stores only a hash', async () => {
    await admin.post('/auth/logout'); // fresh session: no step-up yet
    admin = await t.loggedIn((await t.addUser(tenant.tenantId, 'admin')).email);
    expect((await admin.post('/api-keys', { name: 'No step-up', scopes: ['planner.read'], expiresInDays: 30 })).code).toBe('STEP_UP_REQUIRED');
    const key = await createKey(['planner.read']);
    expect(key.secret).toMatch(/^dz_[0-9a-f]{12}_/);
    const listed = await admin.get<ApiKeyRow[]>('/api-keys');
    expect(JSON.stringify(listed.body)).not.toContain(key.secret);
    const [row] = await t.get(PlatformDb).db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row!.keyHash).not.toContain(key.secret.slice(20));
    expect(JSON.stringify(row)).not.toContain(key.secret);
  });

  it('enforces scopes and keeps keys to workspace data endpoints', async () => {
    const key = await createKey(['planner.read', 'planner.create']);
    const api = bearer(key.secret);
    expect((await api.get(`/planner/tasks?projectId=${projectId}`)).status).toBe(200);
    const created = await api.post('/planner/tasks', { projectId, title: 'Created by integration' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((created.body.data as TaskDetail).reporter).toBeNull();
    expect((await api.get('/users')).status).toBe(403);
    expect((await api.get('/auth/me')).status).toBe(403);
    expect((await api.get('/platform/tenants')).status).toBe(403);
    expect((await api.post('/accounting/journal-entries', { entryDate: '2026-09-01', description: 'x', lines: [] })).status).toBe(403);
    expect((await admin.post('/api-keys', { name: 'Too much', scopes: ['users.create'], expiresInDays: 30 })).status).toBe(422);

    const log = await admin.get<AuditRow[]>('/audit?action=planner.task_created');
    expect(log.data.some((e) => e.actorType === 'api_key' && e.actorEmail?.startsWith('api-key:'))).toBe(true);
  });

  it('stops working immediately when revoked, rotated or expired', async () => {
    const key = await createKey(['planner.read']);
    expect((await bearer(key.secret).get('/planner/workspaces')).status).toBe(200);
    await admin.post(`/api-keys/${key.id}/revoke`);
    expect((await bearer(key.secret).get('/planner/workspaces')).status).toBe(401);

    const second = await createKey(['planner.read']);
    await admin.stepUp();
    const rotated = await admin.post<ApiKeyCreated>(`/api-keys/${second.id}/rotate`);
    expect((await bearer(second.secret).get('/planner/workspaces')).status).toBe(401);
    expect((await bearer(rotated.data.secret).get('/planner/workspaces')).status).toBe(200);

    const third = await createKey(['planner.read']);
    await t.get(PlatformDb).db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, third.id));
    await t.get(RedisService).delPattern('platform:api_key:*');
    expect((await bearer(third.secret).get('/planner/workspaces')).status).toBe(401);
    expect((await bearer('dz_000000000000_' + 'x'.repeat(48)).get('/planner/workspaces')).status).toBe(401);
  });

  it('pins each key to its own tenant', async () => {
    const key = await createKey(['planner.read']);
    const other = await t.createTenant();
    const res = await bearer(key.secret, other.host).get('/planner/workspaces');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_DOMAIN_MISMATCH');
    const own = await bearer(key.secret, tenant.host).get('/planner/workspaces');
    expect(own.status).toBe(200);
    // Another tenant's admin can't see or revoke it.
    const otherAdmin = await t.loggedIn(other.ownerEmail);
    expect((await otherAdmin.get<ApiKeyRow[]>('/api-keys')).data.map((k) => k.id)).not.toContain(key.id);
    expect((await otherAdmin.post(`/api-keys/${key.id}/revoke`)).status).toBe(404);
  });

  it('refuses keys of suspended tenants', async () => {
    const key = await createKey(['planner.read']);
    await t.get(PlatformDb).db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenant.tenantId));
    await t.get(TenantDirectory).invalidate(tenant.tenantId);
    try {
      expect((await bearer(key.secret).get('/planner/workspaces')).status).toBe(401);
    } finally {
      await t.get(PlatformDb).db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, tenant.tenantId));
      await t.get(TenantDirectory).invalidate(tenant.tenantId);
    }
  });
});
