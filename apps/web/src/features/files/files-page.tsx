import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FILE_CATEGORIES, fileTypeForName, type FileRow } from '@daliz/shared';
import {
  ArrowDownUp,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  Eye,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Home,
  LayoutGrid,
  List,
  Lock,
  Pencil,
  Search,
  Share2,
  ShieldAlert,
  Trash,
  Upload,
  X,
  Clock,
  Layers,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbTail } from '@/components/layout/breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { api, errorMessage, isApiError, uploadWithProgress } from '@/lib/api';
import { useDebouncedValue } from '@/lib/hooks';
import { useAccess } from '@/lib/session';
import { ago, cn, formatDateTime, humanize } from '@/lib/utils';
import { downloadFile, filesKeys, formatBytes, MAX_UPLOAD_BYTES, useFolderContents, useStorageUsage, type Item } from './api';
import { FolderPickerDialog, NewFolderDialog, PreviewDialog, RenameDialog, ShareDialog, VersionsSheet } from './dialogs';
import { FileIcon, FolderIcon } from './file-icon';

type ViewMode = 'grid' | 'list';
const VIEW_KEY = 'daliz.files.view';

interface UploadTask {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

type Dialog =
  | { kind: 'rename' | 'share' | 'move' | 'copy' | 'trash'; item: Item }
  | { kind: 'preview' | 'versions'; file: FileRow }
  | null;

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function FilesPage() {
  const { folderId } = useParams();
  const { canWrite } = useAccess();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [view, setViewState] = useState<ViewMode>(readView);
  const [sort, setSort] = useState<'name' | 'size' | 'updated'>('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebouncedValue(search.trim(), 300);

  useEffect(() => {
    setSearch('');
    setCategory('');
  }, [folderId]);

  const contents = useFolderContents({ folderId, q: q || undefined, category: category || undefined, sort, order, pageSize: 200 });
  const usage = useStorageUsage();
  const data = contents.data;
  const folder = data?.folder ?? null;
  useBreadcrumbTail(folder?.name ?? null);

  const setView = (v: ViewMode) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Preference only lasts this visit.
    }
  };

  const canUploadHere = canWrite('files.upload') && (folder ? folder.canEdit : true);
  const searching = !!(q || category);

  const invalidate = useCallback(() => void qc.invalidateQueries({ queryKey: filesKeys.all }), [qc]);

