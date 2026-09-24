# Security

Principles: zero trust toward clients (web, PWA and desktop alike), authorization on the server for every request, tenant isolation that holds even when application code is wrong, and least privilege for every credential.

## Threats and controls

| Threat | Controls | Tests |
| --- | --- | --- |
| Cross-tenant access | Database-per-tenant with `CONNECT` revoked from `PUBLIC`; tenant resolved only from the session; Host cross-check; tenant-prefixed cache/storage keys; tenant id in every job | `tenant-isolation.test.ts` |
| IDOR | All lookups run inside the caller's tenant database, so foreign ids simply don't exist (404); session revocation checks ownership | isolation, auth |
| Broken access control | Global `AccessGuard`; `@RequirePermissions` / `@RequirePlatform` on every sensitive route; denials audited | `authorization.test.ts`, platform |
| Privilege escalation | Can't grant permissions you lack; only Owners grant Owner; can't edit own roles/status; Owner role immutable; last active Owner and last Super Admin protected | authorization, platform |
| SQL injection | Drizzle parameterised queries; the few DDL statements use `escapeIdentifier`/`escapeLiteral` on server-generated, regex-validated identifiers | authorization (malformed ids) |
| XSS | React escaping in the client; API serves JSON only with `Content-Security-Policy: default-src 'none'`; emails HTML-escape every value; SVG logos sanitised with DOMPurify and rasterised; image responses carry `CSP: sandbox` and `nosniff` | branding |
| CSRF | SameSite=Lax HttpOnly cookie **plus** a session-bound CSRF token (HMAC of the session id) required on every mutation; Origin allow-list on all mutations including public ones | auth |
| Session fixation / hijacking | Opaque 256-bit tokens, stored as keyed hashes; new token on login, after MFA and on entering support mode; idle and absolute expiry (per tenant policy too); `__Host-` cookie prefix and `Secure` in production; revocation is immediate (Redis cache invalidated) | auth |
| Brute force / credential stuffing | Per-account (keyed by email, whether or not it exists) and per-IP limits in Redis; progressive security events; step-up and MFA attempts limited | auth |
| Account enumeration | Identical responses for unknown email vs wrong password, for password-reset requests, and dummy Argon2 verification to equalise timing | auth |
| MFA replay | TOTP time-step recorded and compared atomically; recovery codes single-use via conditional update | auth |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options` | — |
| Open redirects | The API issues no redirects; links in emails are built from `APP_BASE_URL` only | — |
| Path traversal | Storage keys built from validated segments; tenant prefix mandatory; deletes refused outside known prefixes | branding |
| Malicious uploads | Size limit enforced by multer; file signature detection (`file-type`) must match declared type; SVG sanitised; pixel-count limit against decompression bombs; images re-encoded (metadata stripped) | branding |
| Oversized payloads / DoS | 256 kB JSON limit; per-route upload limits; statement timeouts; rate limits | branding |
| Secrets exposure | Secrets only from environment/secret manager; production refuses to boot with dev secrets; logs redact cookies, auth and CSRF headers and query strings; errors never include stack traces | — |
| Audit tampering | Append-only audit tables enforced by database triggers (UPDATE/DELETE/TRUNCATE rejected); sensitive keys redacted from metadata | isolation |
| Insider access to tenant data | Platform admins cannot read tenant data by default; support access requires permission, step-up, reason, time limit, is read-only unless the role allows write, shows a banner, logs every action to both audit logs, and is visible to the tenant | platform |

## Credentials and least privilege

| Credential | Can do | Cannot do |
| --- | --- | --- |
| `daliz_platform` role | Owns the platform database | Connect to any tenant database |
| `daliz_provisioner` role | `CREATEDB`, `CREATEROLE`; used only by the worker for lifecycle steps | Superuser; it holds `SET` but not `INHERIT` on tenant roles, so it never silently carries tenant privileges |
| Tenant role | Owns exactly one tenant database | Connect elsewhere |
| Postgres superuser | Compose bootstrap only | Never used by the application |

## Secrets

- Local development: `.env` (git-ignored; `.env.example` documents every variable).
- Production: inject from a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault, Doppler) as environment variables; never bake secrets into images. The API refuses to start in production if any value still carries the development markers, or if `APP_BASE_URL` isn't HTTPS.
- `ENCRYPTION_KEYS` is a keyring (`id:base64key,…`): the first key encrypts, all decrypt. Rotate by prepending a new key, then re-encrypt (tenant DB passwords and TOTP secrets carry their key id).
- The frontend and desktop clients never receive secrets.

## Encryption

- In transit: terminate TLS at the reverse proxy; use TLS to Postgres/Redis/object storage in production (`sslmode=require`, `rediss://`).
- At rest: tenant database passwords and TOTP secrets are AES-256-GCM encrypted by the application; enable storage-level encryption for Postgres volumes, backups and the object store (SSE-S3/KMS).
- Passwords: Argon2id (m=19 MiB, t=2, p=1). Tokens (sessions, invitations, resets, recovery codes): HMAC-SHA256 keyed hashes.
- No custom cryptography: Node's `crypto` and audited libraries only.

## Headers

API: CSP `default-src 'none'; frame-ancestors 'none'`, HSTS (production, with preload), `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera/mic/geo/payment, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, CORP `same-site`. The web app's own CSP is set by the reverse proxy (see DEPLOYMENT.md).

## Reporting

Security issues: email security@daliz.example (placeholder for the operating company's address). Please don't open public issues for vulnerabilities.
