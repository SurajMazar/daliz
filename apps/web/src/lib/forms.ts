import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError, errorMessage } from './api';

/**
 * Maps a server VALIDATION_FAILED error onto form fields where the path matches a field,
 * and toasts anything that couldn't be placed. Returns true if at least one field got an error.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
  opts: { toastUnmatched?: boolean } = {},
): boolean {
  const toastUnmatched = opts.toastUnmatched ?? true;
  if (!(error instanceof ApiError)) {
    if (toastUnmatched) toast.error(errorMessage(error));
    return false;
  }
  let matched = false;
  const unmatched: string[] = [];
  for (const d of error.details) {
    const field = fields.find((f) => d.path === f || d.path.startsWith(`${f}.`));
    if (field) {
      setError(field as Path<T>, { type: 'server', message: d.message });
      matched = true;
    } else {
      unmatched.push(d.path && d.path !== '(root)' ? `${d.path}: ${d.message}` : d.message);
    }
  }
  if (toastUnmatched && (!matched || unmatched.length)) {
    toast.error(error.message, unmatched.length ? { description: unmatched.join(' · ') } : undefined);
  }
  return matched;
}
