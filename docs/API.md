# API

Base path `/api/v1`. Interactive OpenAPI docs at `/api/docs` (non-production), generated from the same Zod schemas that validate requests.

## Conventions

- **Auth**: session cookie. Mutations need `X-CSRF-Token`. Optional `X-Daliz-Client: web|pwa|desktop`.
- **Tenant**: implied by the session. Never pass a tenant id, because it would be ignored.
- **Success**: `{ "success": true, "data": … }`. Lists add `"meta": { "page", "pageSize", "total" }`. Query parameters are `page` (1-based), `pageSize` (≤100) and `q`.
- **Errors**:
  ```json
  { "success": false, "error": { "code": "RESOURCE_NOT_FOUND", "message": "The requested resource could not be found.", "requestId": "…", "details": [{ "path": "email", "message": "Enter a valid email" }] } }
  ```
  `message` is safe to display. Internal details only appear in server logs, found by `requestId`. Codes are listed in `packages/shared/src/api.ts` (`ERROR_CODES`).
- **Status codes**: 400 bad request, 401 unauthenticated/MFA pending, 403 forbidden/policy, 404 not found (including resources in other tenants), 409 conflict/version conflict, 413 too large, 415 unsupported media, 422 validation, 429 rate limited (`Retry-After`), 503 maintenance.
- **Request ids**: `X-Request-Id` is echoed or generated.
- **Concurrency**: updates to users, roles and settings take the `version` you read and fail with `VERSION_CONFLICT` if it changed.

## Endpoints

### Auth `/auth`
`POST login` · `POST mfa/verify` · `POST logout` · `POST logout-all` · `GET me` · `POST tenant` (select workspace) · `POST password/forgot` · `POST password/reset` · `POST password/change` · `PATCH profile` · `POST email/verification` · `POST email/verify` · `POST invitations/describe` · `POST invitations/accept` · `POST step-up` · `GET sessions` · `DELETE sessions/:id` · `POST mfa/setup` · `POST mfa/enable` · `POST mfa/disable`\* · `POST mfa/recovery-codes`\*

### Tenant (session tenant)
`GET dashboard` · `GET|POST users` · `GET|PATCH|DELETE users/:id` · `POST users/:id/resend-invitation` · `GET|POST roles` · `PUT|DELETE roles/:id` · `GET permissions` · `GET|PUT settings/general` · `GET|PUT settings/security`\* · `GET audit` · `GET branding` · `POST branding/logo` (multipart `file`) · `GET branding/uploads/:assetId/:variant.png` · `PUT branding`

### Accounting `/accounting` & Daybook `/daybook`
`GET|POST accounts` · `PATCH accounts/:id` · `GET|POST journal-entries`† · `GET|PUT|DELETE journal-entries/:id` · `POST journal-entries/:id/{submit,approve,post†,reverse†}` · `GET reports/{trial-balance,income-statement,balance-sheet}` · `GET reports/ledger/:accountId` · `GET|PUT settings` — `GET|POST daybook/entries`† · `GET|PUT daybook/entries/:id` · `POST daybook/entries/:id/void` · `GET daybook/summary` · `GET daybook/accounts`

### Files `/files`
`GET /files` (folder contents or library search) · `GET usage` · `GET trash` · `POST upload` (multipart `file`, `folderId`) · `GET|PATCH|DELETE :id` · `POST :id/{copy,restore}` · `DELETE :id/purge` · `GET|POST :id/versions` · `GET :id/download` · `GET :id/preview` · `GET|POST :id/shares` · `DELETE :id/shares/:shareId` · `POST folders` · `PATCH|DELETE folders/:id` · `POST folders/:id/restore` · `DELETE folders/:id/purge` · folder shares likewise

### Planner `/planner`
`GET|POST workspaces` · `PATCH|DELETE workspaces/:id` · `GET|PUT workspaces/:id/members` · `GET|POST projects` · `GET|PATCH projects/:id` · `GET|POST tasks`† · `GET|PATCH|DELETE tasks/:id` · `POST tasks/:id/move` · `GET|POST tasks/:id/comments`† · `PATCH|DELETE tasks/:id/comments/:commentId` · `POST tasks/:id/attachments` · `DELETE tasks/:id/attachments/:fileId` · `GET tasks/:id/activity` · `GET|POST labels` · `DELETE labels/:id` · `GET people` · `GET summary`

### Events, reminders, notifications
`GET /events?from&to&mine` (expanded occurrences) · `POST /events`† · `GET|PATCH|DELETE /events/:id` · `POST /events/:id/occurrences` (move/cancel one occurrence) · `POST /events/:id/rsvp` · `GET|POST /reminders`† · `PATCH|DELETE /reminders/:id` · `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/read` · `GET|PUT /notifications/preferences` · `GET /notifications/push` · `POST /notifications/push/{subscribe,unsubscribe}`

### Realtime
Socket.IO at path `/api/v1/realtime` (same origin; session cookie). The server joins each socket to its own tenant/user rooms; clients can't subscribe to anything. Messages (`message` event): `{type:'notification', notification, unread}`, `{type:'invalidate', topics:[…]}`, `{type:'session_ended', reason}`.

### Public
`GET public/branding` (by Host) · `GET public/branding/assets/:tenantId/:assetId/:variant.png?s=` (signed) · `GET health/live` · `GET health/ready`

### Platform `/platform` (platform permissions)
`GET dashboard` · `GET health` · `GET meta` · `GET|POST organizations` · `PATCH organizations/:id` · `GET|POST tenants` · `POST tenants/migrate-all`\* · `GET|PATCH tenants/:id` · `POST tenants/:id/{suspend,activate,retry-provisioning,migrate}` · `POST tenants/:id/decommission`\* · `POST tenants/:id/decommission/cancel` · `POST tenants/:id/domains` · `POST tenants/:id/domains/:domainId/verify` · `DELETE tenants/:id/domains/:domainId` · `POST tenants/:id/admins` · `POST tenants/:id/admins/:accountId/reset-access`\* · `GET tenants/:id/audit` · `POST tenants/:id/support-access`\* · `POST support-access/end` · `GET audit` · `GET security-events` · `GET|POST admins`\* · `PATCH admins/:accountId`\* · `GET|PUT settings`\* · `GET|PUT feature-flags`

\* requires a recent step-up (`STEP_UP_REQUIRED` otherwise). † honours `Idempotency-Key` (retries replay the first response; a reused key with a different body → `IDEMPOTENCY_CONFLICT`).

## Rate limits

| Bucket | Limit |
| --- | --- |
| Login per email | 10 / 15 min (same for unknown emails) |
| Login per IP | 150 / 15 min |
| Auth endpoints per IP | 300 / 15 min |
| MFA verification per session | 8 / 15 min |
| Step-up per account | 8 / 15 min |
| Password reset per IP and per email | 5 / hour |
| Invitation lookups per IP | 20 / 15 min |
| Uploads per account | 30 / min |
| Platform admin API per account | 120 / min |
| Authenticated API per account | 600 / min |
| Anonymous API per IP | 120 / min |

Limits are shared across API instances through Redis.
