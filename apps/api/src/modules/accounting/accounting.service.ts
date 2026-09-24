import { Injectable } from '@nestjs/common';
import {
  DEBIT_NORMAL,
  accountingSettingsSchema,
  fromUnits,
  normalizeMoney,
  sumMoney,
  toUnits,
  type AccountingSettings,
  type JournalEntryInput,
  type JournalEntryRow,
  type JournalLineRow,
  type LedgerAccountInput,
  type LedgerAccountRow,
  type Paginated,
} from '@daliz/shared';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DomainEvents } from '../../common/domain-events.js';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { daybookEntries, journalEntries, journalLines, ledgerAccounts, numberSequences, settings, users } from '../../database/tenant/schema.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { DEFAULT_ACCOUNTING_SETTINGS } from '../../database/tenant/tenant-seed.js';
import { AuditService } from '../audit/audit.service.js';

type Tx = Parameters<Parameters<TenantDb['transaction']>[0]>[0];
type EntryStatus = JournalEntryRow['status'];

export interface LineInput {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}

const actorUserId = (ctx: TenantContext) => (ctx.actor.type === 'user' ? ctx.actor.userId : null);

/**
 * Double-entry ledger. Entries move draft → pending → approved → posted, and a posted entry
 * is never edited: it is reversed by a new, mirror-image entry. The database independently
 * enforces balance and immutability (see migration 0003), so these rules hold even if a
 * code path here were wrong.
 */
