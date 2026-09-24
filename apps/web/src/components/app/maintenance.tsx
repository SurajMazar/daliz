import { Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setAppState } from '@/lib/app-state';
import { refreshMe } from '@/lib/session';

export function MaintenanceScreen({ message }: { message: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl bg-warning/10 text-warning">
          <Wrench className="size-7" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">We’ll be right back</h1>
        <p className="mt-3 text-muted-foreground">{message || 'Daliz is undergoing scheduled maintenance.'}</p>
        <Button
          className="mt-8"
          variant="outline"
          onClick={() => {
            setAppState({ maintenance: null });
            void refreshMe().catch(() => undefined);
          }}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
