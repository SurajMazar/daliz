import { useEffect, useRef } from 'react';

/** Context-dependent shortcut actions that the current page can claim. */
export type ShortcutAction = 'new' | 'search';

const handlers = new Map<ShortcutAction, Set<{ current: () => unknown }>>();

export function useShortcutAction(action: ShortcutAction, fn: () => unknown): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const set = handlers.get(action) ?? new Set();
    handlers.set(action, set);
    set.add(ref);
    return () => void set.delete(ref);
  }, [action]);
}

/** Runs the most recently registered handler; false if the page doesn't handle the action. */
export function triggerShortcut(action: ShortcutAction): boolean {
  const set = handlers.get(action);
  if (!set?.size) return false;
  [...set].at(-1)!.current();
  return true;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return false;
}

export const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: '⌘/Ctrl K', description: 'Command palette' },
  { keys: '⌘/Ctrl /', description: 'Focus the search box on this page' },
  { keys: '⌘/Ctrl ⇧ F', description: 'Search files' },
  { keys: '⌘/Ctrl N or Alt N', description: 'New item here (task, entry, event)' },
  { keys: 'Esc', description: 'Close dialogs and panels' },
  { keys: '⇧ ?', description: 'Show keyboard shortcuts' },
];
