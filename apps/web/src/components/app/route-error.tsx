import { CircleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { isApiError } from '@/lib/api';
import { NotFoundPage } from '@/features/errors/not-found';

/** Router error boundary: unexpected render errors land here instead of a blank page. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const requestId = isApiError(error) ? error.requestId : null;
  const message = isApiError(error)
    ? error.message
    : isRouteErrorResponse(error)
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : 'An unexpected error occurred.';
  if (import.meta.env.DEV) console.error(error);
  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <div role="alert" className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <CircleAlert className="size-6" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        {requestId ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Request ID: <code className="font-mono select-all">{requestId}</code>
          </p>
        ) : null}
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button asChild>
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
