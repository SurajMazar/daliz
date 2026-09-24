import { AuditLogView } from '@/components/app/audit-log';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';

export function AuditPage() {
  return (
    <>
      <PageHeader title="Audit log" description="Every security-relevant action in this workspace, including support sessions opened by your provider." />
      <Card className="overflow-hidden">
        <AuditLogView queryKey={['tenant', 'audit']} path="/audit" />
      </Card>
    </>
  );
}
