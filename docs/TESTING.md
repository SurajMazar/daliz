# Testing

```bash
pnpm infra:up
pnpm test                                        # everything
pnpm --filter @daliz/api test                    # API integration/security suite
pnpm --filter @daliz/api exec vitest run src/test/tenant-isolation.test.ts
pnpm --filter @daliz/shared test                 # theme, money, recurrence unit tests
pnpm --filter @daliz/desktop test                # update signature + deep-link/workspace logic
```

## How the API suite works

`src/test/harness.ts` boots the real Nest application (same guards, filters, middleware) against real Postgres, Redis and MinIO, and talks to it over HTTP with a cookie jar and CSRF handling like a browser. Isolation from development data:

- platform database `daliz_platform_test` (created by the compose init script),
- tenant databases prefixed `daliz_test_`,
- Redis logical db 1 and bucket `daliz-test`.

Each test file starts from a clean slate: every `daliz_test_*` database and role is dropped, and the platform schema is recreated. `reset()` refuses to run unless the configuration points at test databases. Tenants are provisioned through the production provisioning code. Tokens that only exist in emails (invitations, resets) are read from the queued email jobs, exactly as a user would receive them.

## Coverage

| File | What it proves |
| --- | --- |
| `tenant-isolation.test.ts` | separate physical databases; tenant roles and the platform role can't connect to other tenants' databases; audit log is append-only at DB level; API only returns own-tenant data; tenant ids in query/body/headers are ignored; foreign ids → 404 for reads and writes; can't select a foreign tenant; Host mismatch rejected; non-members can't sign in on a tenant host; public branding by host only; tenant-prefixed cache keys |
| `auth.test.ts` | no account enumeration; uniform lockout; cookie flags; logout and logout-all; per-session revocation only for own sessions; CSRF missing/foreign token/hostile Origin; TOTP enrolment, MFA gate, token rotation, replay rejection, single-use recovery codes; step-up with TOTP; require-MFA policy and self-lockout guard; password reset (uniform response, single use, revokes sessions); invitation acceptance |
| `authorization.test.ts` | server-side permission checks; denied access audited; no granting of Owner or unheld permissions; no self-modification; last-Owner protection; built-in and Owner role protection; immediate effect of role changes; disabled users signed out; optimistic locking; user quota; validation errors without internals |
| `platform.test.ts` | platform console closed to tenant users and to lower platform roles; platform MFA policy; provisioning to a real database with invitation → Owner; idempotent job re-runs; duplicate slugs; failed step recorded without secrets, then retry resumes; suspend revokes sessions; decommission gating (step-up, suspended first, typed slug, cancel) and actual database drop; last Super Admin protected; support access (step-up, reason, read-only, role limits, visible to tenant, both audit logs, end, expiry, staff-only) |
| `accounting.test.ts` | default chart of accounts; full workflow with gapless numbering; unbalanced/foreign-account rejection; immutability and balance enforced by DB triggers (raw SQL attempts fail); reversal semantics; concurrent posting (exactly one wins) and gapless numbers under concurrency; Idempotency-Key replay/conflict; segregation of duties; lock date; consistent trial balance, P&L, balance sheet and ledger; daybook approval flow and permissions; tenant separation |
| `files.test.ts` | upload → scan → signed download (tampered signature refused), inline preview; extension/signature mismatch, executables, HTML, binary-as-text rejected; path stripped from names; EICAR quarantine (object deleted, restore refused, audited); folders (unique names, no cycles), trash/restore, purge deletes objects; versions; restricted folders hidden until shared, view vs edit, role shares; per-operation permissions; storage quota; no cross-tenant access or sharing |
| `planner.test.ts` | per-project task keys; subtasks (one level); assignment/status/comment domain events; activity log; optimistic locking; board moves between neighbours; private workspaces (members only, viewer can't edit, non-owners can't change membership); comment ownership; attachments limited to visible files; labels/filters; idempotent creates for offline sync; permissions and tenant isolation |
| `events.test.ts` | recurring series expansion, cancelled/moved single occurrences; private events; organiser-only editing (managers moderate); RSVP; invitation notifications, unread counts, preferences; email delivery tracking (sent/failed); cross-module notifications (task assignment, journal approval, no amounts in text); reminders fire once and recurring reminders roll forward; reminder ownership; WebSockets deliver only within the tenant, refuse missing cookies and foreign origins, and disconnect revoked sessions |
| `branding.test.ts` | Color Thief extracts the logo colour; suggested theme passes WCAG; variants sized without distortion; opaque Apple touch icon; hostile SVG sanitised; external SVG references rejected; signature beats declared type/extension; GIF rejected; size/dimension limits; WCAG-failing or injected themes rejected; signed public URLs (tampered or re-targeted signatures → 404); no cross-tenant preview or reuse of uploads; permission required |

## Adding tests

Use `TestEnv.start()` in `beforeAll`, `t.createTenant()`, `t.addUser(tenantId, roleKey)` and `t.loggedIn(email[, host])`. Call `t.clearRateLimits()` in `beforeEach` unless you're testing limits: all test traffic shares one IP.