  const startUploads = (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const f of list) {
      const id = crypto.randomUUID();
      const known = fileTypeForName(f.name);
      const problem = !known ? 'This file type isn’t allowed.' : f.size > MAX_UPLOAD_BYTES ? `Larger than ${formatBytes(MAX_UPLOAD_BYTES)}.` : f.size === 0 ? 'The file is empty.' : null;
      setUploads((u) => [...u, { id, name: f.name, size: f.size, progress: 0, status: problem ? 'error' : 'uploading', error: problem ?? undefined }]);
      if (problem) continue;
      const form = new FormData();
      if (folderId) form.append('folderId', folderId);
      form.append('file', f);
      uploadWithProgress<FileRow>('/files/upload', form, { onProgress: (p) => setUploads((u) => u.map((t) => (t.id === id ? { ...t, progress: p } : t))) })
        .then(() => {
          setUploads((u) => u.map((t) => (t.id === id ? { ...t, progress: 1, status: 'done' } : t)));
          invalidate();
        })
        .catch((e: unknown) => setUploads((u) => u.map((t) => (t.id === id ? { ...t, status: 'error', error: errorMessage(e) } : t))));
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!canUploadHere) return;
    if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
  };

  const trash = useMutation({
    mutationFn: (item: Item) => (item.kind === 'file' ? api.delete(`/files/${item.row.id}`) : api.delete(`/files/folders/${item.row.id}`)),
    onSuccess: (_d, item) => {
      invalidate();
      toast.success(`Moved “${item.row.name}” to trash`, { action: { label: 'View trash', onClick: () => navigate('/files/trash') } });
    },
  });

  const open = (item: Item) => {
    if (item.kind === 'folder') navigate(`/files/folder/${item.row.id}`);
    else if (item.row.previewable && item.row.scanStatus === 'clean') setDialog({ kind: 'preview', file: item.row });
    else void downloadFile(item.row.id).catch((e: unknown) => toast.error(errorMessage(e)));
  };

  const items: Item[] = [...(data?.folders ?? []).map((row) => ({ kind: 'folder' as const, row })), ...(data?.files ?? []).map((row) => ({ kind: 'file' as const, row }))];

  return (
    <div
      onDragEnter={(e) => {
        if (!canUploadHere || !e.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!canUploadHere || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      className="relative"
    >
      <PageHeader
        title={folder?.name ?? 'Files'}
        description={folder ? (folder.restricted ? 'Restricted folder — only people with access can see it.' : undefined) : 'Your workspace’s shared document library.'}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link to="/files/trash">
                <Trash /> Trash
              </Link>
            </Button>
            {canUploadHere ? (
              <>
                <Button variant="outline" onClick={() => setNewFolderOpen(true)}>
                  <FolderPlus /> New folder
                </Button>
                <Button onClick={() => inputRef.current?.click()}>
                  <Upload /> Upload
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => {
                    if (e.target.files?.length) startUploads(e.target.files);
                    e.target.value = '';
                  }}
                />
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <Link to="/files" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Home className="size-3.5" aria-hidden /> Library
          </Link>
          {data?.breadcrumbs.map((b, i) => (
            <span key={b.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {i === data.breadcrumbs.length - 1 ? (
                <span className="truncate px-1.5 font-medium" aria-current="page">
                  {b.name}
                </span>
              ) : (
                <Link to={`/files/folder/${b.id}`} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                  {b.name}
                </Link>
              )}
            </span>
          ))}
          {folder?.restricted ? (
            <Badge variant="outline" className="ml-1">
              <Lock /> Restricted
            </Badge>
          ) : null}
        </nav>
        <UsageMeter usedBytes={usage.data?.usedBytes} quotaBytes={usage.data?.quotaBytes} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              aria-label={folderId ? 'Search this folder' : 'Search the library'}
              placeholder={folderId ? 'Search this folder…' : 'Search the whole library…'}
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label="File type" value={category} onChange={(e) => setCategory(e.target.value)} className="w-40">
              <option value="">All types</option>
              {FILE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c === 'pdf' ? 'PDF' : humanize(c)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-36">
              <option value="name">Name</option>
              <option value="updated">Last updated</option>
              <option value="size">Size</option>
            </NativeSelect>
            <Tooltip content={order === 'asc' ? 'Ascending' : 'Descending'}>
              <Button variant="outline" size="icon" aria-label={`Sort ${order === 'asc' ? 'descending' : 'ascending'}`} onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}>
                <ArrowDownUp className={cn(order === 'desc' && 'rotate-180')} />
              </Button>
            </Tooltip>
            <div role="radiogroup" aria-label="View" className="flex rounded-md border p-0.5">
              <Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon-sm" role="radio" aria-checked={view === 'grid'} aria-label="Grid view" onClick={() => setView('grid')}>
                <LayoutGrid />
              </Button>
              <Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon-sm" role="radio" aria-checked={view === 'list'} aria-label="List view" onClick={() => setView('list')}>
                <List />
              </Button>
            </div>
          </div>
        </div>

        {contents.isPending ? (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : contents.isError ? (
          <ErrorState error={contents.error} onRetry={() => void contents.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title={searching ? 'Nothing matches your search' : folder ? 'This folder is empty' : 'Your library is empty'}
            description={searching ? undefined : canUploadHere ? 'Drag files here or use Upload.' : undefined}
            action={
              !searching && canUploadHere ? (
                <Button size="sm" onClick={() => inputRef.current?.click()}>
                  <Upload /> Upload files
                </Button>
              ) : null
            }
          />
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-label="Files and folders">
            {items.map((item) => (
              <li key={`${item.kind}-${item.row.id}`}>
                <GridCard item={item} onOpen={() => open(item)} menu={<ItemMenu item={item} onOpen={() => open(item)} onAction={setDialog} />} />
              </li>
            ))}
          </ul>
        ) : (
          <Table aria-busy={contents.isFetching || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Owner</TableHead>
                <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={`${item.kind}-${item.row.id}`} onDoubleClick={() => open(item)}>
                  <TableCell>
                    <button type="button" onClick={() => open(item)} className="flex max-w-full items-center gap-3 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {item.kind === 'folder' ? <FolderIcon restricted={item.row.restricted} size="sm" /> : <FileIcon category={item.row.category} size="sm" />}
                      <span className="truncate font-medium">{item.row.name}</span>
                      <ItemBadges item={item} />
                    </button>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{item.row.createdBy?.name ?? '—'}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                    <time dateTime={item.row.createdAt} title={formatDateTime(item.row.createdAt)}>
                      {formatDateTime(item.row.createdAt)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap text-muted-foreground tabular-nums">{item.kind === 'file' ? formatBytes(item.row.sizeBytes) : '—'}</TableCell>
                  <TableCell>
                    <ItemMenu item={item} onOpen={() => open(item)} onAction={setDialog} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {data && data.meta.total > data.meta.pageSize ? (
          <p className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing the first {data.meta.pageSize} of {data.meta.total} items. Refine your search to see others.
          </p>
        ) : null}
      </Card>

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
            <Upload className="mx-auto mb-2 size-6 text-primary" aria-hidden />
            <p className="font-medium">Drop to upload to {folder?.name ?? 'the library'}</p>
          </div>
        </div>
      ) : null}

      <UploadPanel tasks={uploads} onDismiss={() => setUploads((u) => u.filter((t) => t.status === 'uploading'))} />

      <NewFolderDialog parentId={folderId ?? null} open={newFolderOpen} onOpenChange={setNewFolderOpen} />
      {dialog?.kind === 'rename' ? <RenameDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'share' ? <ShareDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'preview' ? <PreviewDialog file={dialog.file} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'versions' ? <VersionsSheet file={dialog.file} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'move' || dialog?.kind === 'copy' ? (
        <FolderPickerDialog
          title={`${dialog.kind === 'move' ? 'Move' : 'Copy'} “${dialog.item.row.name}”`}
          confirmLabel={dialog.kind === 'move' ? 'Move' : 'Copy'}
          excludeFolderId={dialog.item.kind === 'folder' ? dialog.item.row.id : undefined}
          initialFolderId={folderId ?? null}
          onClose={() => setDialog(null)}
          onPick={async (target) => {
            const { item } = dialog;
            try {
              if (dialog.kind === 'copy') await api.post(`/files/${item.row.id}/copy`, { folderId: target });
              else if (item.kind === 'file') await api.patch(`/files/${item.row.id}`, { folderId: target, version: item.row.version });
              else await api.patch(`/files/folders/${item.row.id}`, { parentId: target, version: item.row.version });
              toast.success(dialog.kind === 'copy' ? 'Copied' : 'Moved');
              invalidate();
            } catch (e) {
              if (!isApiError(e) || e.code !== 'VERSION_CONFLICT') toast.error(errorMessage(e));
              throw e;
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === 'trash'}
        onOpenChange={(o) => !o && setDialog(null)}
        destructive
        title={dialog?.kind === 'trash' ? `Move “${dialog.item.row.name}” to trash?` : ''}
        description={dialog?.kind === 'trash' && dialog.item.kind === 'folder' ? 'Everything inside the folder goes with it. You can restore it from the trash.' : 'You can restore it from the trash.'}
        confirmLabel="Move to trash"
        onConfirm={async () => {
          if (dialog?.kind === 'trash') await trash.mutateAsync(dialog.item);
        }}
      />
    </div>
  );
}

function ItemBadges({ item }: { item: Item }) {
  if (item.kind === 'folder') {
    return item.row.visibility === 'restricted' ? (
      <Tooltip content="Restricted folder">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Restricted" />
      </Tooltip>
    ) : null;
  }
  const f = item.row;
  return (
    <>
      {f.scanStatus === 'pending' ? (
        <Badge variant="warning" className="shrink-0">
          <Clock /> Scanning…
        </Badge>
      ) : f.scanStatus === 'infected' ? (
        <Badge variant="destructive" className="shrink-0">
          <ShieldAlert /> Blocked
        </Badge>
      ) : f.scanStatus === 'error' ? (
        <Badge variant="muted" className="shrink-0">
          Scan failed
        </Badge>
      ) : null}
      {f.versionCount > 1 ? (
        <Badge variant="muted" className="shrink-0">
          v{f.versionCount}
        </Badge>
      ) : null}
    </>
  );
}

function GridCard({ item, onOpen, menu }: { item: Item; onOpen: () => void; menu: ReactNode }) {
  return (
    <div className="group relative flex h-full flex-col rounded-lg border bg-card transition-colors hover:border-primary/40 hover:bg-muted/30">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col items-start gap-3 rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {item.kind === 'folder' ? <FolderIcon restricted={item.row.restricted} size="lg" /> : <FileIcon category={item.row.category} size="lg" />}
        <div className="w-full min-w-0 pr-6">
          <div className="truncate text-sm font-medium" title={item.row.name}>
            {item.row.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {item.kind === 'file' ? <span>{formatBytes(item.row.sizeBytes)}</span> : <span>Folder</span>}
            <span aria-hidden>·</span>
            <time dateTime={item.row.createdAt} title={`Uploaded ${formatDateTime(item.row.createdAt)}`}>{ago(item.row.createdAt)}</time>
          </div>
          <div className="truncate text-xs text-muted-foreground" title={item.row.createdBy?.name ?? undefined}>
            {item.row.createdBy ? `by ${item.row.createdBy.name}` : '\u00a0'}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <ItemBadges item={item} />
          </div>
        </div>
      </button>
      <div className="absolute top-2 right-2">{menu}</div>
    </div>
  );
}

function ItemMenu({ item, onOpen, onAction }: { item: Item; onOpen: () => void; onAction: (d: Dialog) => void }) {
  const { can, canWrite, me, readOnly } = useAccess();
  const editable = item.row.canEdit;
  const file = item.kind === 'file' ? item.row : null;
  const clean = file?.scanStatus === 'clean';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.row.name}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onOpen}>
          {item.kind === 'folder' ? <FolderOpen /> : file?.previewable ? <Eye /> : <Download />} {item.kind === 'folder' ? 'Open' : file?.previewable ? 'Preview' : 'Download'}
        </DropdownMenuItem>
        {file ? (
          <>
            {file.previewable ? (
              <DropdownMenuItem disabled={!clean} onSelect={() => void downloadFile(file.id).catch((e: unknown) => toast.error(errorMessage(e)))}>
                <Download /> Download
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onAction({ kind: 'versions', file })}>
              <Layers /> Versions ({file.versionCount})
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        {editable && canWrite('files.update') ? (
          <>
            <DropdownMenuItem onSelect={() => onAction({ kind: 'rename', item })}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ kind: 'move', item })}>
              <FolderInput /> Move…
            </DropdownMenuItem>
          </>
        ) : null}
        {file && canWrite('files.upload') ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'copy', item })}>
            <Copy /> Copy…
          </DropdownMenuItem>
        ) : null}
        {!readOnly && (can('files.share') || item.row.createdBy?.id === me.tenant?.userId) ? (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'share', item })}>
            <Share2 /> Share…
          </DropdownMenuItem>
        ) : null}
        {editable && canWrite('files.delete') ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onAction({ kind: 'trash', item })}>
              <Trash /> Move to trash
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageMeter({ usedBytes, quotaBytes }: { usedBytes?: number; quotaBytes?: number }) {
  if (usedBytes === undefined || !quotaBytes) return <Skeleton className="h-8 w-56" />;
  const ratio = usedBytes / quotaBytes;
  return (
    <div className="w-full shrink-0 lg:w-64">
      <div className="mb-1 flex justify-between text-xs text-muted-foreground">
        <span>Storage</span>
        <span className="tabular-nums">
          {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}
        </span>
      </div>
      <Progress value={usedBytes} max={quotaBytes} label="Storage used" tone={ratio > 0.9 ? 'destructive' : ratio > 0.75 ? 'warning' : 'primary'} />
    </div>
  );
}

function UploadPanel({ tasks, onDismiss }: { tasks: UploadTask[]; onDismiss: () => void }) {
  if (tasks.length === 0) return null;
  const active = tasks.filter((t) => t.status === 'uploading').length;
  return (
    <section aria-label="Uploads" className="fixed right-4 bottom-4 z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover shadow-xl">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold" aria-live="polite">
          {active ? `Uploading ${active} file${active === 1 ? '' : 's'}…` : 'Uploads finished'}
        </h2>
        {active === 0 ? (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss uploads" onClick={onDismiss}>
            <X />
          </Button>
        ) : null}
      </header>
      <ul className="max-h-72 divide-y overflow-y-auto">
        {tasks.map((t) => (
          <li key={t.id} className="grid gap-1.5 px-4 py-2.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{t.name}</span>
              <span className={cn('shrink-0 text-xs', t.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {t.status === 'done' ? 'Done' : t.status === 'error' ? 'Failed' : `${Math.round(t.progress * 100)}%`}
              </span>
            </div>
            {t.status === 'uploading' ? <Progress value={t.progress} label={`Uploading ${t.name}`} /> : null}
            {t.error ? (
              <p className="text-xs text-destructive" role="alert">
                {t.error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

