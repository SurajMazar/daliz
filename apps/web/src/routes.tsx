import { lazy } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RouteError } from '@/components/app/route-error';
import { AdaptiveShell } from '@/components/layout/adaptive-shell';
import { RequirePermission, RequirePlatformPermission, RequireSession } from '@/components/layout/guards';
import { PlatformShell } from '@/components/layout/platform-shell';
import { TenantShell } from '@/components/layout/tenant-shell';
import { RolesPage } from '@/features/admin/roles-page';
import { SecurityPage } from '@/features/admin/security-page';
import { SettingsPage } from '@/features/admin/settings-page';
import { UsersPage } from '@/features/admin/users-page';
import { AcceptInvitePage } from '@/features/auth/accept-invite';
import { AuthLayout } from '@/features/auth/auth-layout';
import { ForgotPasswordPage } from '@/features/auth/forgot-password';
import { LoginPage } from '@/features/auth/login';
import { MfaChallengePage } from '@/features/auth/mfa-challenge';
import { MfaEnrollPage } from '@/features/auth/mfa-enroll-page';
import { ResetPasswordPage } from '@/features/auth/reset-password';
import { SelectWorkspacePage } from '@/features/auth/select-workspace';
import { VerifyEmailPage } from '@/features/auth/verify-email';
import { NotFoundPage } from '@/features/errors/not-found';
import { DashboardPage } from '@/features/tenant/dashboard';
import { setNavigator } from '@/lib/navigation';
import { Root } from './root';

// Less-visited areas load on demand; the shells render a skeleton while they do.
const EventsPage = lazy(() => import('@/features/events/events-page').then((m) => ({ default: m.EventsPage })));
const NotificationsPage = lazy(() => import('@/features/notifications/notifications-page').then((m) => ({ default: m.NotificationsPage })));
const IntegrationsPage = lazy(() => import('@/features/integrations/integrations-page').then((m) => ({ default: m.IntegrationsPage })));
const JournalListPage = lazy(() => import('@/features/accounting/journal-list-page').then((m) => ({ default: m.JournalListPage })));
const AccountsPage = lazy(() => import('@/features/accounting/accounts-page').then((m) => ({ default: m.AccountsPage })));
const ReportsPage = lazy(() => import('@/features/accounting/reports-page').then((m) => ({ default: m.ReportsPage })));
const AccountingSettingsPage = lazy(() => import('@/features/accounting/settings-page').then((m) => ({ default: m.AccountingSettingsPage })));
const EntryEditorPage = lazy(() => import('@/features/accounting/entry-editor-page').then((m) => ({ default: m.EntryEditorPage })));
const EntryDetailPage = lazy(() => import('@/features/accounting/entry-detail-page').then((m) => ({ default: m.EntryDetailPage })));
const DaybookPage = lazy(() => import('@/features/daybook/daybook-page').then((m) => ({ default: m.DaybookPage })));
const FilesPage = lazy(() => import('@/features/files/files-page').then((m) => ({ default: m.FilesPage })));
const TrashPage = lazy(() => import('@/features/files/trash-page').then((m) => ({ default: m.TrashPage })));
const PlannerHomePage = lazy(() => import('@/features/planner/planner-home-page').then((m) => ({ default: m.PlannerHomePage })));
const WorkspacePage = lazy(() => import('@/features/planner/workspace-page').then((m) => ({ default: m.WorkspacePage })));
const ProjectPage = lazy(() => import('@/features/planner/project-page').then((m) => ({ default: m.ProjectPage })));
const AccountPage = lazy(() => import('@/features/account/account-page').then((m) => ({ default: m.AccountPage })));
const AuditPage = lazy(() => import('@/features/admin/audit-page').then((m) => ({ default: m.AuditPage })));
const RoleEditorPage = lazy(() => import('@/features/admin/role-editor').then((m) => ({ default: m.RoleEditorPage })));
const BrandingPage = lazy(() => import('@/features/branding/branding-page').then((m) => ({ default: m.BrandingPage })));
const PlatformAdminsPage = lazy(() => import('@/features/platform/admins-page').then((m) => ({ default: m.PlatformAdminsPage })));
const PlatformAuditPage = lazy(() => import('@/features/platform/audit-page').then((m) => ({ default: m.PlatformAuditPage })));
const PlatformDashboardPage = lazy(() => import('@/features/platform/dashboard-page').then((m) => ({ default: m.PlatformDashboardPage })));
const HealthPage = lazy(() => import('@/features/platform/health-page').then((m) => ({ default: m.HealthPage })));
const OrganizationsPage = lazy(() => import('@/features/platform/organizations-page').then((m) => ({ default: m.OrganizationsPage })));
const SecurityEventsPage = lazy(() => import('@/features/platform/security-events-page').then((m) => ({ default: m.SecurityEventsPage })));
const PlatformSettingsPage = lazy(() => import('@/features/platform/settings-page').then((m) => ({ default: m.PlatformSettingsPage })));
const TenantDetailPage = lazy(() => import('@/features/platform/tenant-detail-page').then((m) => ({ default: m.TenantDetailPage })));
const TenantsPage = lazy(() => import('@/features/platform/tenants-page').then((m) => ({ default: m.TenantsPage })));