@Injectable()
export class AccountingService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(db: TenantDb | Tx = RequestContext.tenant().db): Promise<AccountingSettings & { version: number }> {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'accounting'));
    const parsed = accountingSettingsSchema.safeParse(row?.value);
    return { ...(parsed.success ? parsed.data : DEFAULT_ACCOUNTING_SETTINGS), version: row?.version ?? 0 };
  }

  async updateSettings(value: AccountingSettings, version: number): Promise<AccountingSettings & { version: number }> {
    const ctx = RequestContext.tenant();
    const before = await this.settings();
    const updated =
      version === 0
        ? await ctx.db.insert(settings).values({ key: 'accounting', value, updatedBy: actorUserId(ctx) }).onConflictDoNothing().returning({ key: settings.key })
        : await ctx.db
            .update(settings)
            .set({ value, version: version + 1, updatedAt: new Date(), updatedBy: actorUserId(ctx) })
            .where(and(eq(settings.key, 'accounting'), eq(settings.version, version)))
            .returning({ key: settings.key });
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: 'accounting.settings_updated', resourceType: 'settings', resourceId: 'accounting', metadata: { before, after: value } });
    return this.settings();
  }

  // -------------------------------------------------------------------------
  // Chart of accounts
  // -------------------------------------------------------------------------

  async listAccounts(includeInactive = true): Promise<LedgerAccountRow[]> {
    const { db } = RequestContext.tenant();
    const rows = await db
      .select({
        account: ledgerAccounts,
        debit: sql<string>`coalesce(sum(${journalLines.debit}) filter (where ${journalEntries.status} in ('posted','reversed')), 0)::text`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}) filter (where ${journalEntries.status} in ('posted','reversed')), 0)::text`,
        lineCount: sql<number>`count(${journalLines.id})::int`,
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(includeInactive ? undefined : eq(ledgerAccounts.isActive, true))
      .groupBy(ledgerAccounts.id)
      .orderBy(asc(ledgerAccounts.code));
    return rows.map(({ account: a, debit, credit, lineCount }) => {
      const net = toUnits(normalizeMoney(debit)) - toUnits(normalizeMoney(credit));
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        parentId: a.parentId,
        description: a.description,
        isActive: a.isActive,
        isSystem: a.isSystem,
        balance: fromUnits(DEBIT_NORMAL.includes(a.type) ? net : -net),
        hasPostings: lineCount > 0,
        version: a.version,
      };
    });
  }

  async createAccount(input: LedgerAccountInput): Promise<{ id: string }> {
    const ctx = RequestContext.tenant();
    if (input.subtype === 'retained_earnings') throw Errors.badRequest('There can only be one retained earnings account.');
    if (input.parentId) await this.assertParent(ctx.db, input.parentId, input.type);
    const [row] = await ctx.db
      .insert(ledgerAccounts)
      .values({ ...input, isSystem: false })
      .onConflictDoNothing({ target: ledgerAccounts.code })
      .returning({ id: ledgerAccounts.id });
    if (!row) throw Errors.conflict(`Account code ${input.code} is already in use.`);
    await this.audit.tenantEvent({ action: 'accounting.account_created', resourceType: 'ledger_account', resourceId: row.id, metadata: { code: input.code, name: input.name, type: input.type } });
    return row;
  }

  async updateAccount(id: string, patch: Partial<LedgerAccountInput> & { isActive?: boolean; version: number }): Promise<void> {
    const ctx = RequestContext.tenant();
    const [account] = await ctx.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, id));
    if (!account) throw Errors.notFound();
    const changingType = (patch.type && patch.type !== account.type) || (patch.subtype && patch.subtype !== account.subtype);
    if (account.isSystem && (changingType || patch.isActive === false)) throw Errors.forbidden('System accounts can’t be retyped or deactivated.');
    if (patch.subtype === 'retained_earnings' && account.subtype !== 'retained_earnings') throw Errors.badRequest('There can only be one retained earnings account.');
    if (changingType) {
      const [used] = await ctx.db.select({ n: count() }).from(journalLines).where(eq(journalLines.accountId, id));
      if (Number(used?.n ?? 0) > 0) throw Errors.conflict('An account with entries can’t change type. Create a new account instead.');
    }
    if (patch.parentId) {
      if (patch.parentId === id) throw Errors.badRequest('An account can’t be its own parent.');
      await this.assertParent(ctx.db, patch.parentId, patch.type ?? account.type);
    }
    const { version, ...fields } = patch;
    const updated = await ctx.db
      .update(ledgerAccounts)
      .set({ ...fields, version: account.version + 1, updatedAt: new Date() })
      .where(and(eq(ledgerAccounts.id, id), eq(ledgerAccounts.version, version)))
      .returning({ id: ledgerAccounts.id });
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: 'accounting.account_updated', resourceType: 'ledger_account', resourceId: id, metadata: fields });
  }

  private async assertParent(db: TenantDb, parentId: string, type: string): Promise<void> {
    const [parent] = await db.select({ type: ledgerAccounts.type }).from(ledgerAccounts).where(eq(ledgerAccounts.id, parentId));
    if (!parent) throw Errors.badRequest('Parent account not found.');
    if (parent.type !== type) throw Errors.badRequest('A sub-account must have the same type as its parent.');
  }

  // -------------------------------------------------------------------------
  // Journal entries
  // -------------------------------------------------------------------------

  async listEntries(q: { page: number; pageSize: number; q?: string; status?: EntryStatus; from?: string; to?: string; accountId?: string }): Promise<Paginated<JournalEntryRow>> {
    const { db } = RequestContext.tenant();
    const filters: (SQL | undefined)[] = [
      q.status ? eq(journalEntries.status, q.status) : undefined,
      q.from ? gte(journalEntries.entryDate, q.from) : undefined,
      q.to ? lte(journalEntries.entryDate, q.to) : undefined,
      q.q ? or(ilike(journalEntries.description, `%${q.q}%`), ilike(journalEntries.reference, `%${q.q}%`), ilike(journalEntries.number, `%${q.q}%`)) : undefined,
      q.accountId ? sql`exists (select 1 from ${journalLines} jl where jl.entry_id = ${qcol(journalEntries.id)} and jl.account_id = ${q.accountId})` : undefined,
    ];
    const where = and(...filters);
    const [total] = await db.select({ n: count() }).from(journalEntries).where(where);
    const rows = await this.entryQuery(db)
      .where(where)
      .orderBy(desc(journalEntries.entryDate), desc(journalEntries.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => this.toRow(r)), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) } };
  }

  async getEntry(id: string, db: TenantDb | Tx = RequestContext.tenant().db): Promise<JournalEntryRow> {
    const [row] = await this.entryQuery(db).where(eq(journalEntries.id, id));
    if (!row) throw Errors.notFound();
    const lines = await db
      .select({
        id: journalLines.id,
        lineNo: journalLines.lineNo,
        accountId: journalLines.accountId,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
      .where(eq(journalLines.entryId, id))
      .orderBy(asc(journalLines.lineNo));
    return { ...this.toRow(row), lines: lines as JournalLineRow[] };
  }

  private entryQuery(db: TenantDb | Tx) {
    const creator = alias(users, 'creator');
    const submitter = alias(users, 'submitter');
    const approver = alias(users, 'approver');
    const poster = alias(users, 'poster');
    return db
      .select({
        entry: journalEntries,
        creator: { id: creator.id, name: creator.name },
        submitter: { id: submitter.id, name: submitter.name },
        approver: { id: approver.id, name: approver.name },
        poster: { id: poster.id, name: poster.name },
      })
      .from(journalEntries)
      .leftJoin(creator, eq(creator.id, journalEntries.createdBy))
      .leftJoin(submitter, eq(submitter.id, journalEntries.submittedBy))
      .leftJoin(approver, eq(approver.id, journalEntries.approvedBy))
      .leftJoin(poster, eq(poster.id, journalEntries.postedBy))
      .$dynamic();
  }

  private toRow(r: {
    entry: typeof journalEntries.$inferSelect;
    creator: { id: string | null; name: string | null } | null;
    submitter: { id: string | null; name: string | null } | null;
    approver: { id: string | null; name: string | null } | null;
    poster: { id: string | null; name: string | null } | null;
  }): JournalEntryRow {
    const person = (p: { id: string | null; name: string | null } | null) => (p?.id ? { id: p.id, name: p.name ?? '' } : null);
    const e = r.entry;
    return {
      id: e.id,
      number: e.number,
      entryDate: e.entryDate,
      description: e.description,
      reference: e.reference,
      source: e.source,
      status: e.status,
      totalAmount: normalizeMoney(e.totalAmount),
      createdBy: person(r.creator),
      submittedBy: person(r.submitter),
      submittedAt: e.submittedAt?.toISOString() ?? null,
      approvedBy: person(r.approver),
      approvedAt: e.approvedAt?.toISOString() ?? null,
      postedBy: person(r.poster),
      postedAt: e.postedAt?.toISOString() ?? null,
      reversalOfId: e.reversalOfId,
      reversedById: e.reversedById,
      reversalReason: e.reversalReason,
      createdAt: e.createdAt.toISOString(),
      version: e.version,
    };
  }

  /** Validates lines against the chart of accounts. Returns the total. */
  private async validateLines(db: TenantDb | Tx, lines: LineInput[]): Promise<string> {
    const debit = sumMoney(lines.map((l) => l.debit));
    const credit = sumMoney(lines.map((l) => l.credit));
    if (debit !== credit) throw Errors.badRequest(`Debits (${debit}) and credits (${credit}) must be equal.`);
    if (toUnits(debit) <= 0n) throw Errors.badRequest('An entry must move a positive amount.');
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await db.select({ id: ledgerAccounts.id, isActive: ledgerAccounts.isActive, code: ledgerAccounts.code }).from(ledgerAccounts).where(inArray(ledgerAccounts.id, ids));
    if (accounts.length !== ids.length) throw Errors.badRequest('One or more accounts don’t exist.');
    const inactive = accounts.filter((a) => !a.isActive);
    if (inactive.length) throw Errors.badRequest(`Inactive accounts can’t receive entries: ${inactive.map((a) => a.code).join(', ')}`);
    return debit;
  }

  private assertUnlocked(settingsValue: AccountingSettings, entryDate: string): void {
    if (settingsValue.lockDate && entryDate <= settingsValue.lockDate) {
      throw Errors.conflict(`The books are locked through ${settingsValue.lockDate}. Choose a later date or ask an administrator to move the lock date.`);
    }
  }

  async createEntry(
    input: JournalEntryInput,
    opts: { source?: 'manual' | 'daybook' | 'opening'; status?: 'draft' | 'pending'; tx?: Tx } = {},
  ): Promise<{ id: string }> {
    const ctx = RequestContext.tenant();
    const run = async (tx: Tx) => {
      const total = await this.validateLines(tx, input.lines);
      const status = opts.status ?? 'draft';
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          entryDate: input.entryDate,
          description: input.description,
          reference: input.reference,
          source: opts.source ?? 'manual',
          status,
          totalAmount: total,
          createdBy: actorUserId(ctx),
          ...(status === 'pending' ? { submittedBy: actorUserId(ctx), submittedAt: new Date() } : {}),
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values(input.lines.map((l, i) => ({ entryId: entry!.id, lineNo: i + 1, ...l })));
      return entry!.id;
    };
    if (opts.tx) return { id: await run(opts.tx) }; // the caller audits after its transaction commits
    const id = await ctx.db.transaction(run);
    await this.audit.tenantEvent({
      action: 'accounting.entry_created',
      resourceType: 'journal_entry',
      resourceId: id,
      metadata: { entryDate: input.entryDate, total: sumMoney(input.lines.map((l) => l.debit)), lines: input.lines.length, source: opts.source ?? 'manual' },
    });
    return { id };
  }

  async updateEntry(id: string, input: JournalEntryInput & { version: number }): Promise<JournalEntryRow> {
    const ctx = RequestContext.tenant();
    await ctx.db.transaction(async (tx) => {
      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id)).for('update');
      if (!entry) throw Errors.notFound();
      if (!['draft', 'pending'].includes(entry.status)) throw Errors.conflict('Only draft or pending entries can be edited. Reverse posted entries instead.');
      if (entry.source !== 'manual') throw Errors.conflict('Entries created from the daybook are edited there.');
      const total = await this.validateLines(tx, input.lines);
      const updated = await tx
        .update(journalEntries)
        .set({
          entryDate: input.entryDate,
          description: input.description,
          reference: input.reference,
          totalAmount: total,
          status: 'draft',
          submittedBy: null,
          submittedAt: null,
          version: entry.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.version, input.version)))
        .returning({ id: journalEntries.id });
      if (!updated.length) throw Errors.versionConflict();
      await tx.delete(journalLines).where(eq(journalLines.entryId, id));
      await tx.insert(journalLines).values(input.lines.map((l, i) => ({ entryId: id, lineNo: i + 1, ...l })));
    });
    await this.audit.tenantEvent({ action: 'accounting.entry_updated', resourceType: 'journal_entry', resourceId: id, metadata: { lines: input.lines.length } });
    return this.getEntry(id);
  }

  async deleteEntry(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const [entry] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, id));
    if (!entry) throw Errors.notFound();
    if (!['draft', 'pending'].includes(entry.status)) throw Errors.conflict('Only draft or pending entries can be deleted.');
    if (entry.source !== 'manual') throw Errors.conflict('Void the daybook entry instead.');
    const deleted = await ctx.db
      .delete(journalEntries)
      .where(and(eq(journalEntries.id, id), inArray(journalEntries.status, ['draft', 'pending'])))
      .returning({ id: journalEntries.id });
    if (!deleted.length) throw Errors.conflict('The entry changed; reload and try again.');
    await this.audit.tenantEvent({ action: 'accounting.entry_deleted', resourceType: 'journal_entry', resourceId: id, metadata: { description: entry.description, total: entry.totalAmount } });
  }

  /** Moves an entry between unposted states with a conditional update (race-safe). */
  private async transition(id: string, from: EntryStatus[], to: EntryStatus, extra: Partial<typeof journalEntries.$inferInsert>, check?: (e: typeof journalEntries.$inferSelect, s: AccountingSettings) => void) {
    const ctx = RequestContext.tenant();
    const s = await this.settings();
    await ctx.db.transaction(async (tx) => {
      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id)).for('update');
      if (!entry) throw Errors.notFound();
      if (!from.includes(entry.status)) throw Errors.conflict(`This entry is ${entry.status}; it can’t be moved to ${to}.`);
      check?.(entry, s);
      await tx
        .update(journalEntries)
        .set({ ...extra, status: to, version: entry.version + 1, updatedAt: new Date() })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.status, entry.status)));
    });
  }

  async submit(id: string): Promise<JournalEntryRow> {
    const ctx = RequestContext.tenant();
    await this.transition(id, ['draft'], 'pending', { submittedBy: actorUserId(ctx), submittedAt: new Date() }, (e, s) => this.assertUnlocked(s, e.entryDate));
    await this.audit.tenantEvent({ action: 'accounting.entry_submitted', resourceType: 'journal_entry', resourceId: id });
    const entry = await this.getEntry(id);
    this.events.emit('accounting.entry_submitted', { tenantId: ctx.tenantId, entryId: id, description: entry.description, actorId: actorUserId(ctx) });
    return entry;
  }

  async approve(id: string): Promise<JournalEntryRow> {
    const ctx = RequestContext.tenant();
    await this.transition(id, ['pending'], 'approved', { approvedBy: actorUserId(ctx), approvedAt: new Date() }, (e, s) => {
      this.assertUnlocked(s, e.entryDate);
      this.assertSegregation(ctx, e, s);
    });
    await this.audit.tenantEvent({ action: 'accounting.entry_approved', resourceType: 'journal_entry', resourceId: id });
    return this.getEntry(id);
  }

  private assertSegregation(ctx: TenantContext, e: typeof journalEntries.$inferSelect, s: AccountingSettings) {
    if (s.segregationOfDuties && e.createdBy && e.createdBy === actorUserId(ctx)) {
      throw Errors.forbidden('Segregation of duties is on: someone other than the author must approve this entry.');
    }
  }

  private async nextNumber(tx: Tx, key: string): Promise<string> {
    // Row lock on the counter makes numbering gapless and serial across concurrent posts.
    const [row] = await tx
      .update(numberSequences)
      .set({ nextValue: sql`${numberSequences.nextValue} + 1` })
      .where(eq(numberSequences.key, key))
      .returning({ value: sql<number>`${numberSequences.nextValue} - 1`, prefix: numberSequences.prefix });
    if (!row) throw new Error(`Number sequence ${key} missing`);
    return `${row.prefix}${String(row.value).padStart(6, '0')}`;
  }

  /** Posts an entry to the ledger: final, numbered and immutable. */
  async post(id: string, tx?: Tx): Promise<JournalEntryRow> {
    const ctx = RequestContext.tenant();
    const run = async (t: Tx) => {
      const s = await this.settings(t);
      const [entry] = await t.select().from(journalEntries).where(eq(journalEntries.id, id)).for('update');
      if (!entry) throw Errors.notFound();
      const postable: EntryStatus[] = s.requireApproval ? ['approved'] : ['draft', 'pending', 'approved'];
      if (!postable.includes(entry.status)) {
        throw Errors.conflict(entry.status === 'posted' || entry.status === 'reversed' ? 'This entry is already posted.' : 'Approve this entry before posting it.');
      }
      this.assertUnlocked(s, entry.entryDate);
      if (entry.status !== 'approved') this.assertSegregation(ctx, entry, s);
      const lines = await t.select().from(journalLines).where(eq(journalLines.entryId, id));
      await this.validateLines(
        t,
        lines.map((l) => ({ accountId: l.accountId, description: l.description, debit: normalizeMoney(l.debit), credit: normalizeMoney(l.credit) })),
      );
      const number = await this.nextNumber(t, 'journal_entry');
      const now = new Date();
      const posted = await t
        .update(journalEntries)
        .set({
          status: 'posted',
          number,
          postedBy: actorUserId(ctx),
          postedAt: now,
          approvedBy: entry.approvedBy ?? actorUserId(ctx),
          approvedAt: entry.approvedAt ?? now,
          version: entry.version + 1,
          updatedAt: now,
        })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.status, entry.status)))
        .returning({ id: journalEntries.id });
      if (!posted.length) throw Errors.conflict('This entry changed while posting; reload and try again.');
      await t.update(daybookEntries).set({ status: 'posted', updatedAt: now }).where(eq(daybookEntries.journalEntryId, id));
      return number;
    };
    if (tx) {
      await run(tx); // the caller audits after its transaction commits
      return this.getEntry(id, tx);
    }
    const number = await ctx.db.transaction(run);
    await this.audit.tenantEvent({ action: 'accounting.entry_posted', resourceType: 'journal_entry', resourceId: id, metadata: { number } });
    return this.getEntry(id);
  }

  /** Reverses a posted entry with a mirror-image posted entry; the original is kept. */
  async reverse(id: string, input: { entryDate: string; reason: string }): Promise<JournalEntryRow> {
    const ctx = RequestContext.tenant();
    const reversalId = await ctx.db.transaction(async (tx) => {
      const s = await this.settings(tx);
      const [original] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id)).for('update');
      if (!original) throw Errors.notFound();
      if (original.status !== 'posted') throw Errors.conflict(original.status === 'reversed' ? 'This entry has already been reversed.' : 'Only posted entries can be reversed.');
      if (original.source === 'reversal') throw Errors.conflict('A reversal can’t itself be reversed; post a new entry instead.');
      if (input.entryDate < original.entryDate) throw Errors.badRequest('A reversal can’t be dated before the original entry.');
      this.assertUnlocked(s, input.entryDate);
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, id)).orderBy(asc(journalLines.lineNo));
      const [rev] = await tx
        .insert(journalEntries)
        .values({
          entryDate: input.entryDate,
          description: `Reversal of ${original.number}: ${input.reason}`,
          reference: original.reference,
          source: 'reversal',
          status: 'approved',
          totalAmount: original.totalAmount,
          createdBy: actorUserId(ctx),
          approvedBy: actorUserId(ctx),
          approvedAt: new Date(),
          reversalOfId: original.id,
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values(
        lines.map((l) => ({ entryId: rev!.id, lineNo: l.lineNo, accountId: l.accountId, description: l.description, debit: l.credit, credit: l.debit })),
      );
      const number = await this.nextNumber(tx, 'journal_entry');
      const now = new Date();
      await tx
        .update(journalEntries)
        .set({ status: 'posted', number, postedBy: actorUserId(ctx), postedAt: now, updatedAt: now })
        .where(eq(journalEntries.id, rev!.id));
      await tx
        .update(journalEntries)
        .set({ status: 'reversed', reversedById: rev!.id, reversedAt: now, reversalReason: input.reason, version: original.version + 1, updatedAt: now })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.status, 'posted')));
      await tx.update(daybookEntries).set({ status: 'void', updatedAt: now }).where(eq(daybookEntries.journalEntryId, id));
      return rev!.id;
    });
    await this.audit.tenantEvent({ action: 'accounting.entry_reversed', resourceType: 'journal_entry', resourceId: id, metadata: { reversalId, reason: input.reason, entryDate: input.entryDate } });
    return this.getEntry(reversalId);
  }
}
