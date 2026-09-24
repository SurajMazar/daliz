import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LEDGER_ACCOUNT_SUBTYPES,
  LEDGER_ACCOUNT_TYPES,
  ledgerAccountInputSchema,
  type LedgerAccountRow,
  type LedgerAccountType,
} from '@daliz/shared';
import { Ellipsis, Lock, Pencil, Plus, Power, PowerOff } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn, humanize } from '@/lib/utils';
import { AccountingTabs } from './accounting-tabs';
import { ACCOUNT_TYPE_LABELS, accountingKeys, useLedgerAccounts } from './api';

export function AccountsPage() {
  const { canWrite } = useAccess();
  const fmt = useTenantFormat();
  const qc = useQueryClient();
  const accounts = useLedgerAccounts();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<LedgerAccountRow | 'new' | null>(null);
  const [toggling, setToggling] = useState<LedgerAccountRow | null>(null);
  const toggle = useMutation({
    mutationFn: (a: LedgerAccountRow) => api.patch(`/accounting/accounts/${a.id}`, { isActive: !a.isActive, version: a.version }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: accountingKeys.accounts }),
  });

  const rows = (accounts.data ?? []).filter((a) => showInactive || a.isActive);
  const inactiveCount = (accounts.data ?? []).filter((a) => !a.isActive).length;

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Balances include posted entries only and are shown in each account’s normal direction."
        actions={
          canWrite('accounting.create') ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> New account
            </Button>
          ) : null
        }
      />
      <AccountingTabs />
      <div className="mb-4 flex items-center gap-2">
        <Checkbox id="show-inactive" checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} />
        <Label htmlFor="show-inactive" className="font-normal">
          Show inactive accounts{inactiveCount ? ` (${inactiveCount})` : ''}
        </Label>
      </div>
      {accounts.isPending ? (
        <Card>
          <SkeletonRows rows={10} cols={4} />
        </Card>
      ) : accounts.isError ? (
        <Card>
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {LEDGER_ACCOUNT_TYPES.map((type) => {
            const group = rows.filter((a) => a.type === type);
            if (group.length === 0) return null;
            return (
              <Card key={type} className="overflow-hidden">
                <CardHeader className="pb-3 sm:pb-3">
                  <CardTitle>{ACCOUNT_TYPE_LABELS[type]}</CardTitle>
                </CardHeader>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-24">Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="hidden md:table-cell">Subtype</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead className="w-12">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.map((a) => (
                      <TableRow key={a.id} className={cn(!a.isActive && 'opacity-60')}>
                        <TableCell className="font-mono text-xs">{a.code}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{a.name}</span>
                            {a.isSystem ? (
                              <Badge variant="muted">
                                <Lock aria-hidden /> System
                              </Badge>
                            ) : null}
                            {!a.isActive ? <Badge variant="outline">Inactive</Badge> : null}
                          </div>
                          {a.description ? <div className="text-xs text-muted-foreground">{a.description}</div> : null}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">{humanize(a.subtype)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Link
                            to={`/accounting/reports?tab=ledger&account=${a.id}`}
                            className="font-mono tabular-nums hover:underline"
                            aria-label={`Ledger for ${a.name}: ${fmt.money(a.balance)}`}
                          >
                            {fmt.money(a.balance)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {canWrite('accounting.update') ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.name}`}>
                                  <Ellipsis />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem onSelect={() => setEditing(a)}>
                                  <Pencil /> Edit
                                </DropdownMenuItem>
                                {!a.isSystem ? (
                                  <DropdownMenuItem onSelect={() => setToggling(a)} destructive={a.isActive}>
                                    {a.isActive ? <PowerOff /> : <Power />} {a.isActive ? 'Deactivate' : 'Reactivate'}
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            );
          })}
        </div>
      )}
      {editing ? <AccountDialog account={editing === 'new' ? undefined : editing} accounts={accounts.data ?? []} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(o) => !o && setToggling(null)}
        destructive={toggling?.isActive}
        title={toggling?.isActive ? `Deactivate ${toggling?.name}?` : `Reactivate ${toggling?.name}?`}
        description={toggling?.isActive ? 'It stays in reports but can’t be used on new entries.' : 'It can be used on new entries again.'}
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Reactivate'}
        onConfirm={async () => {
          if (!toggling) return;
          await toggle.mutateAsync(toggling);
          toast.success(toggling.isActive ? 'Account deactivated' : 'Account reactivated');
        }}
      />
    </>
  );
}

type Values = z.input<typeof ledgerAccountInputSchema>;

function AccountDialog({ account, accounts, onClose }: { account: LedgerAccountRow | undefined; accounts: LedgerAccountRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values, unknown, z.output<typeof ledgerAccountInputSchema>>({
    resolver: zodResolver(ledgerAccountInputSchema),
    defaultValues: {
      code: account?.code ?? '',
      name: account?.name ?? '',
      type: account?.type ?? 'expense',
      subtype: account?.subtype ?? 'other',
      parentId: account?.parentId ?? null,
      description: account?.description ?? '',
    },
  });
  const type = form.watch('type') as LedgerAccountType;
  const parents = accounts.filter((a) => a.type === type && a.id !== account?.id && a.isActive);
  const typeLocked = !!account && (account.isSystem || account.hasPostings);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (account) {
        const patch: Record<string, unknown> = { name: v.name, code: v.code, parentId: v.parentId, description: v.description, version: account.version };
        if (!typeLocked) {
          patch.type = v.type;
          patch.subtype = v.subtype;
        }
        await api.patch(`/accounting/accounts/${account.id}`, patch);
      } else {
        await api.post('/accounting/accounts', v);
      }
      await qc.invalidateQueries({ queryKey: accountingKeys.accounts });
      toast.success(account ? 'Account updated' : 'Account created');
      onClose();
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['code', 'name', 'type', 'subtype', 'parentId', 'description'], { toastUnmatched: false })) setError(errorMessage(e));
    }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{account ? `Edit ${account.name}` : 'New account'}</DialogTitle>
            <DialogDescription>{account?.isSystem ? 'A system account: its type is fixed and it can’t be deactivated.' : 'Accounts group postings in reports.'}</DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive" title={error} /> : null}
          <div className="grid gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
            <FormField label="Code" required error={form.formState.errors.code?.message}>
              <Input className="font-mono" autoFocus={!account} {...form.register('code')} />
            </FormField>
            <FormField label="Name" required error={form.formState.errors.name?.message}>
              <Input {...form.register('name')} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Type" required error={form.formState.errors.type?.message} hint={typeLocked ? 'Can’t change once used or for system accounts.' : undefined}>
              <NativeSelect disabled={typeLocked} {...form.register('type')}>
                {LEDGER_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Subtype" error={form.formState.errors.subtype?.message}>
              <NativeSelect disabled={typeLocked} {...form.register('subtype')}>
                {LEDGER_ACCOUNT_SUBTYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          <FormField label="Parent account" error={form.formState.errors.parentId?.message}>
            <NativeSelect {...form.register('parentId', { setValueAs: (v) => (v ? v : null) })}>
              <option value="">None</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Description" error={form.formState.errors.description?.message}>
            <Textarea rows={2} maxLength={500} {...form.register('description')} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {account ? 'Save account' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