const routes: RouteObject[] = [
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      // Public: sign-in and account recovery, branded from the Host.
      {
        element: <AuthLayout />,
        children: [
          { path: 'login', element: <LoginPage /> },
          { path: 'login/mfa', element: <MfaChallengePage /> },
          { path: 'forgot-password', element: <ForgotPasswordPage /> },
          { path: 'reset-password', element: <ResetPasswordPage /> },
          { path: 'accept-invite', element: <AcceptInvitePage /> },
          { path: 'verify-email', element: <VerifyEmailPage /> },
        ],
      },
      // Signed in, but reachable while MFA enrolment is still required.
      {
        element: <RequireSession allowEnrollment />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { path: 'mfa/setup', element: <MfaEnrollPage /> },
              { path: 'select-workspace', element: <SelectWorkspacePage /> },
            ],
          },
        ],
      },
      // Fully signed in.
      {
        element: <RequireSession />,
        errorElement: <RouteError />,
        children: [
          {
            element: <TenantShell />,
            errorElement: <RouteError />,
            children: [
              { index: true, element: <DashboardPage /> },
              {
                path: 'accounting',
                handle: { crumb: 'Accounting' },
                children: [
                  { index: true, element: <RequirePermission perm="accounting.read"><JournalListPage /></RequirePermission> },
                  { path: 'accounts', handle: { crumb: 'Chart of accounts' }, element: <RequirePermission perm="accounting.read"><AccountsPage /></RequirePermission> },
                  { path: 'reports', handle: { crumb: 'Reports' }, element: <RequirePermission perm="accounting.read"><ReportsPage /></RequirePermission> },
                  { path: 'settings', handle: { crumb: 'Settings' }, element: <RequirePermission perm="accounting.read"><AccountingSettingsPage /></RequirePermission> },
                  { path: 'entries/new', element: <RequirePermission perm="accounting.create"><EntryEditorPage /></RequirePermission> },
                  { path: 'entries/:id', element: <RequirePermission perm="accounting.read"><EntryDetailPage /></RequirePermission> },
                  { path: 'entries/:id/edit', element: <RequirePermission perm="accounting.update"><EntryEditorPage /></RequirePermission> },
                ],
              },
              { path: 'daybook', handle: { crumb: 'Daybook' }, element: <RequirePermission perm="daybook.read"><DaybookPage /></RequirePermission> },
              {
                path: 'files',
                handle: { crumb: 'Files' },
                children: [
                  { index: true, element: <RequirePermission perm="files.read"><FilesPage /></RequirePermission> },
                  { path: 'folder/:folderId', element: <RequirePermission perm="files.read"><FilesPage /></RequirePermission> },
                  { path: 'trash', handle: { crumb: 'Trash' }, element: <RequirePermission perm="files.read"><TrashPage /></RequirePermission> },
                ],
              },
              {
                path: 'planner',
                handle: { crumb: 'Planner' },
                children: [
                  { index: true, element: <RequirePermission perm="planner.read"><PlannerHomePage /></RequirePermission> },
                  { path: 'w/:workspaceId', element: <RequirePermission perm="planner.read"><WorkspacePage /></RequirePermission> },
                  { path: 'p/:projectId', element: <RequirePermission perm="planner.read"><ProjectPage /></RequirePermission> },
                ],
              },
              { path: 'events', handle: { crumb: 'Events' }, element: <RequirePermission perm="events.read"><EventsPage /></RequirePermission> },
              { path: 'notifications', handle: { crumb: 'Notifications' }, element: <NotificationsPage /> },
              {
                path: 'admin',
                handle: { crumb: 'Administration' },
                children: [
                  { index: true, element: <Navigate to="/admin/users" replace /> },
                  { path: 'users', handle: { crumb: 'Users' }, element: <RequirePermission perm="users.read"><UsersPage /></RequirePermission> },
                  {
                    path: 'roles',
                    handle: { crumb: 'Roles' },
                    children: [
                      { index: true, element: <RequirePermission perm="roles.read"><RolesPage /></RequirePermission> },
                      { path: ':id', element: <RequirePermission perm="roles.read"><RoleEditorPage /></RequirePermission> },
                    ],
                  },
                  { path: 'branding', handle: { crumb: 'Branding' }, element: <RequirePermission perm="branding.read"><BrandingPage /></RequirePermission> },
                  { path: 'security', handle: { crumb: 'Security' }, element: <RequirePermission perm="security.read"><SecurityPage /></RequirePermission> },
                  { path: 'audit', handle: { crumb: 'Audit log' }, element: <RequirePermission perm="audit.read"><AuditPage /></RequirePermission> },
                  { path: 'settings', handle: { crumb: 'Settings' }, element: <RequirePermission perm="settings.read"><SettingsPage /></RequirePermission> },
                  { path: 'integrations', handle: { crumb: 'Integrations' }, element: <RequirePermission perm="settings.update"><IntegrationsPage /></RequirePermission> },
                ],
              },
            ],
          },
          {
            path: 'account',
            element: <AdaptiveShell />,
            errorElement: <RouteError />,
            children: [{ index: true, handle: { crumb: 'Account' }, element: <AccountPage /> }],
          },
          {
            path: 'platform',
            element: <PlatformShell />,
            errorElement: <RouteError />,
            children: [
              { index: true, element: <RequirePlatformPermission perm="platform.dashboard.read"><PlatformDashboardPage /></RequirePlatformPermission> },
              { path: 'organizations', handle: { crumb: 'Organizations' }, element: <RequirePlatformPermission perm="platform.organizations.read"><OrganizationsPage /></RequirePlatformPermission> },
              {
                path: 'tenants',
                handle: { crumb: 'Tenants' },
                children: [
                  { index: true, element: <RequirePlatformPermission perm="platform.tenants.read"><TenantsPage /></RequirePlatformPermission> },
                  { path: ':id', element: <RequirePlatformPermission perm="platform.tenants.read"><TenantDetailPage /></RequirePlatformPermission> },
                ],
              },
              { path: 'audit', handle: { crumb: 'Audit log' }, element: <RequirePlatformPermission perm="platform.audit.read"><PlatformAuditPage /></RequirePlatformPermission> },
              { path: 'security-events', handle: { crumb: 'Security events' }, element: <RequirePlatformPermission perm="platform.audit.read"><SecurityEventsPage /></RequirePlatformPermission> },
              { path: 'admins', handle: { crumb: 'Platform admins' }, element: <RequirePlatformPermission perm="platform.admins.manage"><PlatformAdminsPage /></RequirePlatformPermission> },
              { path: 'settings', handle: { crumb: 'Settings' }, element: <RequirePlatformPermission perm="platform.settings.manage"><PlatformSettingsPage /></RequirePlatformPermission> },
              { path: 'health', handle: { crumb: 'System health' }, element: <RequirePlatformPermission perm="platform.health.read"><HealthPage /></RequirePlatformPermission> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
setNavigator((to, opts) => void router.navigate(to, opts));
