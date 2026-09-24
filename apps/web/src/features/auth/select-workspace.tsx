import { ArrowRight, Building, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { useSession, useSignOut, useSwitchWorkspace } from '@/lib/session';
import { useDocumentTitle } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { AuthCard } from './auth-layout';

export function SelectWorkspacePage() {
  useDocumentTitle('Choose a workspace');
  const me = useSession();
  const signOut = useSignOut();
  const switcher = useSwitchWorkspace();
  const [choosing, setChoosing] = useState<string | null>(null);

  const choose = async (tenantId: string) => {
    setChoosing(tenantId);
    try {
      await switcher.switchTo(tenantId);
    } catch (e) {
      toast.error(errorMessage(e));
      setChoosing(null);
    }
  };

  return (
    <AuthCard title="Choose a workspace" description={`Signed in as ${me.account.email}`}>
      {me.memberships.length === 0 ? (
        <EmptyState
          icon={Building}
          title="You’re not a member of any workspace yet"
          description="Ask your administrator to invite you, then open the link in the invitation email."
          className="py-6"
        />
      ) : (
        <ul className="grid gap-2">
          {me.memberships.map((m) => {
            const available = m.status === 'active';
            const current = me.tenant?.id === m.tenantId;
            return (
              <li key={m.tenantId}>
                <button
                  type="button"
                  disabled={!available || choosing !== null}
                  onClick={() => choose(m.tenantId)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    available ? 'hover:border-primary/50 hover:bg-muted/60' : 'cursor-not-allowed opacity-60',
                    current && 'border-primary/60 bg-primary/5',
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold text-primary" aria-hidden>
                    {m.tenantName.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{m.tenantName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.organizationName} · {m.tenantSlug}
                    </span>
                  </span>
                  {available ? (
                    choosing === m.tenantId ? (
                      <Spinner className="size-4" />
                    ) : current ? (
                      <span className="text-xs font-medium text-primary">Current</span>
                    ) : (
                      <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
                    )
                  ) : (
                    <StatusBadge status={m.status} />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        {me.platform ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/platform">
              <ShieldCheck /> Platform console
            </Link>
          </Button>
        ) : (
          <span />
        )}
        <Button variant="link" className="text-muted-foreground" onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </div>
    </AuthCard>
  );
}
