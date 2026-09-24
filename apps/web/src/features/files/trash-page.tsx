import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FileRow, FolderRow } from '@daliz/shared';
import { ArrowLeft, RotateCcw, Trash } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useAccess } from '@/lib/session';
import { ago, formatDateTime } from '@/lib/utils';
import { filesKeys, formatBytes, useTrash } from './api';
import { FileIcon, FolderIcon } from './file-icon';

type Entry = { kind: 'folder'; row: FolderRow } | { kind: 'file'; row: FileRow };

export function TrashPage() {
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const trash = useTrash();
  const [purging, setPurging] = useState<Entry | null>(null);
  const canManage = canWrite('files.delete');
  const path = (e: Entry) => (e.kind === 'file' ? `/files/${e.row.id}` : `/files/folders/${e.row.id}`);
  const restore = useMutation({
    mutationFn: (e: Entry) => api.post(`${path(e)}/restore`),
    onSuccess: (_d, e) => {
      void qc.invalidateQueries({ queryKey: filesKeys.all });
      toast.success(`Restored “${e.row.name}”`);
    },
  });
  const purge = useMutation({
    mutationFn: (e: Entry) => api.delete(`${path(e)}/purge`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: filesKeys.all }),
  });
  const entries: Entry[] = [...(trash.data?.folders ?? []).map((row) => ({ kind: 'folder' as const, row })), ...(trash.data?.files ?? []).map((row) => ({ kind: 'file' as const, row }))];

  return (
    <>
      <PageHeader
        title="Trash"
        description="Restore items you still need. Deleting permanently frees their storage and can’t be undone."
        actions={
          <Button asChild variant="outline">
            <Link to="/files">
              <ArrowLeft /> Back to files
            </Link>
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {trash.isPending ? (
          <SkeletonRows rows={5} cols={4} />
        ) : trash.isError ? (
          <ErrorState error={trash.error} onRetry={() => void trash.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={Trash} title="Trash is empty" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Deleted</TableHead>
                <TableHead className="hidden text-right md:table-cell">Size</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={`${e.kind}-${e.row.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {e.kind === 'folder' ? <FolderIcon restricted={e.row.restricted} size="sm" /> : <FileIcon category={e.row.category} size="sm" />}
                      <span className="truncate font-medium">{e.row.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {e.row.deletedAt ? <time title={formatDateTime(e.row.deletedAt)}>{ago(e.row.deletedAt)}</time> : '—'}
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">{e.kind === 'file' ? formatBytes(e.row.sizeBytes) : '—'}</TableCell>
                  <TableCell className="text-right">
                    {canManage && e.row.canEdit ? (
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => restore.mutate(e)} loading={restore.isPending && restore.variables?.row.id === e.row.id}>
                          <RotateCcw /> Restore
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setPurging(e)}>
                          <Trash /> Delete forever
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <ConfirmDialog
        open={!!purging}
        onOpenChange={(o) => !o && setPurging(null)}
        destructive
        title={`Delete “${purging?.row.name}” forever?`}
        description={purging?.kind === 'folder' ? 'The folder and everything in it are permanently deleted, including all versions.' : 'The file and all its versions are permanently deleted.'}
        confirmLabel="Delete forever"
        onConfirm={async () => {
          if (!purging) return;
          await purge.mutateAsync(purging);
          toast.success('Deleted permanently');
        }}
      />
    </>
  );
}
