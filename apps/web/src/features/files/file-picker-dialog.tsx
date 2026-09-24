import type { FileRow } from '@daliz/shared';
import { ChevronRight, FileQuestionMark, Home, Search } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/app/error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { formatBytes, useFolderContents } from './api';
import { FileIcon, FolderIcon } from './file-icon';

/** Browse or search the library and pick one file (used for task attachments). */
export function FilePickerDialog({ title = 'Attach a file', exclude = [], onPick, onClose }: { title?: string; exclude?: string[]; onPick: (file: FileRow) => Promise<unknown>; onClose: () => void }) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<FileRow | null>(null);
  const [pending, setPending] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const contents = useFolderContents({ folderId: q ? undefined : (folderId ?? undefined), q: q || undefined, pageSize: 200, sort: 'name' });
  const data = contents.data;
  const files = (data?.files ?? []).filter((f) => !exclude.includes(f.id));

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose a file from the library. Only files you can see are listed.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search files" placeholder="Search the library…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        </div>
        {!q ? (
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
        ) : null}
        <div className="h-72 overflow-y-auto rounded-lg border" role="listbox" aria-label="Files">
          {contents.isPending ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : contents.isError ? (
            <ErrorState error={contents.error} className="py-6" />
          ) : (q ? [] : (data?.folders ?? [])).length === 0 && files.length === 0 ? (
            <EmptyState icon={FileQuestionMark} title={q ? 'No files match' : 'Nothing here'} className="py-10" />
          ) : (
            <ul>
              {!q
                ? data?.folders.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => setFolderId(f.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                        <FolderIcon restricted={f.restricted} size="sm" />
                        <span className="flex-1 truncate">{f.name}</span>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </button>
                    </li>
                  ))
                : null}
              {files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected?.id === f.id}
                    onClick={() => setSelected(f)}
                    onDoubleClick={() => setSelected(f)}
                    className={cn('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none', selected?.id === f.id && 'bg-primary/10')}
                  >
                    <FileIcon category={f.category} size="sm" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
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
            disabled={!selected}
            loading={pending}
            onClick={async () => {
              if (!selected) return;
              setPending(true);
              try {
                await onPick(selected);
                onClose();
              } catch {
                setPending(false);
              }
            }}
          >
            Attach {selected ? `“${selected.name}”` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
