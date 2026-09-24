import { eq } from 'drizzle-orm';
import type { INestApplicationContext } from '@nestjs/common';
import { RequestContext } from '../common/request-context.js';
import { journalEntries, ledgerAccounts, users } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { AccountingService } from '../modules/accounting/accounting.service.js';
import { DaybookService } from '../modules/accounting/daybook.service.js';
import { TenantContextService } from '../modules/tenancy/tenant-context.service.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Realistic demo bookkeeping for a tenant, created through the real services (so it gets
 * proper numbering, workflow states and audit entries). Skipped if the ledger has entries.
 */
export async function seedSampleAccounting(app: INestApplicationContext, tenantId: string, tenant: { slug: string; name: string }, actors: { ownerEmail: string; employeeEmail: string }) {
  const db = await app.get(TenantConnectionManager).get(tenantId);
  const [existing] = await db.select({ id: journalEntries.id }).from(journalEntries).limit(1);
  if (existing) return false;
  const accounts = Object.fromEntries((await db.select().from(ledgerAccounts)).map((a) => [a.code, a.id]));
  const actorFor = async (email: string) => {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const permissions = await app.get(TenantContextService).permissionsFor(tenantId, db, u!.id);
    return { user: u!, permissions };
  };
  const inContext = async <T>(email: string, fn: () => Promise<T>) => {
    const { user, permissions } = await actorFor(email);
    return RequestContext.run(
      {
        requestId: 'seed',
        ip: null,
        userAgent: 'daliz-seed',
        host: null,
        tenant: { tenantId, slug: tenant.slug, name: tenant.name, db, permissions, actor: { type: 'user', userId: user.id, accountId: user.accountId, email: user.email } },
      },
      fn,
    );
  };
  const accounting = app.get(AccountingService);
  const daybook = app.get(DaybookService);
  const today = new Date();
  const monthStart = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
  const day = (offset: number, d: number) => {
    const m = monthStart(offset);
    return iso(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), Math.min(d, today.getUTCDate() + (offset === 0 ? 0 : 31)))));
  };

  const journal: [string, string, [string, string, string][]][] = [
    [day(1, 1), 'Owner capital contribution', [['1010', '85000', '0'], ['3000', '0', '85000']]],
    [day(1, 2), 'Office rent — prior month', [['6100', '4200', '0'], ['1010', '0', '4200']]],
    [day(1, 5), 'Laptops for finance team', [['1500', '7400', '0'], ['2000', '0', '7400']]],
    [day(1, 12), 'Consulting engagement — Northwind', [['1100', '18500', '0'], ['4100', '0', '18500']]],
    [day(1, 20), 'Payroll', [['6000', '21300', '0'], ['1010', '0', '21300']]],
    [day(1, 25), 'Northwind invoice settled', [['1010', '18500', '0'], ['1100', '0', '18500']]],
    [day(1, 28), 'Supplier invoice paid — laptops', [['2000', '7400', '0'], ['1010', '0', '7400']]],
    [day(0, 1), 'Office rent', [['6100', '4200', '0'], ['1010', '0', '4200']]],
    [day(0, 3), 'Retainer — Contoso Ltd', [['1100', '12000', '0'], ['4100', '0', '12000']]],
    [day(0, 4), 'Accounting software annual plan', [['6400', '1188', '0'], ['1010', '0', '1188']]],
  ];
  await inContext(actors.ownerEmail, async () => {
    for (const [entryDate, description, lines] of journal) {
      const { id } = await accounting.createEntry({
        entryDate,
        description,
        reference: null,
        lines: lines.map(([code, debit, credit]) => ({ accountId: accounts[code]!, description: '', debit: `${debit}.0000`, credit: `${credit}.0000` })),
      });
      await accounting.submit(id);
      await accounting.approve(id);
      await accounting.post(id);
    }
    // One awaiting approval, one draft.
    const pending = await accounting.createEntry({
      entryDate: day(0, 6),
      description: 'Accrued audit fees',
      reference: 'AUD-2026',
      lines: [
        { accountId: accounts['6700']!, description: '', debit: '3500.0000', credit: '0.0000' },
        { accountId: accounts['2200']!, description: '', debit: '0.0000', credit: '3500.0000' },
      ],
    });
    await accounting.submit(pending.id);
    await accounting.createEntry({
      entryDate: day(0, 7),
      description: 'Prepaid insurance (draft)',
      reference: null,
      lines: [
        { accountId: accounts['1300']!, description: '', debit: '2400.0000', credit: '0.0000' },
        { accountId: accounts['1010']!, description: '', debit: '0.0000', credit: '2400.0000' },
      ],
    });
    await daybook.create({ entryDate: day(0, 2), kind: 'income', amount: '1450.0000', moneyAccountId: accounts['1010']!, counterAccountId: accounts['4000']!, counterparty: 'Walk-in customers', description: 'Card sales', reference: null, postImmediately: true });
    await daybook.create({ entryDate: day(0, 3), kind: 'transfer', amount: '500.0000', moneyAccountId: accounts['1010']!, counterAccountId: accounts['1000']!, counterparty: null, description: 'Petty cash top-up', reference: null, postImmediately: true });
  });
  await inContext(actors.employeeEmail, async () => {
    await daybook.create({ entryDate: day(0, 4), kind: 'expense', amount: '86.4000', moneyAccountId: accounts['1000']!, counterAccountId: accounts['6300']!, counterparty: 'Office Depot', description: 'Printer toner', reference: 'R-1182', postImmediately: false });
    await daybook.create({ entryDate: day(0, 5), kind: 'expense', amount: '42.0000', moneyAccountId: accounts['1000']!, counterAccountId: accounts['6500']!, counterparty: 'Metro Cabs', description: 'Taxi to client site', reference: null, postImmediately: false });
  });
  return true;
}

