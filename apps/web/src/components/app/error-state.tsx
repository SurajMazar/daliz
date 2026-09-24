import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Inline error for a failed query, with the request id for support and a retry button. */
export function ErrorState({ error, onRetry, className, title = 'Couldn’t load this' }: { error: unknown; onRetry?: () => void; className?: string; title?: string }) {
  const requestId = isApiError(error) ? error.requestId : null;
  const forbidden = isApiError(error) && error.code === 'FORBIDDEN';
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <CircleAlert className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{forbidden ? 'You don’t have access to this' : title}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
        {requestId ? (
          <p className="text-xs text-muted-foreground">
            Request ID: <code className="font-mono select-all">{requestId}</code>
          </p>
        ) : null}
      </div>
      {onRetry && !forbidden ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      ) : null}
    </div>
  );
}
