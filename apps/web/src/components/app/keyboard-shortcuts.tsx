import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isEditableTarget, SHORTCUTS, triggerShortcut } from '@/lib/shortcuts';

function focusSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>('main input[type="search"]');
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

/** Global shortcuts (the command palette handles ⌘/Ctrl K itself). */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const editable = isEditableTarget(e.target);
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && (key === '/' || e.code === 'Slash')) {
        if (triggerShortcut('search') || focusSearch()) e.preventDefault();
        return;
      }
      if (mod && e.shiftKey && key === 'f') {
        e.preventDefault();
        if (location.pathname.startsWith('/files')) focusSearch();
        else {
          navigate('/files');
          window.setTimeout(focusSearch, 400);
        }
        return;
      }
      if (editable) return;
      if ((mod || e.altKey) && !e.shiftKey && (key === 'n' || e.code === 'KeyN')) {
        if (triggerShortcut('new')) {
          e.preventDefault();
          return;
        }
        if (location.pathname.startsWith('/accounting')) {
          e.preventDefault();
          navigate('/accounting/entries/new');
        }
        return;
      }
      if (e.key === '?' && e.shiftKey && !mod) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, location.pathname]);

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts don’t fire while you’re typing in a field (except search).
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between gap-4 border-b pb-2 last:border-0"
            >
              <dt className="text-muted-foreground">{s.description}</dt>
              <dd>
                <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                  {s.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
