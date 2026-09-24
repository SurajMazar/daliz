# Authentication & authorization

## Identities

`platform.accounts` holds one identity per email: Argon2id password hash, status (`pending` until an invitation is accepted, `active`, `disabled`), email verification, and MFA state. Tenant membership lives in `platform.tenant_memberships`. Roles and permissions inside a tenant live in that tenant's database, and platform administration roles live in `platform.platform_admins`.

A Super Admin is a platform admin, not a tenant user. Being a Super Admin grants no access to tenant data (see *Support access*).

## Sessions

- `POST /auth/login` creates a session: a random 256-bit token in an HttpOnly, SameSite=Lax cookie (`__Host-daliz_sid` and `Secure` in production). The database stores only an HMAC of it.
- Sessions carry `stage` (`mfa_pending` | `active`), the selected tenant, an optional support session, and a step-up expiry. Lookups are cached in Redis for 30 s, and every change deletes the cache entry, so revocation takes effect on the next request.
- Expiry: global idle (`SESSION_IDLE_MINUTES`) and absolute (`SESSION_MAX_HOURS`) limits, plus the tenant's own `sessionIdleMinutes` / `sessionMaxHours` policy.
- The token is rotated after MFA verification and when entering support mode (session fixation), and any existing session is revoked on a new login from the same browser.
- Users can list and revoke their sessions, or sign out everywhere. Password changes revoke other sessions; resets revoke all of them.
- CSRF: every mutation needs `X-CSRF-Token`, an HMAC of the session id returned by login and `/auth/me`. Clients keep it in memory.

Desktop and PWA clients use the same session mechanism. Long-lived credentials are never stored in `localStorage`.

## Login flow

```
POST /auth/login ──► stage=active ───────────────────────────► /auth/me
        │
        └──► stage=mfa_pending ──► POST /auth/mfa/verify {code | recoveryCode}
                                     (token rotated) ──► stage=active
```

On a tenant host the session starts in that tenant, and non-members are refused. On the app host, an account with exactly one workspace lands in it; otherwise the client calls `POST /auth/tenant`.

Throttling: 10 attempts per email per 15 min (applied identically to non-existent emails), 150 per IP per 15 min, plus a coarse per-IP ceiling on auth endpoints. Failures, lockouts, new-IP sign-ins, MFA and password changes are recorded as security events, and users are emailed about new-IP sign-ins and security changes.

## MFA

- TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step drift). `POST /auth/mfa/setup` returns an otpauth URL, a QR code and the secret, stored encrypted as *pending*. `POST /auth/mfa/enable {code}` confirms it and returns 10 single-use recovery codes, shown once and stored as keyed hashes.
- Replay protection: the last accepted time step is stored and updated conditionally, so a code can't be used twice, even concurrently.
- Tenants can require MFA (`requireMfa`). Members without MFA get `MFA_ENROLLMENT_REQUIRED` on tenant routes but can still reach enrolment. An admin can't turn this on without MFA on their own account, which avoids self-lockout.
- Platform admins must use MFA when `requireMfaForPlatformAdmins` is on (the default), and can't disable it.
- Recovery: recovery codes at login, or a Super Admin's audited *reset tenant admin access* (revokes sessions, optionally clears MFA, emails a reset link).

## Step-up

Sensitive actions need a recent re-authentication: `POST /auth/step-up {password, code?}` (TOTP required when enrolled), valid for `STEP_UP_MINUTES` (10). Endpoints marked `@RequireStepUp()` currently include: disabling MFA, regenerating recovery codes, changing tenant security policy, creating or changing platform admins, platform settings, decommissioning tenants, migrating all tenants, resetting a tenant admin's access, and starting support access. Clients handle `STEP_UP_REQUIRED` by prompting and retrying.

## Authorization

- **Tenant RBAC**: permissions such as `users.read` or `finance.approve` are defined in `packages/shared/src/permissions.ts` and seeded into each tenant. Built-in roles are Owner (immutable, all permissions), Admin, Accountant, Manager, Employee and Viewer. Tenants can edit built-in roles (except Owner) and create custom roles.
- **Escalation guards**: you can only grant permissions you hold, only Owners can grant Owner, nobody edits their own roles or status, the last active Owner is protected, and role changes take effect on the next request (the permission cache is invalidated).
- **Platform RBAC**: `super_admin`, `operator`, `support` and `auditor`, with `platform.*` permissions. The last active Super Admin can't be removed, and admins can't change their own role.
- Everything is enforced in `AccessGuard` and the services. The frontend only hides what the server would refuse anyway.

## Support access (audited impersonation)

1. The operator needs `platform.support_access`, a fresh step-up, a reason (≥10 characters) and a duration (5–240 minutes).
2. A `support_sessions` row is created, the operator's session switches into it, and the session token is rotated.
3. Permissions are read-only (`*.read`), unless `allowWrite` is requested **and** the operator's role holds `platform.tenants.update`. Mutations in read-only mode return `SUPPORT_SESSION_READ_ONLY`.
4. Every tenant action is written to the tenant audit log (actor type `support`) and mirrored to the platform audit log. Start and end events are also written into the tenant's log, so its admins can see who accessed their workspace and why.
5. Sessions expire on their own. `POST /platform/support-access/end` ends one early, and logging out or switching tenant ends it too.
6. Clients show a persistent banner while `me.support` is set.
