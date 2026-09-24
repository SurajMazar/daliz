import { KeyRound, Lock, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAccess } from '@/lib/session';
import { useRoles } from './api';

export function RolesPage() {
  const { canWrite } = useAccess();
  const roles = useRoles();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles bundle permissions. Everyone gets the combined permissions of all their roles."
        actions={
          canWrite('roles.create') ? (
            <Button asChild>
              <Link to="/admin/roles/new">
                <Plus /> New role
              </Link>
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        {roles.isPending ? (
          <SkeletonRows rows={6} cols={4} />
        ) : roles.isError ? (
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        ) : roles.data.length === 0 ? (
          <EmptyState icon={KeyRound} title="No roles" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Role</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Permissions</TableHead>
                <TableHead className="text-right">Users</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.data.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/admin/roles/${r.id}`)}>
                  <TableCell>
                    <Link
                      to={`/admin/roles/${r.id}`}
                      className="font-medium outline-none hover:underline focus-visible:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.name}
                    </Link>
                    {r.description ? <div className="max-w-md truncate text-xs text-muted-foreground">{r.description}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.isSystem ? <Badge variant="muted">Built-in</Badge> : <Badge variant="info">Custom</Badge>}
                      {r.immutable ? (
                        <Badge variant="outline">
                          <Lock /> Locked
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.permissions.length}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.userCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
