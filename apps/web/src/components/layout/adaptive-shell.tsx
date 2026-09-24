import { useAccess } from '@/lib/session';
import { PlatformShell } from './platform-shell';
import { TenantShell } from './tenant-shell';

/** Pages that exist in both worlds (Account) render inside whichever shell fits the session. */
export function AdaptiveShell() {
  const { me } = useAccess();
  if (!me.tenant && me.platform) return <PlatformShell />;
  return <TenantShell />;
}