/** Demo planner, calendar and file library content, created through the real services. */
export async function seedSampleWorkspace(
  app: INestApplicationContext,
  tenantId: string,
  tenant: { slug: string; name: string; timezone: string },
  people: { ownerEmail: string; memberEmails: string[] },
) {
  const { eq: eqOp } = await import('drizzle-orm');
  const { projects: projectsTable, files: filesTable, fileVersions: versionsTable } = await import('../database/tenant/schema.js');
  const db = await app.get(TenantConnectionManager).get(tenantId);
  const [existing] = await db.select({ id: projectsTable.id }).from(projectsTable).limit(1);
  if (existing) return false;
  const { PlannerService } = await import('../modules/planner/planner.service.js');
  const { TasksService } = await import('../modules/planner/tasks.service.js');
  const { EventsService } = await import('../modules/events/events.service.js');
  const { FilesService } = await import('../modules/files/files.service.js');
  const planner = app.get(PlannerService);
  const tasksSvc = app.get(TasksService);
  const events = app.get(EventsService);
  const filesSvc = app.get(FilesService);

  const ids = new Map<string, string>();
  for (const email of [people.ownerEmail, ...people.memberEmails]) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (u) ids.set(email, u.id);
  }
  const member = (i: number) => ids.get(people.memberEmails[i % Math.max(1, people.memberEmails.length)] ?? people.ownerEmail) ?? null;
  const as = async <T>(email: string, fn: () => Promise<T>) => {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const permissions = await app.get(TenantContextService).permissionsFor(tenantId, db, u!.id);
    return RequestContext.run(
      { requestId: 'seed', ip: null, userAgent: 'daliz-seed', host: null, tenant: { tenantId, slug: tenant.slug, name: tenant.name, db, permissions, actor: { type: 'user', userId: u!.id, accountId: u!.accountId, email: u!.email } } },
      fn,
    );
  };
  const today = new Date();
  const day = (offset: number) => new Date(today.getTime() + offset * 86400_000).toISOString().slice(0, 10);

  await as(people.ownerEmail, async () => {
    // --- Planner -------------------------------------------------------------------
    const audit = await planner.createLabel({ name: 'Audit', color: '#b91c1c' });
    const quick = await planner.createLabel({ name: 'Quick win', color: '#15803d' });
    const { id: wsId } = await planner.createWorkspace({ name: 'Finance Operations', description: 'Close, reporting and compliance work.', color: '#0f766e', visibility: 'workspace' });
    const close = await planner.createProject({ workspaceId: wsId, key: 'CLOSE', name: 'Month-end close', description: 'Everything needed to close the books each month.', status: 'active', ownerId: member(1), startDate: day(-10), dueDate: day(10), color: '#0f766e' });
    const plan: [string, 'todo' | 'in_progress' | 'in_review' | 'done', 'none' | 'low' | 'medium' | 'high' | 'urgent', number, number | null, string[]][] = [
      ['Reconcile operating bank account', 'done', 'high', 1, -3, [audit.id]],
      ['Reconcile savings account', 'in_review', 'medium', 1, 1, [audit.id]],
      ['Review accrued liabilities', 'in_progress', 'high', 2, 2, []],
      ['Post payroll journal', 'todo', 'urgent', 1, 0, []],
      ['Chase outstanding receivables', 'todo', 'medium', 3, 4, [quick.id]],
      ['Prepare management accounts pack', 'todo', 'high', 0, 7, []],
      ['Archive supplier statements', 'todo', 'low', 2, null, [quick.id]],
    ];
    for (const [title, status, priority, who, due, labelIds] of plan) {
      const t = await tasksSvc.create({ projectId: close.id, parentTaskId: null, title, description: '', status, priority, assigneeId: member(who), startDate: null, dueDate: due === null ? null : day(due), estimateMinutes: null, labelIds });
      if (title.startsWith('Prepare management')) {
        for (const sub of ['Profit and loss commentary', 'Cash flow forecast', 'KPI dashboard']) {
          await tasksSvc.create({ projectId: close.id, parentTaskId: t.id, title: sub, description: '', status: 'todo', priority: 'none', assigneeId: member(0), startDate: null, dueDate: day(6), estimateMinutes: null, labelIds: [] });
        }
      }
    }
    const audit2027 = await planner.createProject({ workspaceId: wsId, key: 'AUDIT', name: 'Annual audit prep', description: 'Evidence and schedules for the external auditors.', status: 'planned', ownerId: ids.get(people.ownerEmail) ?? null, startDate: day(20), dueDate: day(60), color: '#7c3aed' });
    await tasksSvc.create({ projectId: audit2027.id, parentTaskId: null, title: 'Agree audit timetable', description: '', status: 'todo', priority: 'medium', assigneeId: ids.get(people.ownerEmail) ?? null, startDate: day(20), dueDate: day(25), estimateMinutes: 60, labelIds: [audit.id] });

    // --- Calendar --------------------------------------------------------------------
    const nextMonday = new Date(today);
    nextMonday.setUTCDate(today.getUTCDate() + ((8 - today.getUTCDay()) % 7 || 7));
    const at = (d: Date, h: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0));
    await events.create({
      title: 'Weekly finance sync',
      description: 'Status of the close, blockers and cash position.',
      location: 'Board room / video call',
      kind: 'meeting',
      status: 'confirmed',
      startsAt: at(nextMonday, 14),
      endsAt: at(nextMonday, 15),
      allDay: false,
      timezone: tenant.timezone,
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=12',
      visibility: 'workspace',
      attendeeIds: [...ids.values()].filter((v) => v !== ids.get(people.ownerEmail)),
      reminderMinutes: [15],
    });
    const qr = new Date(today.getTime() + 12 * 86400_000);
    await events.create({ title: 'Quarterly business review', description: '', location: 'Main office', kind: 'meeting', status: 'confirmed', startsAt: at(qr, 15), endsAt: at(qr, 17), allDay: false, timezone: tenant.timezone, rrule: null, visibility: 'workspace', attendeeIds: [member(0), member(1)].filter((x): x is string => !!x), reminderMinutes: [60] });
    const vat = new Date(today.getTime() + 5 * 86400_000);
    await events.create({ title: 'Sales tax filing deadline', description: 'Submit the quarterly return.', location: '', kind: 'deadline', status: 'confirmed', startsAt: at(vat, 0), endsAt: at(vat, 23), allDay: true, timezone: tenant.timezone, rrule: null, visibility: 'workspace', attendeeIds: [], reminderMinutes: [1440] });

    // --- Files -------------------------------------------------------------------------
    const policies = await filesSvc.createFolder({ name: 'Policies', parentId: null, visibility: 'workspace' });
    const reports = await filesSvc.createFolder({ name: 'Reports', parentId: null, visibility: 'workspace' });
    await filesSvc.createFolder({ name: 'Board — confidential', parentId: null, visibility: 'restricted' });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    await filesSvc.upload(Buffer.from('# Expense policy\n\n- Receipts required above 25.00\n- Submit within 30 days\n- Travel booked through the portal\n'), 'Expense policy.md', { folderId: policies.id });
    await filesSvc.upload(pdf, 'Information security policy.pdf', { folderId: policies.id });
    await filesSvc.upload(Buffer.from('month,revenue,expenses\nJul,41200,33850\nAug,43900,35120\nSep,45310,36400\n'), 'Revenue by month.csv', { folderId: reports.id });
    await filesSvc.upload(Buffer.from('Welcome to the shared library. Organise documents into folders and share restricted ones deliberately.\n'), 'README.txt', { folderId: null });
  });
  // Seeded files are known-clean text/PDF; run them through the scanner like uploads.
  const versions = await db.select({ id: versionsTable.id }).from(versionsTable).innerJoin(filesTable, eqOp(filesTable.id, versionsTable.fileId));
  for (const v of versions) await filesSvc.scanVersion(tenantId, v.id);
  return true;
}
