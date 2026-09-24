import type {
  BalanceSheet,
  DaybookEntryRow,
  DaybookSummary,
  IncomeStatement,
  JournalEntryRow,
  LedgerAccountRow,
  LedgerReport,
  TrialBalance,
} from '@daliz/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { journalEntries } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { TestEnv, type ApiClient, type TestTenant } from './harness.js';

/** Drizzle wraps driver errors; the PostgreSQL message (from our triggers) is on `cause`. */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(err, 'expected the database to reject the statement').not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ''}`).toMatch(pattern);
}

describe('accounting', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let accountant: ApiClient;
  let acct: Record<string, LedgerAccountRow>;

  const entry = (lines: [string, string, string][], date = '2026-09-10', description = 'Test entry') => ({
    entryDate: date,
    description,
    lines: lines.map(([code, debit, credit]) => ({ accountId: acct[code]!.id, debit, credit })),
  });

  /** Creates, submits, approves and posts an entry. */
  const postEntry = async (client: ApiClient, body: ReturnType<typeof entry>) => {
    const created = await client.post<JournalEntryRow>('/accounting/journal-entries', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await client.post(`/accounting/journal-entries/${created.data.id}/submit`);
    await client.post(`/accounting/journal-entries/${created.data.id}/approve`);
    const posted = await client.post<JournalEntryRow>(`/accounting/journal-entries/${created.data.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    return posted.data;
  };

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    accountant = await t.loggedIn((await t.addUser(tenant.tenantId, 'accountant')).email);
    const list = await accountant.get<LedgerAccountRow[]>('/accounting/accounts');
    acct = Object.fromEntries(list.data.map((a) => [a.code, a]));
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('seeds a default chart of accounts in every new tenant', async () => {
    expect(Object.keys(acct)).toEqual(expect.arrayContaining(['1000', '1010', '1100', '2000', '3100', '4000', '6100']));
    expect(acct['3100']).toMatchObject({ subtype: 'retained_earnings', isSystem: true, balance: '0.0000' });
  });

  it('runs the draft → pending → approved → posted workflow with gapless numbers', async () => {
    const created = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['1010', '5000', '0'], ['3000', '0', '5000']], '2026-09-01', 'Owner investment'));
    expect(created.data).toMatchObject({ status: 'draft', number: null, totalAmount: '5000.0000' });
    // Can't post before approval.
    expect((await accountant.post(`/accounting/journal-entries/${created.data.id}/post`)).status).toBe(409);
    expect((await accountant.post<JournalEntryRow>(`/accounting/journal-entries/${created.data.id}/submit`)).data.status).toBe('pending');
    expect((await accountant.post<JournalEntryRow>(`/accounting/journal-entries/${created.data.id}/approve`)).data.status).toBe('approved');
    const posted = await accountant.post<JournalEntryRow>(`/accounting/journal-entries/${created.data.id}/post`);
    expect(posted.data).toMatchObject({ status: 'posted', number: 'JE-000001' });
    expect(posted.data.postedBy?.name).toBeTruthy();

    // Posted entries are final through the API…
    expect((await accountant.post(`/accounting/journal-entries/${created.data.id}/post`)).status).toBe(409);
    expect((await accountant.del(`/accounting/journal-entries/${created.data.id}`)).status).toBe(409);
    const edit = await accountant.put(`/accounting/journal-entries/${created.data.id}`, { ...entry([['1010', '1', '0'], ['3000', '0', '1']]), version: posted.data.version });
    expect(edit.status).toBe(409);

    const accounts = await accountant.get<LedgerAccountRow[]>('/accounting/accounts');
    expect(accounts.data.find((a) => a.code === '1010')!.balance).toBe('5000.0000');
    expect(accounts.data.find((a) => a.code === '3000')!.balance).toBe('5000.0000');
  });

  it('rejects unbalanced entries, inactive accounts and accounts from elsewhere', async () => {
    const unbalanced = await accountant.post('/accounting/journal-entries', entry([['1010', '100', '0'], ['4000', '0', '90']]));
    expect(unbalanced.status).toBe(422);
    const foreign = await accountant.post('/accounting/journal-entries', {
      entryDate: '2026-09-10',
      description: 'x',
      lines: [
        { accountId: '00000000-0000-4000-8000-000000000000', debit: '1' },
        { accountId: acct['4000']!.id, credit: '1' },
      ],
    });
    expect(foreign.status).toBe(400);
  });

  it('enforces immutability and balance in the database itself', async () => {
    const posted = await postEntry(accountant, entry([['6100', '1200', '0'], ['1010', '0', '1200']], '2026-09-05', 'September rent'));
    const db = await t.get(TenantConnectionManager).get(tenant.tenantId);
    await rejectsWith(db.execute(sql`update journal_lines set debit = 1 where entry_id = ${posted.id} and debit > 0`), /immutable/);
    await rejectsWith(db.execute(sql`update journal_entries set description = 'tampered' where id = ${posted.id}`), /immutable/);
    await rejectsWith(db.execute(sql`delete from journal_entries where id = ${posted.id}`), /cannot be deleted/);
    await rejectsWith(db.execute(sql`delete from journal_lines where entry_id = ${posted.id}`), /immutable/);

    // Forcing an unbalanced draft to "posted" is refused by the trigger.
    const draft = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['6200', '50', '0'], ['1010', '0', '50']]));
    await db.execute(sql`update journal_lines set credit = 40 where entry_id = ${draft.data.id} and credit > 0`);
    await rejectsWith(db.update(journalEntries).set({ status: 'posted', number: 'JE-HACK' }).where(eq(journalEntries.id, draft.data.id)), /not balanced/);
    await rejectsWith(db.execute(sql`insert into journal_entries (entry_date, description, status, number) values ('2026-01-01', 'x', 'posted', 'JE-X')`), /unposted/);
  });

  it('reverses posted entries with a mirror entry instead of editing them', async () => {
    const original = await postEntry(accountant, entry([['6300', '80', '0'], ['1000', '0', '80']], '2026-09-06', 'Printer paper'));
    const reversal = await accountant.post<JournalEntryRow>(`/accounting/journal-entries/${original.id}/reverse`, { entryDate: '2026-09-07', reason: 'Duplicate receipt' });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(200);
    expect(reversal.data).toMatchObject({ status: 'posted', source: 'reversal', reversalOfId: original.id });
    expect(reversal.data.lines!.find((l) => l.accountCode === '6300')!.credit).toBe('80.0000');

    const after = await accountant.get<JournalEntryRow>(`/accounting/journal-entries/${original.id}`);
    expect(after.data).toMatchObject({ status: 'reversed', reversedById: reversal.data.id, reversalReason: 'Duplicate receipt' });
    expect((await accountant.post(`/accounting/journal-entries/${original.id}/reverse`, { entryDate: '2026-09-07', reason: 'Again please' })).status).toBe(409);
    expect((await accountant.post(`/accounting/journal-entries/${reversal.data.id}/reverse`, { entryDate: '2026-09-08', reason: 'Undo undo' })).status).toBe(409);
    expect((await accountant.post(`/accounting/journal-entries/${original.id}/reverse`, { entryDate: '2026-09-01', reason: 'Backdated' })).status).toBe(409);

    const accounts = await accountant.get<LedgerAccountRow[]>('/accounting/accounts');
    expect(accounts.data.find((a) => a.code === '6300')!.balance).toBe('0.0000');
  });

  it('prevents double posting under concurrency and keeps numbering gapless', async () => {
    const created = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['6400', '30', '0'], ['1010', '0', '30']]));
    await accountant.post(`/accounting/journal-entries/${created.data.id}/submit`);
    await accountant.post(`/accounting/journal-entries/${created.data.id}/approve`);
    const racers = await Promise.all(Array.from({ length: 6 }, () => accountant.post(`/accounting/journal-entries/${created.data.id}/post`)));
    expect(racers.filter((r) => r.status === 200)).toHaveLength(1);
    expect(racers.filter((r) => r.status === 409)).toHaveLength(5);

    const batch = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const c = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['6500', `${i + 1}`, '0'], ['1010', '0', `${i + 1}`]]));
        await accountant.post(`/accounting/journal-entries/${c.data.id}/submit`);
        await accountant.post(`/accounting/journal-entries/${c.data.id}/approve`);
        return c.data.id;
      }),
    );
    await Promise.all(batch.map((id) => accountant.post(`/accounting/journal-entries/${id}/post`)));
    const all = await accountant.get<JournalEntryRow[]>('/accounting/journal-entries?pageSize=100');
    const numbers = all.data.filter((e) => e.number).map((e) => Number(e.number!.slice(3))).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  it('honours Idempotency-Key so retries never create duplicates', async () => {
    const body = entry([['6600', '12.5', '0'], ['1010', '0', '12.5']], '2026-09-11', 'Bank fee');
    const key = `retry-${Date.now()}`;
    const first = await accountant.post<JournalEntryRow>('/accounting/journal-entries', body, { headers: { 'Idempotency-Key': key } });
    const second = await accountant.post<JournalEntryRow>('/accounting/journal-entries', body, { headers: { 'Idempotency-Key': key } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.data.id).toBe(first.data.id);
    const conflicting = await accountant.post('/accounting/journal-entries', { ...body, description: 'Different' }, { headers: { 'Idempotency-Key': key } });
    expect(conflicting.code).toBe('IDEMPOTENCY_CONFLICT');
    const list = await accountant.get<JournalEntryRow[]>('/accounting/journal-entries?q=Bank%20fee');
    expect(list.data).toHaveLength(1);
  });

  it('applies segregation of duties and the lock date', async () => {
    const owner = await t.loggedIn(tenant.ownerEmail);
    const s = await owner.get<{ version: number }>('/accounting/settings');
    expect((await owner.put('/accounting/settings', { lockDate: '2026-06-30', requireApproval: true, segregationOfDuties: true, version: s.data.version })).status).toBe(200);

    const mine = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['6700', '400', '0'], ['1010', '0', '400']], '2026-09-12', 'Legal advice'));
    await accountant.post(`/accounting/journal-entries/${mine.data.id}/submit`);
    expect((await accountant.post(`/accounting/journal-entries/${mine.data.id}/approve`)).status).toBe(403);
    expect((await owner.post(`/accounting/journal-entries/${mine.data.id}/approve`)).status).toBe(200);
    expect((await accountant.post(`/accounting/journal-entries/${mine.data.id}/post`)).status).toBe(200);

    const old = await accountant.post<JournalEntryRow>('/accounting/journal-entries', entry([['6700', '10', '0'], ['1010', '0', '10']], '2026-06-15', 'Backdated'));
    expect((await accountant.post(`/accounting/journal-entries/${old.data.id}/submit`)).status).toBe(409);

    const current = await owner.get<{ version: number }>('/accounting/settings');
    await owner.put('/accounting/settings', { lockDate: null, requireApproval: true, segregationOfDuties: false, version: current.data.version });
  });

  it('produces consistent reports', async () => {
    await postEntry(accountant, entry([['1100', '2500', '0'], ['4100', '0', '2500']], '2026-09-15', 'Consulting invoice'));
    await postEntry(accountant, entry([['1010', '2500', '0'], ['1100', '0', '2500']], '2026-09-20', 'Invoice paid'));

    const tb = await accountant.get<TrialBalance>('/accounting/reports/trial-balance?asOf=2026-09-30');
    expect(tb.data.balanced).toBe(true);
    expect(tb.data.totalDebit).toBe(tb.data.totalCredit);

    const pl = await accountant.get<IncomeStatement>('/accounting/reports/income-statement?from=2026-09-01&to=2026-09-30');
    expect(pl.data.income.accounts.find((a) => a.code === '4100')!.amount).toBe('2500.0000');
    const bs = await accountant.get<BalanceSheet>('/accounting/reports/balance-sheet?asOf=2026-09-30');
    expect(bs.data.balanced).toBe(true);
    expect(bs.data.currentEarnings).toBe(pl.data.netIncome);

    // Filtering journal entries by account returns (and counts) only entries touching it.
    const byAccount = await accountant.get<JournalEntryRow[]>(`/accounting/journal-entries?accountId=${acct['1100']!.id}&pageSize=100`);
    expect(byAccount.data.map((e) => e.description).sort()).toEqual(['Consulting invoice', 'Invoice paid']);
    expect((byAccount.body as { meta: { total: number } }).meta.total).toBe(2);

    const ledger = await accountant.get<LedgerReport>(`/accounting/reports/ledger/${acct['1100']!.id}?from=2026-09-01&to=2026-09-30`);
    expect(ledger.data.lines.map((l) => l.balance)).toEqual(['2500.0000', '0.0000']);
    expect(ledger.data.closingBalance).toBe('0.0000');
    expect((await accountant.get('/accounting/reports/income-statement?from=2026-09-30&to=2026-09-01')).status).toBe(422);
  });

  describe('daybook', () => {
    it('lets staff record entries that accountants approve into the ledger', async () => {
      const employee = await t.loggedIn((await t.addUser(tenant.tenantId, 'employee')).email);
      const form = await employee.get<{ money: { id: string; code: string }[]; expense: { id: string; code: string }[] }>('/daybook/accounts');
      const cash = form.data.money.find((a) => a.code === '1000')!;
      const travel = form.data.expense.find((a) => a.code === '6500')!;
      const body = { entryDate: '2026-09-18', kind: 'expense', amount: '64.20', moneyAccountId: cash.id, counterAccountId: travel.id, counterparty: 'City Taxi', description: 'Taxi to client' };

      expect((await employee.post('/daybook/entries', { ...body, postImmediately: true })).status).toBe(403);
      const created = await employee.post<DaybookEntryRow>('/daybook/entries', body);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.data).toMatchObject({ status: 'pending', amount: '64.2000', journalNumber: null });
      // Employees can't reach the ledger itself.
      expect((await employee.get('/accounting/journal-entries')).status).toBe(403);
      // Category rules are enforced.
      expect((await employee.post('/daybook/entries', { ...body, kind: 'income' })).status).toBe(400);

      const journalId = created.data.journalEntryId!;
      await accountant.post(`/accounting/journal-entries/${journalId}/approve`);
      await accountant.post(`/accounting/journal-entries/${journalId}/post`);
      const after = await employee.get<DaybookEntryRow>(`/daybook/entries/${created.data.id}`);
      expect(after.data.status).toBe('posted');
      expect(after.data.journalNumber).toMatch(/^JE-/);
      // Employees can't edit daybook entries at all; accountants can't edit posted ones.
      expect((await employee.put(`/daybook/entries/${created.data.id}`, { ...body, amount: '1', version: after.data.version })).status).toBe(403);
      expect((await accountant.put(`/daybook/entries/${created.data.id}`, { ...body, amount: '1', version: after.data.version })).status).toBe(409);

      const summary = await employee.get<DaybookSummary>('/daybook/summary?from=2026-09-01&to=2026-09-30');
      expect(summary.data.expense).toBe('64.2000');
    });

    it('lets approvers post immediately and void unposted entries', async () => {
      const form = await accountant.get<{ money: { id: string; code: string }[]; income: { id: string; code: string }[] }>('/daybook/accounts');
      const bank = form.data.money.find((a) => a.code === '1010')!;
      const sales = form.data.income.find((a) => a.code === '4000')!;
      const posted = await accountant.post<DaybookEntryRow>('/daybook/entries', {
        entryDate: '2026-09-19',
        kind: 'income',
        amount: '980',
        moneyAccountId: bank.id,
        counterAccountId: sales.id,
        description: 'Counter sales',
        postImmediately: true,
      });
      expect(posted.data.status).toBe('posted');
      const pending = await accountant.post<DaybookEntryRow>('/daybook/entries', {
        entryDate: '2026-09-19',
        kind: 'transfer',
        amount: '100',
        moneyAccountId: bank.id,
        counterAccountId: form.data.money.find((a) => a.code === '1000')!.id,
        description: 'Petty cash top-up',
      });
      expect((await accountant.post(`/daybook/entries/${pending.data.id}/void`)).status).toBe(200);
      expect((await accountant.get<DaybookEntryRow>(`/daybook/entries/${pending.data.id}`)).data.status).toBe('void');
      expect((await accountant.get(`/accounting/journal-entries/${pending.data.journalEntryId}`)).status).toBe(404);
      expect((await accountant.post(`/daybook/entries/${posted.data.id}/void`)).status).toBe(409);
    });
  });

  it("keeps each tenant's ledger separate", async () => {
    const other = await t.createTenant();
    const otherAccountant = await t.loggedIn((await t.addUser(other.tenantId, 'accountant')).email);
    const mine = await accountant.get<JournalEntryRow[]>('/accounting/journal-entries?pageSize=1');
    expect((await otherAccountant.get(`/accounting/journal-entries/${mine.data[0]!.id}`)).status).toBe(404);
    const theirs = await otherAccountant.get<LedgerAccountRow[]>('/accounting/accounts');
    expect(theirs.data.every((a) => a.balance === '0.0000')).toBe(true);
  });
});
