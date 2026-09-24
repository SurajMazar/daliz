import { Controller, Delete, Get, HttpCode, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  accountingSettingsSchema,
  asOfSchema,
  dateRangeSchema,
  daybookEntryInputSchema,
  daybookQuerySchema,
  journalEntryInputSchema,
  journalQuerySchema,
  ledgerAccountInputSchema,
  reverseJournalEntrySchema,
  updateJournalEntrySchema,
  updateLedgerAccountSchema,
} from '@daliz/shared';
import { z } from 'zod';
import { Idempotent, RequirePermissions, TenantScoped } from '../../common/http/decorators.js';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod.js';
import { AccountingService } from './accounting.service.js';
import { DaybookService } from './daybook.service.js';
import { ReportsService } from './reports.service.js';

const settingsUpdate = accountingSettingsSchema.extend({ version: z.number().int().min(0) });
const daybookUpdate = daybookEntryInputSchema.omit({ postImmediately: true }).extend({ version: z.number().int().min(1) });

@ApiTags('accounting')
@TenantScoped()
@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly reports: ReportsService,
  ) {}

  // --- Chart of accounts ---------------------------------------------------------

  @RequirePermissions('accounting.read')
  @Get('accounts')
  accounts(@Query('active') active?: string) {
    return this.accounting.listAccounts(active !== 'true');
  }

  @RequirePermissions('accounting.create')
  @Post('accounts')
  createAccount(@ZBody(ledgerAccountInputSchema) body: z.infer<typeof ledgerAccountInputSchema>) {
    return this.accounting.createAccount(body);
  }

  @RequirePermissions('accounting.update')
  @Patch('accounts/:id')
  async updateAccount(@IdParam() id: string, @ZBody(updateLedgerAccountSchema) body: z.infer<typeof updateLedgerAccountSchema>) {
    await this.accounting.updateAccount(id, body);
    return { ok: true };
  }

  // --- Journal entries ---------------------------------------------------------------

  @RequirePermissions('accounting.read')
  @Get('journal-entries')
  entries(@ZQuery(journalQuerySchema) q: z.infer<typeof journalQuerySchema>) {
    return this.accounting.listEntries(q);
  }

  @RequirePermissions('accounting.read')
  @Get('journal-entries/:id')
  entry(@IdParam() id: string) {
    return this.accounting.getEntry(id);
  }

  @RequirePermissions('accounting.create')
  @Idempotent()
  @Post('journal-entries')
  async create(@ZBody(journalEntryInputSchema) body: z.infer<typeof journalEntryInputSchema>) {
    const { id } = await this.accounting.createEntry(body);
    return this.accounting.getEntry(id);
  }

  @RequirePermissions('accounting.update')
  @Put('journal-entries/:id')
  update(@IdParam() id: string, @ZBody(updateJournalEntrySchema) body: z.infer<typeof updateJournalEntrySchema>) {
    return this.accounting.updateEntry(id, body);
  }

  @RequirePermissions('accounting.delete')
  @Delete('journal-entries/:id')
  async remove(@IdParam() id: string) {
    await this.accounting.deleteEntry(id);
    return { ok: true };
  }

  @RequirePermissions('accounting.create')
  @Post('journal-entries/:id/submit')
  @HttpCode(200)
  submit(@IdParam() id: string) {
    return this.accounting.submit(id);
  }

  @RequirePermissions('accounting.approve')
  @Post('journal-entries/:id/approve')
  @HttpCode(200)
  approve(@IdParam() id: string) {
    return this.accounting.approve(id);
  }

  @RequirePermissions('accounting.approve')
  @Idempotent()
  @Post('journal-entries/:id/post')
  @HttpCode(200)
  post(@IdParam() id: string) {
    return this.accounting.post(id);
  }

  @RequirePermissions('accounting.approve')
  @Idempotent()
  @Post('journal-entries/:id/reverse')
  @HttpCode(200)
  reverse(@IdParam() id: string, @ZBody(reverseJournalEntrySchema) body: z.infer<typeof reverseJournalEntrySchema>) {
    return this.accounting.reverse(id, body);
  }

  // --- Reports ----------------------------------------------------------------------------

  @RequirePermissions('accounting.read')
  @Get('reports/trial-balance')
  trialBalance(@ZQuery(asOfSchema) q: z.infer<typeof asOfSchema>) {
    return this.reports.trialBalance(q.asOf);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/ledger/:id')
  ledger(@IdParam() id: string, @ZQuery(dateRangeSchema) q: z.infer<typeof dateRangeSchema>) {
    return this.reports.ledger(id, q.from, q.to);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/income-statement')
  incomeStatement(@ZQuery(dateRangeSchema) q: z.infer<typeof dateRangeSchema>) {
    return this.reports.incomeStatement(q.from, q.to);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/balance-sheet')
  balanceSheet(@ZQuery(asOfSchema) q: z.infer<typeof asOfSchema>) {
    return this.reports.balanceSheet(q.asOf);
  }

  // --- Settings -------------------------------------------------------------------------------

  @RequirePermissions('accounting.read')
  @Get('settings')
  settings() {
    return this.accounting.settings();
  }

  @RequirePermissions('accounting.approve', 'settings.update')
  @Put('settings')
  updateSettings(@ZBody(settingsUpdate) body: z.infer<typeof settingsUpdate>) {
    const { version, ...value } = body;
    return this.accounting.updateSettings(value, version);
  }
}

@ApiTags('daybook')
@TenantScoped()
@Controller('daybook')
export class DaybookController {
  constructor(private readonly daybook: DaybookService) {}

  @RequirePermissions('daybook.read')
  @Get('entries')
  list(@ZQuery(daybookQuerySchema) q: z.infer<typeof daybookQuerySchema>) {
    return this.daybook.list(q);
  }

  @RequirePermissions('daybook.read')
  @Get('entries/:id')
  get(@IdParam() id: string) {
    return this.daybook.get(id);
  }

  @RequirePermissions('daybook.create')
  @Idempotent()
  @Post('entries')
  create(@ZBody(daybookEntryInputSchema) body: z.infer<typeof daybookEntryInputSchema>) {
    return this.daybook.create(body);
  }

  @RequirePermissions('daybook.update')
  @Put('entries/:id')
  update(@IdParam() id: string, @ZBody(daybookUpdate) body: z.infer<typeof daybookUpdate>) {
    return this.daybook.update(id, { ...body, postImmediately: false });
  }

  @RequirePermissions('daybook.delete')
  @Post('entries/:id/void')
  @HttpCode(200)
  async void(@IdParam() id: string) {
    await this.daybook.void(id);
    return { ok: true };
  }

  @RequirePermissions('daybook.read')
  @Get('summary')
  summary(@ZQuery(dateRangeSchema) q: z.infer<typeof dateRangeSchema>) {
    return this.daybook.summary(q.from, q.to);
  }

  /** Money and category accounts for the entry form (no accounting.read needed). */
  @RequirePermissions('daybook.read')
  @Get('accounts')
  accounts() {
    return this.daybook.formAccounts();
  }
}
