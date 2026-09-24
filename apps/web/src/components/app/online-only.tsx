import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { useIsOffline } from '@/offline/connectivity';

const MESSAGE = 'Needs a connection — you’re offline';

/**
 * Wraps an action that must reach the server (financial transitions, admin changes, uploads,
 * destructive file operations). Offline, the control is disabled and explains why.
 */
export function OnlineOnly({ children }: { children: ReactNode }) {
  const offline = useIsOffline();
  const child = Children.only(children);
  if (!offline || !isValidElement(child)) return <>{children}</>;
  const disabled = cloneElement(
    child as ReactElement<{ disabled?: boolean; 'aria-disabled'?: boolean }>,
    { disabled: true, 'aria-disabled': true },
  );
  return (
    <Tooltip content={MESSAGE}>
      {/* A disabled button gets no pointer events, so the tooltip hangs off a focusable wrapper. */}
      <span tabIndex={0} className="inline-flex" aria-label={MESSAGE}>
        {disabled}
      </span>
    </Tooltip>
  );
}

export function useOnlineOnlyTitle(): string | undefined {
  return useIsOffline() ? MESSAGE : undefined;
}
