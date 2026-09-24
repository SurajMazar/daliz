import { Injectable } from '@nestjs/common';
import {
  DEBIT_NORMAL,
  fromUnits,
  normalizeMoney,
  toUnits,
  type BalanceSheet,
  type IncomeStatement,
  type LedgerAccountType,
  type LedgerReport,
  type StatementSection,
  type TrialBalance,
} from '@daliz/shared';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { journalEntries, journalLines, ledgerAccounts } from '../../database/tenant/schema.js';

/** Posted activity only. A reversed entry still counts; its reversal offsets it. */
const POSTED = inArray(journalEntries.status, ['posted', 'reversed']);

interface AccountTotals {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  subtype: string;
  debit: bigint;
  credit: bigint;
}

/** Balance in the account's normal direction (positive = normal). */
const normal = (a: { type: LedgerAccountType; debit: bigint; credit: bigint }) =>
  DEBIT_NORMAL.includes(a.type) ? a.debit - a.credit : a.credit - a.debit;

@Injectable()
export class ReportsService {
  private async totals(range: { from?: string; to: string }): Promise<AccountTotals[]> {
    const { db } = RequestContext.tenant();
    const rows = await db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        type: ledgerAccounts.type,
        subtype: ledgerAccounts.subtype,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .leftJoin(
        journalEntries,
        and(
          eq(journalEntries.id, journalLines.entryId),
          POSTED,
          lte(journalEntries.entryDate, range.to),
          range.from ? gte(journalEntries.entryDate, range.from) : undefined,
        ),
      )
      // Lines whose entry didn't match the join conditions must not count.
      .where(sql`${journalLines.id} is null or ${journalEntries.id} is not null`)
      .groupBy(ledgerAccounts.id)
      .orderBy(asc(ledgerAccounts.code));
    return rows.map((r) => ({ ...r, debit: toUnits(normalizeMoney(r.debit)), credit: toUnits(normalizeMoney(r.credit)) }));
  }

  async trialBalance(asOf: string): Promise<TrialBalance> {
    // Accounts whose activity nets to zero are omitted, as on a conventional trial balance.
    const totals = (await this.totals({ to: asOf })).filter((t) => t.debit !== t.credit);
    const rows = totals.map((t) => {
      const net = t.debit - t.credit;
      return { accountId: t.accountId, code: t.code, name: t.name, type: t.type, debit: fromUnits(net > 0n ? net : 0n), credit: fromUnits(net < 0n ? -net : 0n) };
    });
    const totalDebit = rows.reduce((a, r) => a + toUnits(r.debit), 0n);
    const totalCredit = rows.reduce((a, r) => a + toUnits(r.credit), 0n);
    return { asOf, rows, totalDebit: fromUnits(totalDebit), totalCredit: fromUnits(totalCredit), balanced: totalDebit === totalCredit };
  }

  async ledger(accountId: string, from: string, to: string): Promise<LedgerReport> {
    const { db } = RequestContext.tenant();
    const [account] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, accountId));
    if (!account) throw Errors.notFound();
    const [opening] = await db
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalLines.accountId, accountId), POSTED, lt(journalEntries.entryDate, from)));
    const lines = await db
      .select({
        entryId: journalEntries.id,
        number: journalEntries.number,
        entryDate: journalEntries.entryDate,
        description: journalEntries.description,
        lineDescription: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalLines.accountId, accountId), POSTED, gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.number), asc(journalLines.lineNo))
      .limit(5000);
    const sign = DEBIT_NORMAL.includes(account.type) ? 1n : -1n;
    let balance = sign * (toUnits(normalizeMoney(opening!.debit)) - toUnits(normalizeMoney(opening!.credit)));
    const openingBalance = fromUnits(balance);
    const out = lines.map((l) => {
      balance += sign * (toUnits(normalizeMoney(l.debit)) - toUnits(normalizeMoney(l.credit)));
      return {
        entryId: l.entryId,
        number: l.number ?? '',
        entryDate: l.entryDate,
        description: l.description,
        lineDescription: l.lineDescription,
        debit: normalizeMoney(l.debit),
        credit: normalizeMoney(l.credit),
        balance: fromUnits(balance),
      };
    });
    return {
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      from,
      to,
      openingBalance,
      closingBalance: fromUnits(balance),
      lines: out,
    };
  }

  private section(title: string, accounts: AccountTotals[]): StatementSection {
    const rows = accounts
      .map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, units: normal(a) }))
      .filter((a) => a.units !== 0n);
    return {
      title,
      accounts: rows.map(({ units, ...r }) => ({ ...r, amount: fromUnits(units) })),
      total: fromUnits(rows.reduce((acc, r) => acc + r.units, 0n)),
    };
  }

  async incomeStatement(from: string, to: string): Promise<IncomeStatement> {
    const totals = await this.totals({ from, to });
    const income = this.section('Income', totals.filter((t) => t.type === 'income'));
    const expenses = this.section('Expenses', totals.filter((t) => t.type === 'expense'));
    return { from, to, income, expenses, netIncome: fromUnits(toUnits(income.total) - toUnits(expenses.total)) };
  }

  async balanceSheet(asOf: string): Promise<BalanceSheet> {
    const totals = await this.totals({ to: asOf });
    const assets = this.section('Assets', totals.filter((t) => t.type === 'asset'));
    const liabilities = this.section('Liabilities', totals.filter((t) => t.type === 'liability'));
    const equity = this.section('Equity', totals.filter((t) => t.type === 'equity'));
    const earnings = totals.filter((t) => t.type === 'income' || t.type === 'expense').reduce((acc, t) => acc + (t.credit - t.debit), 0n);
    const liabilitiesAndEquity = toUnits(liabilities.total) + toUnits(equity.total) + earnings;
    return {
      asOf,
      assets,
      liabilities,
      equity,
      currentEarnings: fromUnits(earnings),
      totalLiabilitiesAndEquity: fromUnits(liabilitiesAndEquity),
      balanced: toUnits(assets.total) === liabilitiesAndEquity,
    };
  }
}
