import type { MeResponse, MfaSetupResponse, RecoveryCodesResponse, SessionInfo } from '@daliz/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, TestEnv, totpFor, uniqueSlug, type TestTenant } from './harness.js';

describe('authentication', () => {
  let t: TestEnv;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  describe('login', () => {
    it('uses one generic error for unknown accounts and wrong passwords (no enumeration)', async () => {
      const unknown = await t.client().login(`nobody-${uniqueSlug()}@example.test`, 'whatever-password');
      const wrong = await t.client().login(tenant.ownerEmail, 'wrong-password-123');
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body).toMatchObject({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
      expect((wrong.body as { error: { message: string } }).error.message).toBe('Email or password is incorrect.');
    });

    it('locks out repeated attempts uniformly, whether or not the account exists', async () => {
      const real = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const fake = `ghost-${uniqueSlug()}@example.test`;
      for (const email of [real, fake]) {
        const c = t.client();
        let last;
        for (let i = 0; i < 11; i++) last = await c.login(email, 'definitely-wrong-pw');
        expect(last!.code).toBe('ACCOUNT_LOCKED');
      }
      // Even the right password is refused while locked.
      const locked = await t.client().login(real);
      expect(locked.code).toBe('ACCOUNT_LOCKED');
    });

    it('sets an HttpOnly, SameSite session cookie and never returns the session token in the body', async () => {
      const email = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const c = t.client();
      const res = await c.login(email);
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/daliz_sid=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(JSON.stringify(res.body)).not.toMatch(/daliz_sid/);
    });

    it('invalidates the session on logout', async () => {
      const email = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const c = await t.loggedIn(email);
      expect((await c.me()).status).toBe(200);
      expect((await c.post('/auth/logout')).status).toBe(200);
      expect((await c.me()).code).toBe('UNAUTHENTICATED');
    });

    it('signs out every device with logout-all', async () => {
      const email = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const laptop = await t.loggedIn(email);
      const phone = await t.loggedIn(email);
      const res = await laptop.post<{ revoked: number }>('/auth/logout-all');
      expect(res.data.revoked).toBeGreaterThanOrEqual(2);
      expect((await phone.me()).code).toBe('UNAUTHENTICATED');
    });

    it('lets a user revoke one of their own sessions but not someone else’s', async () => {
      const email = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const other = await t.loggedIn((await t.addUser(tenant.tenantId, 'viewer')).email);
      const c1 = await t.loggedIn(email);
      const c2 = await t.loggedIn(email);
      const sessions = await c1.get<SessionInfo[]>('/auth/sessions');
      const c2Session = sessions.data.find((s) => !s.current)!;
      const otherSessions = await other.get<SessionInfo[]>('/auth/sessions');
      expect((await c1.del(`/auth/sessions/${otherSessions.data[0]!.id}`)).status).toBe(404);
      expect((await c1.del(`/auth/sessions/${c2Session.id}`)).status).toBe(200);
      expect((await c2.me()).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('CSRF', () => {
    it('rejects state-changing requests without the session CSRF token', async () => {
      const c = await t.loggedIn(tenant.ownerEmail);
      const res = await c.post('/roles', { name: 'NoCsrf', description: '', permissions: [] }, { csrf: false });
      expect(res.code).toBe('CSRF_FAILED');
    });

    it('rejects a CSRF token from a different session', async () => {
      const c1 = await t.loggedIn(tenant.ownerEmail);
      const c2 = await t.loggedIn(tenant.ownerEmail);
      expect(c2.csrf).not.toEqual(c1.csrf);
      // c2's token is bound to c2's session, so it's worthless in c1's.
      c1.csrf = c2.csrf;
      const res = await c1.post('/roles', { name: 'CrossCsrf', description: '', permissions: [] });
      expect(res.code).toBe('CSRF_FAILED');
    });

    it('rejects cross-origin mutations even on public endpoints', async () => {
      const res = await t.client().post('/auth/login', { email: tenant.ownerEmail, password: PASSWORD }, { headers: { Origin: 'https://evil.example' } });
      expect(res.code).toBe('CSRF_FAILED');
    });
  });

  describe('MFA', () => {
    it('enrols TOTP, requires the second factor at login, rotates the session, and rejects replayed codes', async () => {
      const email = (await t.addUser(tenant.tenantId, 'employee')).email;
      const c = await t.loggedIn(email);
      const setup = await c.post<MfaSetupResponse>('/auth/mfa/setup');
      expect(setup.data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect((await c.post('/auth/mfa/enable', { code: '000000' })).status).toBe(400);
      const enabled = await c.post<RecoveryCodesResponse>('/auth/mfa/enable', { code: totpFor(setup.data.secret) });
      expect(enabled.data.recoveryCodes).toHaveLength(10);

      const fresh = t.client();
      const login = await fresh.login(email);
      expect(login.data.stage).toBe('mfa_pending');
      // Half-authenticated sessions can't reach anything but the MFA step.
      expect((await fresh.get('/users')).code).toBe('MFA_REQUIRED');
      const pendingCookie = String(login.headers['set-cookie']).match(/daliz_sid=([^;]+)/)![1];

      // The code used for enrolment was consumed; a later step is needed.
      const code = totpFor(setup.data.secret, 1);
      const verified = await fresh.post('/auth/mfa/verify', { code });
      expect(verified.status).toBe(200);
      const rotatedCookie = String(verified.headers['set-cookie']).match(/daliz_sid=([^;]+)/)![1];
      expect(rotatedCookie).not.toEqual(pendingCookie);
      expect((await fresh.me()).data.stage).toBe('active');

      // Replay of the same code in another login is refused.
      const attacker = t.client();
      await attacker.login(email);
      expect((await attacker.post('/auth/mfa/verify', { code })).status).toBe(400);

      // Recovery codes work exactly once.
      const recovery = enabled.data.recoveryCodes[0]!;
      const r1 = t.client();
      await r1.login(email);
      expect((await r1.post('/auth/mfa/verify', { recoveryCode: recovery })).status).toBe(200);
      const r2 = t.client();
      await r2.login(email);
      expect((await r2.post('/auth/mfa/verify', { recoveryCode: recovery })).status).toBe(400);
    });

    it("enforces a tenant's require-MFA policy without letting the admin lock themselves out", async () => {
      const adminEmail = (await t.addUser(tenant.tenantId, 'admin')).email;
      const admin = await t.loggedIn(adminEmail);
      const employeeEmail = (await t.addUser(tenant.tenantId, 'employee')).email;
      const policy = (requireMfa: boolean, version: number) => ({ requireMfa, sessionIdleMinutes: 120, sessionMaxHours: 168, lockScreenMinutes: 15, version });

      const security = await admin.get<{ version: number }>('/settings/security');
      expect(security.status, JSON.stringify(security.body)).toBe(200);
      // Changing security policy needs a fresh step-up.
      expect((await admin.put('/settings/security', policy(true, security.data.version))).code).toBe('STEP_UP_REQUIRED');
      expect((await admin.stepUp('wrong-password')).status).toBe(400);
      expect((await admin.stepUp()).status).toBe(200);
      // An admin without MFA can't require it.
      const selfLockout = await admin.put('/settings/security', policy(true, security.data.version));
      expect(selfLockout.status).toBe(400);

      const setup = await admin.post<MfaSetupResponse>('/auth/mfa/setup');
      await admin.post('/auth/mfa/enable', { code: totpFor(setup.data.secret) });
      // Step-up now also needs a TOTP code.
      expect((await admin.stepUp()).status).toBe(400);
      expect((await admin.stepUp(PASSWORD, totpFor(setup.data.secret, 1))).status).toBe(200);
      const ok = await admin.put('/settings/security', policy(true, security.data.version));
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const employee = await t.loggedIn(employeeEmail);
      expect((await employee.get('/dashboard')).code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((await employee.me()).data.mustEnrollMfa).toBe(true);
      // Enrolment itself stays reachable.
      expect((await employee.post('/auth/mfa/setup')).status).toBe(200);

      const current = await admin.get<{ version: number }>('/settings/security');
      expect((await admin.put('/settings/security', policy(false, current.data.version))).status).toBe(200);
      expect((await employee.get('/dashboard')).status).toBe(200);
    });
  });

  describe('password reset', () => {
    it('always answers the same, emails a single-use token, and revokes existing sessions', async () => {
      const email = (await t.addUser(tenant.tenantId, 'viewer')).email;
      const existing = await t.loggedIn(email);
      const unknown = await t.client().post('/auth/password/forgot', { email: `nobody-${uniqueSlug()}@example.test` });
      const known = await t.client().post('/auth/password/forgot', { email });
      expect(unknown.status).toBe(202);
      expect(known.status).toBe(202);
      expect(unknown.body).toEqual(known.body);

      const token = t.tokenFromEmail(await t.lastEmail(email, 'password_reset'));
      const weak = await t.client().post('/auth/password/reset', { token, password: 'short' });
      expect(weak.code).toBe('VALIDATION_FAILED');
      const reset = await t.client().post('/auth/password/reset', { token, password: 'A-brand-new-passphrase-42' });
      expect(reset.status).toBe(200);
      expect((await t.client().post('/auth/password/reset', { token, password: 'Another-passphrase-4242' })).code).toBe('INVALID_TOKEN');
      expect((await existing.me()).code).toBe('UNAUTHENTICATED');
      expect((await t.client().login(email, 'A-brand-new-passphrase-42')).status).toBe(200);
      expect((await t.client().login(email)).status).toBe(401);
    });
  });

  describe('invitations', () => {
    it('lets an invited person set a password and lands them in the workspace', async () => {
      const owner = await t.loggedIn(tenant.ownerEmail);
      const roles = await owner.get<{ id: string; key: string | null }[]>('/roles');
      expect(roles.status, JSON.stringify(roles.body)).toBe(200);
      const employeeRole = roles.data.find((r) => r.key === 'employee')!;
      const email = `new-${uniqueSlug()}@example.test`;
      const invited = await owner.post<{ id: string }>('/users', { email, name: 'New Person', roleIds: [employeeRole.id] });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      // Invited accounts can't sign in before accepting.
      expect((await t.client().login(email)).status).toBe(401);

      const token = t.tokenFromEmail(await t.lastEmail(email, 'invitation'));
      const invitee = t.client();
      const described = await invitee.post<{ email: string; accountExists: boolean }>('/auth/invitations/describe', { token });
      expect(described.data).toMatchObject({ email, accountExists: false });
      const accepted = await invitee.post('/auth/invitations/accept', { token, name: 'New Person', password: 'Welcome-aboard-2026!' });
      expect(accepted.status).toBe(200);
      const me = await invitee.me();
      expect(me.data.tenant?.id).toBe(tenant.tenantId);
      expect(me.data.tenant?.roles.map((r) => r.name)).toEqual(['Employee']);
      // Single use.
      expect((await t.client().post('/auth/invitations/accept', { token, name: 'X', password: 'Welcome-aboard-2026!' })).code).toBe('INVALID_TOKEN');
    });
  });

  describe('session shape', () => {
    it('resolves the tenant from the session and reports permissions', async () => {
      const c = await t.loggedIn(tenant.ownerEmail);
      const me = await c.me();
      const data: MeResponse = me.data;
      expect(data.tenant?.id).toBe(tenant.tenantId);
      expect(data.tenant?.permissions).toContain('users.create');
      expect(data.platform).toBeNull();
      expect(typeof data.csrfToken).toBe('string');
    });
  });
});
