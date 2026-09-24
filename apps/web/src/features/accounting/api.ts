import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AccountingSettings,
  BalanceSheet,
  IncomeStatement,
  JournalEntryRow,
  JournalStatus,
  LedgerAccountRow,
  LedgerAccountType,
  LedgerReport,
  TrialBalance,
} from '@daliz/shared';
import { api, type Query } from '@/lib/api';

export type AccountingSettingsRow = AccountingSettings & { version: number };

export const ACCOUNT_TYPE_LABELS: Record<LedgerAccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

export const JOURNAL_STATUS_LABELS: Record<JournalStatus, string> = {
  draft: 'Draft',
  pending: 'Pending approval',
  approved: 'Approved',
  posted: 'Posted',
  reversed: 'Reversed',
};

export const accountingKeys = {
  all: ['accounting'] as const,
  accounts: ['accounting', 'accounts'] as const,
  entries: (q: Query) => ['accounting', 'entries', q] as const,
  entriesAll: ['accounting', 'entries'] as const,
  entry: (id: string) => ['accounting', 'entry', id] as const,
  settings: ['accounting', 'settings'] as const,
  report: (kind: string, q: Query) => ['accounting', 'report', kind, q] as const,
};

export function useLedgerAccounts() {
  return useQuery({ queryKey: accountingKeys.accounts, queryFn: () => api.get<LedgerAccountRow[]>('/accounting/accounts') });
}

export function useJournalEntries(q: Query) {
  return useQuery({
    queryKey: accountingKeys.entries(q),
    queryFn: () => api.list<JournalEntryRow>('/accounting/journal-entries', q),
    placeholderData: keepPreviousData,
  });
}

export function useJournalEntry(id: string | undefined) {
  return useQuery({
    queryKey: accountingKeys.entry(id ?? 'none'),
    queryFn: () => api.get<JournalEntryRow>(`/accounting/journal-entries/${id}`),
    enabled: !!id,
  });
}

export function useAccountingSettings(enabled = true) {
  return useQuery({ queryKey: accountingKeys.settings, queryFn: () => api.get<AccountingSettingsRow>('/accounting/settings'), enabled });
}

export function useTrialBalance(asOf: string) {
  return useQuery({
    queryKey: accountingKeys.report('trial-balance', { asOf }),
    queryFn: () => api.get<TrialBalance>('/accounting/reports/trial-balance', { asOf }),
    enabled: !!asOf,
  });
}

export function useIncomeStatement(from: string, to: string) {
  return useQuery({
    queryKey: accountingKeys.report('income-statement', { from, to }),
    queryFn: () => api.get<IncomeStatement>('/accounting/reports/income-statement', { from, to }),
    enabled: !!from && !!to && from <= to,
  });
}

export function useBalanceSheet(asOf: string) {
  return useQuery({
    queryKey: accountingKeys.report('balance-sheet', { asOf }),
    queryFn: () => api.get<BalanceSheet>('/accounting/reports/balance-sheet', { asOf }),
    enabled: !!asOf,
  });
}

export function useLedgerReport(accountId: string | null, from: string, to: string) {
  return useQuery({
    queryKey: accountingKeys.report('ledger', { accountId, from, to }),
    queryFn: () => api.get<LedgerReport>(`/accounting/reports/ledger/${accountId}`, { from, to }),
    enabled: !!accountId && !!from && !!to && from <= to,
  });
}

export function accountLabel(a: { code: string; name: string }): string {
  return `${a.code} · ${a.name}`;
}
