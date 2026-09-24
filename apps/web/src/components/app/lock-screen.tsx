import type { MeResponse } from '@daliz/shared';
import { Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { ME_KEY, useSignOut } from '@/lib/session';

const LOCK_KEY = 'daliz.locked';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

function readLocked(): boolean {
  try {
    return sessionStorage.getItem(LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Inactivity lock (every platform). After the workspace's lockScreenMinutes without input the
 * app content is blurred and made inert, and a password (+ authenticator code) re-check via
 * POST /auth/step-up unlocks it. The session itself stays signed in; a reload stays locked.
 */
export function LockScreenGuard({
  minutes,
  me,
  children,
}: {
  minutes: number | undefined;
  me: MeResponse;
  children: ReactNode;
}) {
  const [locked, setLocked] = useState(readLocked);
  const last = useRef(Date.now());

  const lock = useCallback(() => {
    setLocked(true);
    try {
      sessionStorage.setItem(LOCK_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!minutes || minutes <= 0 || locked) return;
    last.current = Date.now();
    let lastMove = 0;
    const onActivity = (e: Event) => {
      if (e.type === 'mousemove') {
        const now = Date.now();
        if (now - lastMove < 5_000) return;
        lastMove = now;
      }
      last.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last.current >= minutes * 60_000) lock();
    }, 15_000);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      window.clearInterval(timer);
    };
  }, [minutes, locked, lock]);

  const unlock = () => {
    setLocked(false);
    try {
      sessionStorage.removeItem(LOCK_KEY);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!locked) return;
    // Everything on the page (app, open dialogs, toasts, which Radix portals into <body>)
    // is blurred and inert while locked; only the lock overlay stays interactive.
    const touched = new Set<HTMLElement>();
    const hide = (el: Element) => {
      if (
        !(el instanceof HTMLElement) ||
        el.dataset.lockOverlay !== undefined ||
        el.tagName === 'SCRIPT'
      )
        return;
      el.inert = true;
      el.setAttribute('aria-hidden', 'true');
      el.classList.add('daliz-locked');
      touched.add(el);
    };
    Array.from(document.body.children).forEach(hide);
    const mo = new MutationObserver((records) =>
      records.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && hide(n))),
    );
    mo.observe(document.body, { childList: true });
    return () => {
      mo.disconnect();
      touched.forEach((el) => {
        el.inert = false;
        el.removeAttribute('aria-hidden');
        el.classList.remove('daliz-locked');
      });
    };
  }, [locked]);

  return (
    <>
      {children}
      {locked
        ? createPortal(
            <div data-lock-overlay="">
              <LockOverlay me={me} onUnlock={unlock} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function LockOverlay({ me, onUnlock }: { me: MeResponse; onUnlock: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signOut = useSignOut();
  const needsCode = me.account.mfaEnabled;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!password) return setError('Enter your password.');
    if (needsCode && !/^\d{6}$/.test(code))
      return setError('Enter the 6-digit code from your authenticator app.');
    setBusy(true);
    try {
      const res = await api.post<{ stepUpUntil: string }>(
        '/auth/step-up',
        { password, ...(needsCode ? { code } : {}) },
        { silent: true, skipStepUp: true },
      );
      queryClient.setQueryData<MeResponse | null>(ME_KEY, (prev) =>
        prev ? { ...prev, stepUpUntil: res.stepUpUntil } : prev,
      );
      onUnlock();
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="grid w-full max-w-sm gap-4 rounded-xl border bg-card p-6 shadow-2xl"
        noValidate
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar name={me.account.name} className="size-12 text-base" />
          <h1 id="lock-title" className="flex items-center gap-2 text-lg font-semibold">
            <Lock className="size-4" aria-hidden /> Locked
          </h1>
          <p className="text-sm text-muted-foreground">
            {me.account.name} · {me.tenant?.name}
          </p>
        </div>
        {error ? <Alert variant="destructive" title={error} /> : null}
        <div className="grid gap-2">
          <Label htmlFor="lock-password">Password</Label>
          <Input
            id="lock-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {needsCode ? (
          <div className="grid gap-2">
            <Label htmlFor="lock-code">Authentication code</Label>
            <Input
              id="lock-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ) : null}
        <Button type="submit" loading={busy}>
          Unlock
        </Button>
        <Button variant="link" className="text-muted-foreground" onClick={() => signOut.mutate()}>
          Sign out instead
        </Button>
      </form>
    </div>
  );
}
