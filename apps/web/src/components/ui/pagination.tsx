import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PageMeta } from '@daliz/shared';
import { formatNumber } from '@/lib/utils';
import { Button } from './button';

export function Pagination({ meta, onPageChange, noun = 'results' }: { meta: PageMeta | undefined; onPageChange: (page: number) => void; noun?: string }) {
  if (!meta) return null;
  const pages = Math.max(1, Math.ceil(meta.total / meta.pageSize));
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
      <p aria-live="polite">
        {meta.total === 0 ? `No ${noun}` : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(meta.total)} ${noun}`}
      </p>
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">
          Page {meta.page} of {pages}
        </span>
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(meta.page - 1)} disabled={meta.page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(meta.page + 1)} disabled={meta.page >= pages} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
