import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFolderSchema, fileNameSchema, type FileRow, type FileShareRow, type FolderRow, type ShareTargets, type SignedUrl } from '@daliz/shared';
import { ChevronRight, Download, Folder, FolderLock, Home, Lock, Trash, Upload, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ErrorState } from '@/components/app/error-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage, uploadWithProgress } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useAccess } from '@/lib/session';
import { ago, cn, formatDateTime } from '@/lib/utils';
import { downloadFile, filesKeys, formatBytes, useFolderContents, useShares, useVersions, type Item } from './api';

// ---------------------------------------------------------------------------
// New folder
// ---------------------------------------------------------------------------

type FolderValues = z.input<typeof createFolderSchema>;

export function NewFolderDialog({ parentId, open, onOpenChange }: { parentId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const form = useForm<FolderValues, unknown, z.output<typeof createFolderSchema>>({
    resolver: zodResolver(createFolderSchema),
    defaultValues: { name: '', parentId, visibility: 'workspace' },
  });
  const close = (o: boolean) => {
    if (!o) form.reset({ name: '', parentId, visibility: 'workspace' });
    onOpenChange(o);
  };
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await api.post<FolderRow>('/files/folders', { ...v, parentId });
      toast.success(`Folder “${v.name}” created`);
      void qc.invalidateQueries({ queryKey: filesKeys.all });
      close(false);
    } catch (e) {
      applyServerErrors(e, form.setError, ['name', 'visibility']);
    }
  });
  const visibility = form.watch('visibility');
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <FormField label="Name" required error={form.formState.errors.name?.message}>
            <Input autoFocus maxLength={200} {...form.register('name')} />
          </FormField>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Who can see it</legend>
            {(
              [
                { value: 'workspace', title: 'Everyone in the workspace', text: 'Anyone who can view files can open it.', icon: Users },
                { value: 'restricted', title: 'Restricted', text: 'Only you, admins and people you share it with.', icon: Lock },
              ] as const
            ).map((o) => (
              <label key={o.value} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', visibility === o.value && 'border-primary bg-primary/5')}>
                <input type="radio" value={o.value} className="mt-1 accent-[var(--primary)]" {...form.register('visibility')} />
                <o.icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                <span>
                  <span className="block text-sm font-medium">{o.title}</span>
                  <span className="block text-xs text-muted-foreground">{o.text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

const renameSchema = z.object({ name: fileNameSchema });

export function RenameDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm<z.input<typeof renameSchema>, unknown, z.output<typeof renameSchema>>({ resolver: zodResolver(renameSchema), defaultValues: { name: item.row.name } });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (item.kind === 'file') await api.patch(`/files/${item.row.id}`, { name: v.name, version: item.row.version });
      else await api.patch(`/files/folders/${item.row.id}`, { name: v.name, version: item.row.version });
      toast.success('Renamed');
      void qc.invalidateQueries({ queryKey: filesKeys.all });
      onClose();
    } catch (e) {
      applyServerErrors(e, form.setError, ['name']);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>Rename {item.kind}</DialogTitle>
            {item.kind === 'file' ? <DialogDescription>The file extension can’t change.</DialogDescription> : null}
          </DialogHeader>
          <FormField label="Name" required error={form.formState.errors.name?.message}>
            <Input
              autoFocus
              maxLength={200}
              {...form.register('name')}
              onFocus={(e) => {
                // Select the name without the extension, like a desktop file manager.
                const dot = e.target.value.lastIndexOf('.');
                if (item.kind === 'file' && dot > 0) e.target.setSelectionRange(0, dot);
              }}
            />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Folder picker (move / copy)
// ---------------------------------------------------------------------------

export function FolderPickerDialog({
  title,
  confirmLabel,
  excludeFolderId,
  initialFolderId,
  onPick,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  excludeFolderId?: string;
  initialFolderId: string | null;
  onPick: (folderId: string | null) => Promise<unknown>;
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [pending, setPending] = useState(false);
  const contents = useFolderContents({ folderId: folderId ?? undefined, pageSize: 200, sort: 'name' });
  const data = contents.data;
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose the destination folder.</DialogDescription>
        </DialogHeader>
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted" onClick={() => setFolderId(null)}>
            <Home className="size-3.5" aria-hidden /> Library
          </button>
          {data?.breadcrumbs.map((b) => (
            <span key={b.id} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
              <button type="button" className="rounded px-1 hover:bg-muted" onClick={() => setFolderId(b.id)}>
                {b.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="h-64 overflow-y-auto rounded-lg border">
          {contents.isPending ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : contents.isError ? (
            <ErrorState error={contents.error} className="py-6" />
          ) : data && data.folders.filter((f) => f.id !== excludeFolderId).length === 0 ? (
            <EmptyState icon={Folder} title="No subfolders" className="py-10" />
          ) : (
            <ul>
              {data?.folders
                .filter((f) => f.id !== excludeFolderId)
                .map((f) => (
                  <li key={f.id}>
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={() => setFolderId(f.id)}>
                      {f.restricted ? <FolderLock className="size-4 text-primary" aria-hidden /> : <Folder className="size-4 text-primary" aria-hidden />}
                      <span className="flex-1 truncate">{f.name}</span>
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            loading={pending}
            onClick={async () => {
              setPending(true);
              try {
                await onPick(folderId);
                onClose();
              } catch {
                setPending(false);
              }
            }}
          >
            {confirmLabel} {data?.folder ? `to “${data.folder.name}”` : 'to Library'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

/** People and roles this workspace's files can be shared with. */
function useShareTargets() {
  return useQuery({ queryKey: ['files', 'share-targets'], queryFn: () => api.get<ShareTargets>('/files/share-targets'), staleTime: 5 * 60_000 });
}

export function ShareDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const kind = item.kind;
  const shares = useShares(kind, item.row.id);
  const targets = useShareTargets();
  const [principalType, setPrincipalType] = useState<'user' | 'role'>('user');
  const [principalId, setPrincipalId] = useState('');
  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const base = kind === 'file' ? `/files/${item.row.id}/shares` : `/files/folders/${item.row.id}/shares`;
  const add = useMutation({
    mutationFn: () => api.post<FileShareRow[]>(base, { principalType, principalId, access }),
    onSuccess: (rows) => {
      qc.setQueryData(filesKeys.shares(kind, item.row.id), rows);
      setPrincipalId('');
      toast.success('Shared');
    },
  });
  const remove = useMutation({
    mutationFn: (shareId: string) => api.delete(`${base}/${shareId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: filesKeys.shares(kind, item.row.id) }),
  });
  const options: { id: string; name: string; hint?: string }[] =
    principalType === 'user' ? (targets.data?.users ?? []).map((u) => ({ id: u.id, name: u.name, hint: u.email })) : (targets.data?.roles ?? []);
  const loadingOptions = targets.isPending;
  const restricted = kind === 'folder' ? (item.row as FolderRow).restricted : false;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{item.row.name}”</DialogTitle>
          <DialogDescription>
            {kind === 'folder' && !restricted
              ? 'Everyone in the workspace can already see this folder. Sharing grants edit access or access to restricted content inside it.'
              : 'Give specific people or roles access.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-[110px_minmax(0,1fr)_100px_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (principalId) add.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="share-type" className="text-xs">
              Share with
            </Label>
            <NativeSelect
              id="share-type"
              value={principalType}
              onChange={(e) => {
                setPrincipalType(e.target.value as 'user' | 'role');
                setPrincipalId('');
              }}
            >
              <option value="user">Person</option>
              <option value="role">Role</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="share-who" className="text-xs">
              {principalType === 'user' ? 'Person' : 'Role'}
            </Label>
            <NativeSelect id="share-who" value={principalId} onChange={(e) => setPrincipalId(e.target.value)} disabled={loadingOptions}>
              <option value="">{loadingOptions ? 'Loading…' : options.length ? 'Choose…' : 'None available'}</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.hint ? ` (${p.hint})` : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="share-access" className="text-xs">
              Access
            </Label>
            <NativeSelect id="share-access" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </NativeSelect>
          </div>
          <Button type="submit" disabled={!principalId} loading={add.isPending}>
            Share
          </Button>
        </form>
        <div className="rounded-lg border">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground uppercase">People with access</div>
          {shares.isPending ? (
            <div className="p-3">
              <Skeleton className="h-8" />
            </div>
          ) : shares.isError ? (
            <ErrorState error={shares.error} className="py-6" />
          ) : shares.data.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">Not shared with anyone yet.</p>
          ) : (
            <ul className="divide-y">
              {shares.data.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    {s.principalType === 'role' ? <Users className="size-3.5" aria-hidden /> : <span className="text-[10px] font-semibold">{s.principalName.slice(0, 2).toUpperCase()}</span>}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.principalName}</div>
                    <div className="text-xs text-muted-foreground">{s.principalType === 'role' ? 'Role' : 'Person'} · shared {ago(s.createdAt)}</div>
                  </div>
                  <Badge variant={s.access === 'edit' ? 'info' : 'muted'}>{s.access === 'edit' ? 'Can edit' : 'Can view'}</Badge>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove access for ${s.principalName}`} onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                    <Trash />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export function PreviewDialog({ file, onClose }: { file: FileRow; onClose: () => void }) {
  const preview = useQuery({ queryKey: ['files', 'preview', file.id, file.version], queryFn: () => api.get<SignedUrl>(`/files/${file.id}/preview`), staleTime: 60_000 });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
          <DialogDescription>
            {formatBytes(file.sizeBytes)} · updated {ago(file.updatedAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-[70vh] items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
          {preview.isPending ? (
            <Spinner className="size-6" />
          ) : preview.isError ? (
            <ErrorState error={preview.error} title="Can’t preview this file" />
          ) : file.category === 'pdf' ? (
            <iframe src={preview.data.url} title={`Preview of ${file.name}`} className="size-full bg-white" />
          ) : (
            <img src={preview.data.url} alt={file.name} className="max-h-full max-w-full object-contain" />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void downloadFile(file.id).catch((e: unknown) => toast.error(errorMessage(e)))}>
            <Download /> Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function VersionsSheet({ file, onClose }: { file: FileRow; onClose: () => void }) {
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const versions = useVersions(file.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUpload = file.canEdit && canWrite('files.update');

  const upload = async (f: File) => {
    setError(null);
    setProgress(0);
    const form = new FormData();
    form.append('file', f);
    try {
      await uploadWithProgress<FileRow>(`/files/${file.id}/versions`, form, { onProgress: setProgress });
      toast.success('New version uploaded');
      void qc.invalidateQueries({ queryKey: filesKeys.all });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="max-w-md">
        <div className="border-b p-5 pr-12">
          <SheetTitle className="text-base font-semibold">Version history</SheetTitle>
          <SheetDescription className="truncate text-sm text-muted-foreground">{file.name}</SheetDescription>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {canUpload ? (
            <div className="mb-4 grid gap-2">
              <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={progress !== null}>
                <Upload /> Upload new version
              </Button>
              <input
                ref={inputRef}
                type="file"
                className="sr-only"
                tabIndex={-1}
                accept={`.${file.extension}`}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload(f);
                }}
              />
              {progress !== null ? <Progress value={progress} label="Upload progress" /> : null}
              {error ? <Alert variant="destructive" title={error} /> : null}
              <p className="text-xs text-muted-foreground">New versions must be the same file type (.{file.extension}).</p>
            </div>
          ) : null}
          {versions.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : versions.isError ? (
            <ErrorState error={versions.error} />
          ) : (
            <ol className="grid gap-2">
              {versions.data.map((v) => (
                <li key={v.id} className={cn('flex items-center gap-3 rounded-lg border p-3', v.current && 'border-primary/40 bg-primary/5')}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">v{v.versionNo}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{v.originalName}</span>
                      {v.current ? <Badge variant="info">Current</Badge> : null}
                      {v.scanStatus === 'pending' ? <Badge variant="warning">Scanning…</Badge> : v.scanStatus === 'infected' ? <Badge variant="destructive">Blocked</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(v.sizeBytes)} · {v.uploadedBy?.name ?? 'Unknown'} · <time dateTime={v.createdAt} title={formatDateTime(v.createdAt)}>{ago(v.createdAt)}</time>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Download version ${v.versionNo}`}
                    disabled={v.scanStatus !== 'clean'}
                    onClick={() => void downloadFile(file.id, v.id).catch((e: unknown) => toast.error(errorMessage(e)))}
                  >
                    <Download />
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
