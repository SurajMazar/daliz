import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

/**
 * Confirmation for destructive or consequential actions. The dialog stays open while the
 * action runs (the confirm button shows a spinner) and closes only when it succeeds.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  typeToConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  /** When set, the user must type this exact text before confirming. */
  typeToConfirm?: string;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState('');
  const blocked = typeToConfirm !== undefined && typed !== typeToConfirm;

  const run = async () => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
      setTyped('');
    } catch {
      // Errors are reported by the caller / global toasts; keep the dialog open.
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        if (!o) setTyped('');
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {typeToConfirm !== undefined ? (
          <div className="grid gap-2">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
            </Label>
            <Input id="confirm-text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogPrimitive.Cancel asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogPrimitive.Cancel>
          <Button variant={destructive ? 'destructive' : 'default'} loading={pending} disabled={blocked} onClick={run}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
