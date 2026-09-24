import { Injectable } from '@nestjs/common';
import {
  fromUnits,
  normalizeMoney,
  toUnits,
  type DaybookEntryInput,
  type DaybookEntryRow,
  type DaybookSummary,
  type Paginated,
} from '@daliz/shared';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Errors } from '../../common/errors.js';
import { RequestContext } from '../../common/request-context.js';
import { daybookEntries, journalEntries, journalLines, ledgerAccounts, users } from '../../database/tenant/schema.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountingService, type LineInput } from './accounting.service.js';

type Tx = Parameters<Parameters<TenantDb['transaction']>[0]>[0];
const MONEY_SUBTYPES = ['cash', 'bank'];

/**
 * The daybook is the everyday front door to the ledger: record money in, money out, or a
 * transfer, and a balanced journal entry is generated. Entries wait for an accountant's
 * approval unless the author can approve and asks to post straight away.
 */
@Injectable()
export class DaybookService {
  constructor(
    private readonly accounting: AccountingService,
    private readonly audit: AuditService,
  ) {}

  private async linesFor(tx: Tx | TenantDb, input: DaybookEntryInput): Promise<LineInput[]> {
    if (input.moneyAccountId === input.counterAccountId) throw Errors.badRequest('Choose two different accounts.');
    const accounts = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, [input.moneyAccountId, input.counterAccountId]));
    const money = accounts.find((a) => a.id === input.moneyAccountId);
    const counter = accounts.find((a) => a.id === input.counterAccountId);
    if (!money || !counter) throw Errors.badRequest('Account not found.');
    if (!MONEY_SUBTYPES.includes(money.subtype)) throw Errors.badRequest('Pick a cash or bank account for the money side.');
    if (input.kind === 'income' && counter.type !== 'income') throw Errors.badRequest('Income must be categorised to an income account.');
    if (input.kind === 'expense' && counter.type !== 'expense') throw Errors.badRequest('Expenses must be categorised to an expense account.');
    if (input.kind === 'transfer' && !MONEY_SUBTYPES.includes(counter.subtype)) throw Errors.badRequest('Transfers go between cash or bank accounts.');
    const memo = input.counterparty ? `${input.description} — ${input.counterparty}` : input.description;
    const amount = input.amount;
    const zero = '0.0000';
    switch (input.kind) {
      case 'income':
        return [
          { accountId: money.id, description: memo, debit: amount, credit: zero },
          { accountId: counter.id, description: memo, debit: zero, credit: amount },
        ];
      case 'expense':
        return [
          { accountId: counter.id, description: memo, debit: amount, credit: zero },
          { accountId: money.id, description: memo, debit: zero, credit: amount },
        ];
      case 'transfer':
        return [
          { accountId: counter.id, description: memo, debit: amount, credit: zero },
          { accountId: money.id, description: memo, debit: zero, credit: amount },
        ];
    }
  }

  async create(input: DaybookEntryInput): Promise<DaybookEntryRow> {
    const ctx = RequestContext.tenant();
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    if (input.postImmediately) {
      if (!ctx.permissions.has('accounting.approve')) throw Errors.forbidden('Posting straight to the ledger needs the accounting approval permission.');
      const s = await this.accounting.settings();
      if (s.segregationOfDuties) throw Errors.forbidden('Segregation of duties is on: entries must be approved by someone else.');
    }
    const id = await ctx.db.transaction(async (tx) => {
      const lines = await this.linesFor(tx, input);
      const { id: journalId } = await this.accounting.createEntry(
        { entryDate: input.entryDate, description: input.description, reference: input.reference, lines },
        { source: 'daybook', status: 'pending', tx },
      );
      const [row] = await tx
        .insert(daybookEntries)
        .values({
          entryDate: input.entryDate,
          kind: input.kind,
          amount: input.amount,
          moneyAccountId: input.moneyAccountId,
          counterAccountId: input.counterAccountId,
          counterparty: input.counterparty,
          description: input.description,
          reference: input.reference,
          status: 'pending',
          journalEntryId: journalId,
          createdBy: userId,
        })
        .returning({ id: daybookEntries.id });
      if (input.postImmediately) {
        await tx
          .update(journalEntries)
          .set({ status: 'approved', approvedBy: userId, approvedAt: new Date() })
          .where(eq(journalEntries.id, journalId));
        await this.accounting.post(journalId, tx);
      }
      return row!.id;
    });
    await this.audit.tenantEvent({
      action: 'daybook.entry_created',
      resourceType: 'daybook_entry',
      resourceId: id,
      metadata: { kind: input.kind, amount: input.amount, entryDate: input.entryDate, posted: input.postImmediately },
    });
    return this.get(id);
  }

  async update(id: string, input: DaybookEntryInput & { version: number }): Promise<DaybookEntryRow> {
    const ctx = RequestContext.tenant();
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(daybookEntries).where(eq(daybookEntries.id, id)).for('update');
      if (!row) throw Errors.notFound();
      if (row.status !== 'pending') throw Errors.conflict(row.status === 'posted' ? 'Posted entries can’t be edited; reverse the journal entry instead.' : 'This entry is void.');
      const [journal] = await tx.select().from(journalEntries).where(eq(journalEntries.id, row.journalEntryId!)).for('update');
      if (!journal || !['draft', 'pending'].includes(journal.status)) throw Errors.conflict('The linked journal entry has already been approved; ask an accountant to send it back.');
      const lines = await this.linesFor(tx, input);
      const updated = await tx
        .update(daybookEntries)
        .set({
          entryDate: input.entryDate,
          kind: input.kind,
          amount: input.amount,
          moneyAccountId: input.moneyAccountId,
          counterAccountId: input.counterAccountId,
          counterparty: input.counterparty,
          description: input.description,
          reference: input.reference,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(daybookEntries.id, id), eq(daybookEntries.version, input.version)))
        .returning({ id: daybookEntries.id });
      if (!updated.length) throw Errors.versionConflict();
      await tx
        .update(journalEntries)
        .set({ entryDate: input.entryDate, description: input.description, reference: input.reference, totalAmount: input.amount, version: journal.version + 1, updatedAt: new Date() })
        .where(eq(journalEntries.id, journal.id));
      await tx.delete(journalLines).where(eq(journalLines.entryId, journal.id));
      await tx.insert(journalLines).values(lines.map((l, i) => ({ entryId: journal.id, lineNo: i + 1, ...l })));
    });
    await this.audit.tenantEvent({ action: 'daybook.entry_updated', resourceType: 'daybook_entry', resourceId: id, metadata: { amount: input.amount, kind: input.kind } });
    return this.get(id);
  }

  async void(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(daybookEntries).where(eq(daybookEntries.id, id)).for('update');
      if (!row) throw Errors.notFound();
      if (row.status === 'void') return;
      if (row.status === 'posted') throw Errors.conflict('Posted entries are voided by reversing their journal entry in Accounting.');
      await tx.update(daybookEntries).set({ status: 'void', journalEntryId: null, updatedAt: new Date() }).where(eq(daybookEntries.id, id));
      if (row.journalEntryId) {
        await tx.delete(journalEntries).where(and(eq(journalEntries.id, row.journalEntryId), inArray(journalEntries.status, ['draft', 'pending', 'approved'])));
      }
    });
    await this.audit.tenantEvent({ action: 'daybook.entry_voided', resourceType: 'daybook_entry', resourceId: id });
  }

  private query(db: TenantDb) {
    const money = alias(ledgerAccounts, 'money');
    const counter = alias(ledgerAccounts, 'counter');
    return db
      .select({
        entry: daybookEntries,
        money: { id: money.id, code: money.code, name: money.name },
        counter: { id: counter.id, code: counter.code, name: counter.name },
        journalNumber: journalEntries.number,
        creator: { id: users.id, name: users.name },
      })
      .from(daybookEntries)
      .innerJoin(money, eq(money.id, daybookEntries.moneyAccountId))
      .innerJoin(counter, eq(counter.id, daybookEntries.counterAccountId))
      .leftJoin(journalEntries, eq(journalEntries.id, daybookEntries.journalEntryId))
      .leftJoin(users, eq(users.id, daybookEntries.createdBy))
      .$dynamic();
  }

  private toRow(r: Awaited<ReturnType<ReturnType<DaybookService['query']>['execute']>>[number]): DaybookEntryRow {
    const e = r.entry;
    return {
      id: e.id,
      entryDate: e.entryDate,
      kind: e.kind,
      amount: normalizeMoney(e.amount),
      moneyAccount: r.money,
      counterAccount: r.counter,
      counterparty: e.counterparty,
      description: e.description,
      reference: e.reference,
      status: e.status,
      journalEntryId: e.journalEntryId,
      journalNumber: r.journalNumber ?? null,
      createdBy: r.creator?.id ? { id: r.creator.id, name: r.creator.name ?? '' } : null,
      createdAt: e.createdAt.toISOString(),
      version: e.version,
    };
  }

  async get(id: string): Promise<DaybookEntryRow> {
    const { db } = RequestContext.tenant();
    const [row] = await this.query(db).where(eq(daybookEntries.id, id));
    if (!row) throw Errors.notFound();
    return this.toRow(row);
  }

  async list(q: { page: number; pageSize: number; q?: string; kind?: string; status?: string; from?: string; to?: string; moneyAccountId?: string }): Promise<Paginated<DaybookEntryRow>> {
    const { db } = RequestContext.tenant();
    const filters: (SQL | undefined)[] = [
      q.kind ? eq(daybookEntries.kind, q.kind as DaybookEntryRow['kind']) : undefined,
      q.status ? eq(daybookEntries.status, q.status as DaybookEntryRow['status']) : undefined,
      q.from ? gte(daybookEntries.entryDate, q.from) : undefined,
      q.to ? lte(daybookEntries.entryDate, q.to) : undefined,
      q.moneyAccountId ? eq(daybookEntries.moneyAccountId, q.moneyAccountId) : undefined,
      q.q ? or(ilike(daybookEntries.description, `%${q.q}%`), ilike(daybookEntries.counterparty, `%${q.q}%`), ilike(daybookEntries.reference, `%${q.q}%`)) : undefined,
    ];
    const where = and(...filters);
    const [total] = await db.select({ n: count() }).from(daybookEntries).where(where);
    const rows = await this.query(db)
      .where(where)
      .orderBy(desc(daybookEntries.entryDate), desc(daybookEntries.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => this.toRow(r)), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) } };
  }

  /** Accounts the daybook form needs: active cash/bank accounts and income/expense categories. */
  async formAccounts() {
    const { db } = RequestContext.tenant();
    const rows = await db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name, type: ledgerAccounts.type, subtype: ledgerAccounts.subtype })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.isActive, true))
      .orderBy(asc(ledgerAccounts.code));
    return {
      money: rows.filter((r) => MONEY_SUBTYPES.includes(r.subtype)),
      income: rows.filter((r) => r.type === 'income'),
      expense: rows.filter((r) => r.type === 'expense'),
    };
  }

  /** Posted money movement for a period, plus closing balances of cash and bank accounts. */
  async summary(from: string, to: string): Promise<DaybookSummary> {
    const { db } = RequestContext.tenant();
    const kinds = await db
      .select({ kind: daybookEntries.kind, total: sql<string>`coalesce(sum(${daybookEntries.amount}), 0)::text` })
      .from(daybookEntries)
      .where(and(eq(daybookEntries.status, 'posted'), gte(daybookEntries.entryDate, from), lte(daybookEntries.entryDate, to)))
      .groupBy(daybookEntries.kind);
    const income = normalizeMoney(kinds.find((k) => k.kind === 'income')?.total ?? '0');
    const expense = normalizeMoney(kinds.find((k) => k.kind === 'expense')?.total ?? '0');
    const accounts = await db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        inflow: sql<string>`coalesce(sum(${journalLines.debit}) filter (where ${journalEntries.entryDate} >= ${from}), 0)::text`,
        outflow: sql<string>`coalesce(sum(${journalLines.credit}) filter (where ${journalEntries.entryDate} >= ${from}), 0)::text`,
        balance: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text`,
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .leftJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), inArray(journalEntries.status, ['posted', 'reversed']), lte(journalEntries.entryDate, to)))
      .where(and(inArray(ledgerAccounts.subtype, ['cash', 'bank']), sql`(${journalLines.id} is null or ${journalEntries.id} is not null)`))
      .groupBy(ledgerAccounts.id)
      .orderBy(asc(ledgerAccounts.code));
    return {
      from,
      to,
      income,
      expense,
      net: fromUnits(toUnits(income) - toUnits(expense)),
      byAccount: accounts.map((a) => ({
        accountId: a.accountId,
        code: a.code,
        name: a.name,
        inflow: normalizeMoney(a.inflow),
        outflow: normalizeMoney(a.outflow),
        balance: normalizeMoney(a.balance),
      })),
    };
  }
}
