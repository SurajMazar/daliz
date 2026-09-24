import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/**
 * Label + control + hint + error, wired up with ids and aria attributes. The single child
 * control receives id, aria-invalid and aria-describedby automatically.
 */
export function FormField({
  label,
  hint,
  error,
  children,
  className,
  required,
  id: idProp,
  labelAction,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  required?: boolean;
  id?: string;
  labelAction?: ReactNode;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })
    : children;
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {required ? (
            <span className="text-destructive" aria-hidden>
              *
            </span>
          ) : null}
        </Label>
        {labelAction}
      </div>
      {control}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
