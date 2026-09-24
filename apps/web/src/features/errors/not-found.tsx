import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/lib/theme';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <main className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Compass className="size-6" aria-hidden />
        </div>
        <p className="text-sm font-semibold text-primary">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The page you’re looking for doesn’t exist or you don’t have access to it.</p>
        <Button asChild className="mt-6">
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </main>
  );
}
