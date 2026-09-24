import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiKeyCreateSchema, type ApiKeyCreated, type ApiKeyRow } from '@daliz/shared';
import { Check, Copy, Ellipsis, KeyRound, Plus, RotateCw, ShieldAlert, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { ago, formatDate, humanize } from '@/lib/utils';
import { copyText } from '@/platform';

const keys = {
  list: ['integrations', 'api-keys'] as const,
  scopes: ['integrations', 'scopes'] as const,
};

export function IntegrationsPage() {
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: keys.list, queryFn: () => api.get<ApiKeyRow[]>('/api-keys') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [rotating, setRotating] = useState<ApiKeyRow | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: keys.list });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/api-keys/${id}/revoke`), onSuccess: invalidate });
  const rotate = useMutation({
    mutationFn: (id: string) => api.post<ApiKeyCreated>(`/api-keys/${id}/rotate`),
    onSuccess: (k) => {
      invalidate();
      setSecret(k);
    },
  });
  const editable = canWrite('settings.update');

  return (
    <>
      <PageHeader
        title="Integrations"
        description="API keys let other systems use the Daliz API on this workspace’s behalf, limited to the scopes you choose."
        actions={
          editable ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New API key
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        {list.isPending ? (
          <SkeletonRows rows={4} cols={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys"
            description="Create a key to connect an accounting tool, a script or an automation."
            action={
              editable ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus /> New API key
                </Button>
              ) : null
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Key</TableHead>
                <TableHead className="hidden lg:table-cell">Scopes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>
                    <div className="font-medium">{k.name}</div>
                    <code className="font-mono text-xs text-muted-foreground">dz_{k.prefix}_…</code>
                  </TableCell>
                  <TableCell className="hidden max-w-sm lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.slice(0, 6).map((s) => (
                        <Badge key={s} variant="muted" className="font-mono">
                          {s}
                        </Badge>
                      ))}
                      {k.scopes.length > 6 ? <Badge variant="outline">+{k.scopes.length - 6}</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={k.status === 'active' ? 'active' : k.status === 'expired' ? 'pending' : 'disabled'} label={humanize(k.status)} />
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{k.expiresAt ? formatDate(k.expiresAt) : 'Never'}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{k.lastUsedAt ? ago(k.lastUsedAt) : 'Never'}</TableCell>
                  <TableCell>
                    {editable && k.status !== 'revoked' ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${k.name}`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setRotating(k)}>
                            <RotateCw /> Rotate secret
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={() => setRevoking(k)}>
                            <Trash /> Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {creating ? (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            invalidate();
            setSecret(k);
          }}
        />
      ) : null}
      {secret ? <SecretDialog apiKey={secret} onClose={() => setSecret(null)} /> : null}
      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(o) => !o && setRotating(null)}
        title={`Rotate ${rotating?.name}?`}
        description="A new secret is issued and the old one stops working immediately. You’ll need to confirm your identity."
        confirmLabel="Rotate secret"
        onConfirm={async () => {
          if (rotating) await rotate.mutateAsync(rotating.id);
        }}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        destructive
        title={`Revoke ${revoking?.name}?`}
        description="Anything using this key loses access immediately. This can’t be undone."
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          toast.success('API key revoked');
        }}
      />
    </>
  );
}

type Values = z.input<typeof apiKeyCreateSchema>;

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (k: ApiKeyCreated) => void }) {
  const scopes = useQuery({ queryKey: keys.scopes, queryFn: () => api.get<string[]>('/api-keys/scopes'), staleTime: Infinity });
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values, unknown, z.output<typeof apiKeyCreateSchema>>({
    resolver: zodResolver(apiKeyCreateSchema),
    defaultValues: { name: '', scopes: [], expiresInDays: 90 },
  });
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of scopes.data ?? []) {
      const g = s.split('.')[0]!;
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()];
  }, [scopes.data]);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const created = await api.post<ApiKeyCreated>('/api-keys', v);
      onCreated(created);
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['name', 'scopes', 'expiresInDays'], { toastUnmatched: false })) setError(errorMessage(e));
    }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Grant only what the integration needs. Creating a key requires confirming your identity.</DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <FormField label="Name" required error={form.formState.errors.name?.message} hint="e.g. “Accounting export”">
              <Input autoFocus maxLength={80} {...form.register('name')} />
            </FormField>
            <FormField label="Expires after (days)" required error={form.formState.errors.expiresInDays?.message}>
              <Input type="number" min={1} max={365} {...form.register('expiresInDays')} />
            </FormField>
          </div>
          <Controller
            control={form.control}
            name="scopes"
            render={({ field, fieldState }) => {
              const selected = new Set(field.value);
              const toggle = (list: string[], on: boolean) => field.onChange((scopes.data ?? []).filter((s) => (list.includes(s) ? on : selected.has(s))));
              return (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">Scopes</legend>
                  {scopes.isPending ? (
                    <SkeletonRows rows={3} cols={3} />
                  ) : (
                    <div className="grid max-h-72 gap-3 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
                      {groups.map(([group, list]) => {
                        const count = list.filter((s) => selected.has(s)).length;
                        return (
                          <div key={group} className="grid gap-1.5">
                            <label className="flex items-center gap-2 text-sm font-semibold">
                              <Checkbox checked={count === 0 ? false : count === list.length ? true : 'indeterminate'} onCheckedChange={(c) => toggle(list, c === true)} />
                              {humanize(group)}
                            </label>
                            {list.map((s) => (
                              <label key={s} className="flex items-center gap-2 pl-6 text-sm">
                                <Checkbox checked={selected.has(s)} onCheckedChange={(c) => toggle([s], c === true)} />
                                <code className="font-mono text-xs">{s}</code>
                              </label>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fieldState.error ? <p className="text-xs text-destructive">{fieldState.error.message}</p> : null}
                </fieldset>
              );
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ apiKey, onClose }: { apiKey: ApiKeyCreated; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && saved && onClose()}>
      <DialogContent hideClose className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy your new secret</DialogTitle>
          <DialogDescription>{apiKey.name}</DialogDescription>
        </DialogHeader>
        <Alert variant="warning" icon={<ShieldAlert aria-hidden />} title="You won’t see this secret again">
          Store it in your integration’s secret manager now. If it’s lost, rotate the key to get a new one.
        </Alert>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all select-all" aria-label="API key secret">
            {apiKey.secret}
          </code>
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy secret"
            onClick={async () => {
              if (await copyText(apiKey.secret)) {
                setCopied(true);
                setSaved(true);
                toast.success('Secret copied');
                setTimeout(() => setCopied(false), 2000);
              } else toast.error('Couldn’t copy — select the text and copy it manually.');
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use it as <code className="font-mono">Authorization: Bearer &lt;secret&gt;</code>.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={saved} onCheckedChange={(c) => setSaved(c === true)} /> I’ve stored the secret somewhere safe
        </label>
        <DialogFooter>
          <Button onClick={onClose} disabled={!saved}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
