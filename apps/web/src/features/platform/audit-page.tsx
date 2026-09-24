import { AuditLogView } from '@/components/app/audit-log';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { platformKeys } from './api';

export function PlatformAuditPage() {
  return (
    <>
      <PageHeader title="Platform audit log" description="Actions taken by platform administrators, support sessions and the system." />
      <Card className="overflow-hidden">
        <AuditLogView queryKey={platformKeys.audit} path="/platform/audit" />
      </Card>
    </>
  );
}
