import { useMutation } from '@tanstack/react-query';
import { totpCodeSchema, type MfaSetupResponse, type RecoveryCodesResponse } from '@daliz/shared';
import { Check, Copy, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/utils';
import { RecoveryCodes } from './recovery-codes';

/**
 * TOTP enrolment: POST /auth/mfa/setup → scan QR → POST /auth/mfa/enable {code} → show the
 * 10 recovery codes once. `onComplete` runs after the user confirms they saved the codes.
 */
export function MfaEnrollment({ email, onComplete, onCancel }: { email: string; onComplete: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const begin = useMutation({
    mutationFn: () => api.post<MfaSetupResponse>('/auth/mfa/setup'),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: (c: string) => api.post<RecoveryCodesResponse>('/auth/mfa/enable', { code: c }, { silent: true }),
    meta: { silent: true },
    onSuccess: (r) => setCodes(r.recoveryCodes),
    onError: (e) => {
      setCodeError(errorMessage(e));
      setCode('');
    },
  });

  if (codes) return <RecoveryCodes codes={codes} email={email} onDone={onComplete} />;

  if (!setup) {
    return (
      <div className="grid gap-4">
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-muted-foreground">
            You’ll need an authenticator app such as 1Password, Authy, Google Authenticator or Microsoft Authenticator. Each time you sign in, you’ll
            enter a 6-digit code from the app.
          </p>
        </div>
        {begin.isError ? <Alert variant="destructive" title={errorMessage(begin.error)} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => begin.mutate()} loading={begin.isPending}>
            Get started
          </Button>
          {onCancel ? (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setCodeError(parsed.error.issues[0]?.message ?? 'Enter the 6-digit code');
      return;
    }
    setCodeError(null);
    enable.mutate(parsed.data);
  };

  return (
    <div className="grid gap-5">
      <ol className="grid gap-5 text-sm">
        <li className="grid gap-3">
          <p>
            <span className="font-semibold">1.</span> Scan this QR code with your authenticator app.
          </p>
          <div className="flex flex-col items-center gap-4 rounded-lg border bg-white p-4 sm:flex-row sm:items-start">
            <img src={setup.qrCodeDataUrl} alt="QR code for your authenticator app" className="size-44 shrink-0" />
            <div className="grid min-w-0 gap-2 text-slate-700">
              <p className="text-xs">Can’t scan? Enter this setup key manually:</p>
              <code className="rounded bg-slate-100 px-2 py-1.5 font-mono text-xs break-all text-slate-900 select-all">{setup.secret}</code>
              <Button
                variant="outline"
                size="sm"
                className="w-fit border-slate-300 bg-white text-slate-900 hover:bg-slate-100 hover:text-slate-900"
                onClick={async () => {
                  if (await copyText(setup.secret)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } else toast.error('Couldn’t copy the key');
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy key'}
              </Button>
            </div>
          </div>
        </li>
        <li className="grid gap-3">
          <p>
            <span className="font-semibold">2.</span> Enter the 6-digit code the app shows.
          </p>
          <form onSubmit={submit} className="grid gap-3" noValidate>
            <FormField label="Authentication code" error={codeError ?? undefined}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                autoFocus
                className="max-w-48 text-center font-mono text-lg tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={enable.isPending}>
                Verify and enable
              </Button>
              {onCancel ? (
                <Button variant="outline" onClick={onCancel} disabled={enable.isPending}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </li>
      </ol>
    </div>
  );
}
