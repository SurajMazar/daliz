import { cn } from '@/lib/utils';

export function Progress({ value, max = 1, label, className, tone = 'primary' }: { value: number; max?: number; label: string; className?: string; tone?: 'primary' | 'warning' | 'destructive' | 'success' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className={cn('h-full rounded-full transition-[width]', {
          'bg-primary': tone === 'primary',
          'bg-warning': tone === 'warning',
          'bg-destructive': tone === 'destructive',
          'bg-success': tone === 'success',
        })}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
