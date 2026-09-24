import { Outlet, ScrollRestoration } from 'react-router';
import { Toaster } from 'sonner';
import { ApiErrorBridge } from '@/components/app/api-error-bridge';
import { ConnectivityManager } from '@/components/app/connectivity';
import { MaintenanceScreen } from '@/components/app/maintenance';
import { StepUpDialog } from '@/components/app/step-up-dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppState } from '@/lib/app-state';
import { useTheme } from '@/lib/theme';

export function Root() {
  const { maintenance } = useAppState();
  const { mode } = useTheme();
  return (
    <TooltipProvider delayDuration={300}>
      <ApiErrorBridge />
      <ConnectivityManager />
      {maintenance !== null ? <MaintenanceScreen message={maintenance} /> : <Outlet />}
      <StepUpDialog />
      <Toaster
        theme={mode}
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ className: 'font-sans' }}
        containerAriaLabel="Notifications"
      />
      <ScrollRestoration />
    </TooltipProvider>
  );
}
