import type { AssignableRole } from '@daliz/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Accessible multi-select of roles (a labelled group of checkboxes). */
export function RoleChecklist({
  roles,
  loading,
  value,
  onChange,
  disabled,
  error,
  labelledBy,
}: {
  roles: AssignableRole[] | undefined;
  loading?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  error?: string;
  labelledBy?: string;
}) {
  if (loading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby={labelledBy} aria-invalid={error ? true : undefined} className="grid gap-1.5">
      <div className={cn('max-h-64 overflow-y-auto rounded-lg border', error && 'border-destructive')}>
        {(roles ?? []).map((r) => {
          const checked = value.includes(r.id);
          const id = `role-${r.id}`;
          return (
            <label
              key={r.id}
              htmlFor={id}
              className={cn('flex cursor-pointer items-start gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/50', checked && 'bg-primary/5')}
            >
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                onCheckedChange={(c) => onChange(c === true ? [...value, r.id] : value.filter((v) => v !== r.id))}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {r.name}
                  {r.key === null ? <span className="ml-2 text-xs font-normal text-muted-foreground">Custom</span> : null}
                </span>
                {r.description ? <span className="block text-xs text-muted-foreground">{r.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
