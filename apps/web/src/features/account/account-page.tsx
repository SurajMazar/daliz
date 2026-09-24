import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { passwordSchema, updateProfileSchema, type RecoveryCodesResponse, type SessionInfo } from '@daliz/shared';
import { KeyRound, Laptop, LogOut, MailCheck, MailWarning, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { MfaEnrollment } from '@/features/auth/mfa-enrollment';
import { NotificationPreferencesCard } from '@/features/notifications/preferences-card';
import { PasswordInput } from '@/features/auth/password-input';
import { RecoveryCodes } from '@/features/auth/recovery-codes';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { refreshMe, useSession, useSignOutEverywhere } from '@/lib/session';
import { formatDateTime, parseUserAgent, ago } from '@/lib/utils';

export function AccountPage() {
  const me = useSession();
  return (
    <>
      <PageHeader title="Account" description="Your profile, password, two-factor authentication and signed-in devices." />
      <div className="grid gap-6">
        <ProfileCard />
        <PasswordCard />
        <MfaCard />
        {me.tenant ? <NotificationPreferencesCard /> : null}
        <SessionsCard />
      </div>
    </>
  );
}

function ProfileCard() {
  const me = useSession();
  const form = useForm<z.infer<typeof updateProfileSchema>>({ resolver: zodResolver(updateProfileSchema), defaultValues: { name: me.account.name } });
  const save = useMutation({ mutationFn: (v: z.infer<typeof updateProfileSchema>) => api.patch('/auth/profile', v), meta: { silent: true } });
  const verify = useMutation({
    mutationFn: () => api.post('/auth/email/verification'),
    onSuccess: () => toast.success('Verification email sent', { description: `Check ${me.account.email} for a link.` }),
  });

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await save.mutateAsync(v);
      await refreshMe();
      form.reset(v);
      toast.success('Profile updated');
    } catch (e) {
      applyServerErrors(e, form.setError, ['name']);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your name is shown to people in the workspaces you belong to.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={form.formState.errors.name?.message} required>
            <Input autoComplete="name" {...form.register('name')} />
          </FormField>
          <FormField
            label="Email"
            hint={me.account.emailVerified ? undefined : 'Not verified yet.'}
            labelAction={
              me.account.emailVerified ? (
                <Badge variant="success">
                  <MailCheck /> Verified
                </Badge>
              ) : (
                <Badge variant="warning">
                  <MailWarning /> Unverified
                </Badge>
              )
            }
          >
            <Input value={me.account.email} readOnly disabled />
          </FormField>
        </CardContent>
        <CardFooter className="justify-between">
          {!me.account.emailVerified ? (
            <Button variant="outline" size="sm" onClick={() => verify.mutate()} loading={verify.isPending}>
              Send verification email
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!form.formState.isDirty}>
            Save profile
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

const passwordFormSchema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password').max(128), newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords don’t match' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: 'Choose a password you haven’t used here' });

function PasswordCard() {
  const form = useForm<z.infer<typeof passwordFormSchema>>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const change = useMutation({
    mutationFn: (v: { currentPassword: string; newPassword: string }) => api.post('/auth/password/change', v),
    meta: { silent: true },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await change.mutateAsync({ currentPassword: v.currentPassword, newPassword: v.newPassword });
      form.reset();
      toast.success('Password changed', { description: 'Other devices may need to sign in again.' });
      void refreshMe();
    } catch (e) {
      applyServerErrors(e, form.setError, ['currentPassword', 'newPassword']);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden /> Password
          </CardTitle>
          <CardDescription>Use at least 12 characters. Avoid passwords you use elsewhere.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <FormField label="Current password" error={form.formState.errors.currentPassword?.message}>
            <PasswordInput autoComplete="current-password" {...form.register('currentPassword')} />
          </FormField>
          <FormField label="New password" error={form.formState.errors.newPassword?.message}>
            <PasswordInput autoComplete="new-password" {...form.register('newPassword')} />
          </FormField>
          <FormField label="Confirm new password" error={form.formState.errors.confirm?.message}>
            <PasswordInput autoComplete="new-password" {...form.register('confirm')} />
          </FormField>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={form.formState.isSubmitting}>
            Change password
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function MfaCard() {
  const me = useSession();
  const [enrolling, setEnrolling] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const disable = useMutation({ mutationFn: () => api.post('/auth/mfa/disable') });
  const regenerate = useMutation({
    mutationFn: () => api.post<RecoveryCodesResponse>('/auth/mfa/recovery-codes'),
    onSuccess: (r) => setCodes(r.recoveryCodes),
  });
  const enabled = me.account.mfaEnabled;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4 text-primary" aria-hidden /> Two-factor authentication
          </CardTitle>
          {enabled ? (
            <Badge variant="success">
              <ShieldCheck /> On
            </Badge>
          ) : (
            <Badge variant="muted">
              <ShieldOff /> Off
            </Badge>
          )}
        </div>
        <CardDescription>
          {enabled
            ? 'You’ll be asked for a code from your authenticator app when you sign in and before sensitive actions.'
            : 'Add a second step to sign-in with an authenticator app. Strongly recommended.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {enabled ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => regenerate.mutate()} loading={regenerate.isPending}>
              Regenerate recovery codes
            </Button>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDisable(true)}>
              Turn off
            </Button>
          </div>
        ) : enrolling ? (
          <MfaEnrollment
            email={me.account.email}
            onCancel={() => setEnrolling(false)}
            onComplete={async () => {
              setEnrolling(false);
              await refreshMe();
              toast.success('Two-factor authentication is on');
            }}
          />
        ) : (
          <Button onClick={() => setEnrolling(true)}>
            <ShieldCheck /> Set up two-factor authentication
          </Button>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        destructive
        title="Turn off two-factor authentication?"
        description="Your account will be protected by your password only, and your other sessions will be signed out. You’ll need to confirm your identity."
        confirmLabel="Turn off"
        onConfirm={async () => {
          await disable.mutateAsync();
          await refreshMe();
          toast.success('Two-factor authentication is off');
        }}
      />

      <Dialog open={!!codes} onOpenChange={(o) => !o && setCodes(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New recovery codes</DialogTitle>
            <DialogDescription>Your previous recovery codes no longer work.</DialogDescription>
          </DialogHeader>
          {codes ? <RecoveryCodes codes={codes} email={me.account.email} onDone={() => setCodes(null)} doneLabel="Done" /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api.get<SessionInfo[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void qc.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
  });
  const signOutAll = useSignOutEverywhere();
  const [confirmAll, setConfirmAll] = useState(false);
  const [revoking, setRevoking] = useState<SessionInfo | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop className="size-4 text-primary" aria-hidden /> Where you’re signed in
        </CardTitle>
        <CardDescription>Sign out of devices you don’t recognise.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0 sm:px-0">
        {sessions.isPending ? (
          <SkeletonRows rows={3} cols={3} />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : (
          <ul className="divide-y border-t">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
                <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Laptop className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {parseUserAgent(s.userAgent)}
                    {s.current ? <Badge variant="success">This device</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.ipAddress ?? 'Unknown IP'} · signed in {formatDateTime(s.createdAt)} · active {ago(s.lastSeenAt)}
                  </div>
                </div>
                {!s.current ? (
                  <Button variant="outline" size="sm" onClick={() => setRevoking(s)}>
                    Sign out
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmAll(true)}>
          <LogOut /> Sign out everywhere
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Sign out this session?"
        description={revoking ? `${parseUserAgent(revoking.userAgent)} (${revoking.ipAddress ?? 'unknown IP'}) will need to sign in again.` : undefined}
        confirmLabel="Sign out session"
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
        }}
      />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        destructive
        title="Sign out everywhere?"
        description="Every session, including this one, will be signed out."
        confirmLabel="Sign out everywhere"
        onConfirm={() => signOutAll.mutateAsync()}
      >
        <Alert variant="warning" title="You’ll be returned to the sign-in page." />
      </ConfirmDialog>
    </Card>
  );
}
