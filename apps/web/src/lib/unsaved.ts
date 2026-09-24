import { useEffect, useId } from 'react';

/** Registry of forms with unsaved edits, so updates/reloads never discard someone's work. */
const dirty = new Set<string>();

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.size) {
    e.preventDefault();
    e.returnValue = '';
  }
}

export function useUnsavedChanges(isDirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (isDirty) dirty.add(id);
    else dirty.delete(id);
    if (dirty.size) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
    return () => {
      dirty.delete(id);
      if (!dirty.size) window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [id, isDirty]);
}
