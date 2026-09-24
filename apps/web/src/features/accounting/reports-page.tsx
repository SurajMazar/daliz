import type { StatementSection } from '@daliz/shared';
import { CircleCheck, Printer, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatIsoDate, startOfYear } from '@/lib/dates';
import { useTenantFormat } from '@/lib/tenant-format';
import { cn, humanize } from '@/lib/utils';
import { AccountingTabs } from './accounting-tabs';
import { ACCOUNT_TYPE_LABELS, accountLabel, useBalanceSheet, useIncomeStatement, useLedgerAccounts, useLedgerReport, useTrialBalance } from './api';

type Tab = 'trial-balance' | 'income-statement' | 'balance-sheet' | 'ledger';
const TABS: { value: Tab; label: string }[] = [
  { value: 'trial-balance', label: 'Trial balance' },
  { value: 'income-statement', label: 'Income statement' },
  { value: 'balance-sheet', label: 'Balance sheet' },
  { value: 'ledger', label: 'Account ledger' },
];

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'trial-balance') as Tab;
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader
        title="Reports"
        description="Built from posted entries only."
        actions={
          <Button variant="outline" onClick={() => window.print()} className="print:hidden">
            <Printer /> Print
          </Button>
        }
      />
      <AccountingTabs />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="print:hidden">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="trial-balance">
          <TrialBalanceReport />
        </TabsContent>
        <TabsContent value="income-statement">
          <IncomeStatementReport />
        </TabsContent>
        <TabsContent value="balance-sheet">
          <BalanceSheetReport />
        </TabsContent>
        <TabsContent value="ledger">
          <LedgerReportView initialAccount={params.get('account')} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function DateField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string }) {
  const id = `report-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} type="date" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} className="w-44" />
    </div>
  );
}

function ReportCard({ title, subtitle, controls, balanced, children }: { title: string; subtitle: string; controls: ReactNode; balanced?: boolean; children: ReactNode }) {
  return (
    <Card className="overflow-hidden print:border-0 print:shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3 print:hidden">{controls}</div>
        </div>
        {balanced !== undefined ? (
          <div className="mt-2">
            {balanced ? (
              <Badge variant="success">
                <CircleCheck /> Balanced
              </Badge>
            ) : (
              <Badge variant="destructive">
                <TriangleAlert /> Not balanced
              </Badge>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="px-0 sm:px-0">{children}</CardContent>
    </Card>
  );
}

const num = 'px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap';
const cell = 'px-4 py-2';

function TrialBalanceReport() {
  const fmt = useTenantFormat();
  const [asOf, setAsOf] = useState(fmt.today());
  const report = useTrialBalance(asOf);
  return (
    <ReportCard
      title="Trial balance"
      subtitle={`As of ${formatIsoDate(asOf, { dateStyle: 'long' }, fmt.locale)}`}
      controls={<DateField label="As of" value={asOf} onChange={setAsOf} />}
      balanced={report.data?.balanced}
    >
      {report.isPending ? (
        <SkeletonRows rows={8} cols={4} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : report.data.rows.length === 0 ? (
        <EmptyState title="No posted activity yet" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <th className={cn(cell, 'text-left')}>Account</th>
              <th className={cn(cell, 'hidden text-left md:table-cell')}>Type</th>
              <th className={cn(cell, 'text-right')}>Debit</th>
              <th className={cn(cell, 'text-right')}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {report.data.rows.map((r) => (
              <tr key={r.accountId} className="border-b">
                <td className={cell}>
                  <Link to={`/accounting/reports?tab=ledger&account=${r.accountId}`} className="hover:underline">
                    <span className="font-mono text-xs text-muted-foreground">{r.code}</span> {r.name}
                  </Link>
                </td>
                <td className={cn(cell, 'hidden text-muted-foreground md:table-cell')}>{humanize(r.type)}</td>
                <td className={num}>{zero(r.debit) ? '' : fmt.money(r.debit)}</td>
                <td className={num}>{zero(r.credit) ? '' : fmt.money(r.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold">
              <td className={cell}>Total</td>
              <td className="hidden md:table-cell" />
              <td className={num}>{fmt.money(report.data.totalDebit)}</td>
              <td className={num}>{fmt.money(report.data.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportCard>
  );
}

function Section({ section }: { section: StatementSection }) {
  const fmt = useTenantFormat();
  return (
    <>
      <tr className="bg-muted/40">
        <th colSpan={2} className={cn(cell, 'text-left text-xs font-semibold tracking-wide uppercase')}>
          {section.title}
        </th>
      </tr>
      {section.accounts.length === 0 ? (
        <tr className="border-b">
          <td className={cn(cell, 'pl-8 text-muted-foreground')} colSpan={2}>
            No activity
          </td>
        </tr>
      ) : (
        section.accounts.map((a) => (
          <tr key={a.accountId} className="border-b">
            <td className={cn(cell, 'pl-8')}>
              <span className="font-mono text-xs text-muted-foreground">{a.code}</span> {a.name}
            </td>
            <td className={num}>{fmt.money(a.amount)}</td>
          </tr>
        ))
      )}
      <tr className="border-b font-semibold">
        <td className={cell}>Total {section.title.toLowerCase()}</td>
        <td className={num}>{fmt.money(section.total)}</td>
      </tr>
    </>
  );
}

function IncomeStatementReport() {
  const fmt = useTenantFormat();
  const today = fmt.today();
  const [from, setFrom] = useState(startOfYear(today));
  const [to, setTo] = useState(today);
  const report = useIncomeStatement(from, to);
  return (
    <ReportCard
      title="Income statement"
      subtitle={`${formatIsoDate(from, { dateStyle: 'medium' }, fmt.locale)} – ${formatIsoDate(to, { dateStyle: 'medium' }, fmt.locale)}`}
      controls={
        <>
          <DateField label="From" value={from} max={to} onChange={setFrom} />
          <DateField label="To" value={to} min={from} onChange={setTo} />
        </>
      }
    >
      {report.isPending ? (
        <SkeletonRows rows={8} cols={2} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <table className="w-full text-sm">
          <tbody>
            <Section section={report.data.income} />
            <Section section={report.data.expenses} />
          </tbody>
          <tfoot>
            <tr className="border-t-2 text-base font-semibold">
              <td className={cell}>Net income</td>
              <td className={cn(num, report.data.netIncome.startsWith('-') && 'text-destructive')}>{fmt.money(report.data.netIncome)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportCard>
  );
}

function BalanceSheetReport() {
  const fmt = useTenantFormat();
  const [asOf, setAsOf] = useState(fmt.today());
  const report = useBalanceSheet(asOf);
  return (
    <ReportCard
      title="Balance sheet"
      subtitle={`As of ${formatIsoDate(asOf, { dateStyle: 'long' }, fmt.locale)}`}
      controls={<DateField label="As of" value={asOf} onChange={setAsOf} />}
      balanced={report.data?.balanced}
    >
      {report.isPending ? (
        <SkeletonRows rows={10} cols={2} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <table className="w-full text-sm">
          <tbody>
            <Section section={report.data.assets} />
            <Section section={report.data.liabilities} />
            <Section section={report.data.equity} />
            <tr className="border-b">
              <td className={cn(cell, 'pl-8')}>Current period earnings (not yet closed)</td>
              <td className={num}>{fmt.money(report.data.currentEarnings)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold">
              <td className={cell}>Total assets</td>
              <td className={num}>{fmt.money(report.data.assets.total)}</td>
            </tr>
            <tr className="font-semibold">
              <td className={cell}>Total liabilities and equity</td>
              <td className={num}>{fmt.money(report.data.totalLiabilitiesAndEquity)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportCard>
  );
}

function LedgerReportView({ initialAccount }: { initialAccount: string | null }) {
  const fmt = useTenantFormat();
  const today = fmt.today();
  const accounts = useLedgerAccounts();
  const [accountId, setAccountId] = useState<string | null>(initialAccount);
  const [from, setFrom] = useState(startOfYear(today));
  const [to, setTo] = useState(today);
  const report = useLedgerReport(accountId, from, to);
  const options = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: accountLabel(a), group: ACCOUNT_TYPE_LABELS[a.type] })),
    [accounts.data],
  );
  const selected = accounts.data?.find((a) => a.id === accountId);
  return (
    <ReportCard
      title={selected ? `Ledger · ${selected.code} ${selected.name}` : 'Account ledger'}
      subtitle={`${formatIsoDate(from, { dateStyle: 'medium' }, fmt.locale)} – ${formatIsoDate(to, { dateStyle: 'medium' }, fmt.locale)}`}
      controls={
        <>
          <div className="grid w-64 gap-1.5">
            <Label className="text-xs text-muted-foreground">Account</Label>
            <Combobox aria-label="Account" options={options} value={accountId} onChange={setAccountId} placeholder="Choose an account" searchPlaceholder="Search accounts…" />
          </div>
          <DateField label="From" value={from} max={to} onChange={setFrom} />
          <DateField label="To" value={to} min={from} onChange={setTo} />
        </>
      }
    >
      {!accountId ? (
        <EmptyState title="Choose an account" description="Pick an account to see every posted line and the running balance." />
      ) : report.isPending ? (
        <SkeletonRows rows={8} cols={5} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-y text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <th className={cn(cell, 'text-left')}>Date</th>
                <th className={cn(cell, 'text-left')}>Entry</th>
                <th className={cn(cell, 'text-left')}>Description</th>
                <th className={cn(cell, 'text-right')}>Debit</th>
                <th className={cn(cell, 'text-right')}>Credit</th>
                <th className={cn(cell, 'text-right')}>Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b bg-muted/40 font-medium">
                <td className={cell} colSpan={5}>
                  Opening balance
                </td>
                <td className={num}>{fmt.money(report.data.openingBalance)}</td>
              </tr>
              {report.data.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b">
                  <td className={cn(cell, 'whitespace-nowrap')}>{formatIsoDate(l.entryDate, undefined, fmt.locale)}</td>
                  <td className={cn(cell, 'font-mono text-xs whitespace-nowrap')}>
                    <Link to={`/accounting/entries/${l.entryId}`} className="text-primary hover:underline">
                      {l.number}
                    </Link>
                  </td>
                  <td className={cell}>
                    {l.description}
                    {l.lineDescription ? <div className="text-xs text-muted-foreground">{l.lineDescription}</div> : null}
                  </td>
                  <td className={num}>{zero(l.debit) ? '' : fmt.money(l.debit)}</td>
                  <td className={num}>{zero(l.credit) ? '' : fmt.money(l.credit)}</td>
                  <td className={num}>{fmt.money(l.balance)}</td>
                </tr>
              ))}
              {report.data.lines.length === 0 ? (
                <tr className="border-b">
                  <td className={cn(cell, 'text-muted-foreground')} colSpan={6}>
                    No posted lines in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-semibold">
                <td className={cell} colSpan={5}>
                  Closing balance
                </td>
                <td className={num}>{fmt.money(report.data.closingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </ReportCard>
  );
}

function zero(v: string): boolean {
  return /^-?0+(\.0+)?$/.test(v);
}
