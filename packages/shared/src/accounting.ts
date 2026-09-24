/**
 * Accounting contract: exact decimal money helpers, request schemas and response types.
 *
 * Money is always a decimal string with up to 4 fraction digits ("1250.5", "0.0001").
 * Arithmetic uses BigInt minor units (1 unit = 0.0001), never floating point.
 */
import { z } from 'zod';

export const MONEY_SCALE = 4;
const SCALE = 10n ** BigInt(MONEY_SCALE);
const MONEY_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

export function toUnits(value: string): bigint {
  if (!MONEY_RE.test(value)) throw new Error(`Invalid money value: ${value}`);
  const negative = value.startsWith('-');
  const [whole, frac = ''] = value.replace('-', '').split('.');
  const units = BigInt(whole!) * SCALE + BigInt((frac + '0000').slice(0, MONEY_SCALE));
  return negative ? -units : units;
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Normalizes to exactly 4 fraction digits: "12.5" → "12.5000". */
export function normalizeMoney(value: string): string {
  return fromUnits(toUnits(value));
}

export function sumMoney(values: readonly string[]): string {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(v), 0n));
}

export function isZero(value: string): boolean {
  return toUnits(value) === 0n;
}

/** Formats for display in a locale/currency; rounding happens only here, at the edge. */
export function formatMoney(value: string, currency: string, locale = 'en-US'): string {
  const units = toUnits(value);
  // Split into whole and fraction to avoid Number precision loss on large values.
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rounded = (units + (units >= 0n ? 50n : -50n)) / 100n; // to cents, half away from zero
  const asNumber = Number(rounded) / 100;
  if (Number.isSafeInteger(Number(rounded))) return fmt.format(asNumber);
  return `${fromUnits(units)} ${currency}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const positiveMoneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter an amount such as 1250.00')
  .refine((v) => toUnits(v) > 0n, 'Amount must be greater than zero')
  .transform(normalizeMoney);

export const optionalMoneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter an amount such as 1250.00')
  .transform(normalizeMoney);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Not a real date');

export const LEDGER_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];
export const LEDGER_ACCOUNT_SUBTYPES = ['cash', 'bank', 'receivable', 'payable', 'tax', 'retained_earnings', 'inventory', 'fixed_asset', 'other'] as const;
export type LedgerAccountSubtype = (typeof LEDGER_ACCOUNT_SUBTYPES)[number];

/** Accounts whose balance normally sits on the debit side. */
export const DEBIT_NORMAL: readonly LedgerAccountType[] = ['asset', 'expense'];

export const ledgerAccountInputSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/, 'Use up to 20 letters, digits, dots or hyphens'),
  name: z.string().trim().min(2).max(120),
  type: z.enum(LEDGER_ACCOUNT_TYPES),
  subtype: z.enum(LEDGER_ACCOUNT_SUBTYPES).default('other'),
  parentId: z.string().uuid().nullable().default(null),
  description: z.string().trim().max(500).default(''),
});
export type LedgerAccountInput = z.infer<typeof ledgerAccountInputSchema>;

export const updateLedgerAccountSchema = ledgerAccountInputSchema.partial().extend({
  isActive: z.boolean().optional(),
  version: z.number().int().min(1),
});

export const journalLineInputSchema = z
  .object({
    accountId: z.string().uuid(),
    description: z.string().trim().max(300).default(''),
    debit: optionalMoneySchema.default('0.0000'),
    credit: optionalMoneySchema.default('0.0000'),
  })
  .refine((l) => (toUnits(l.debit) > 0n) !== (toUnits(l.credit) > 0n), {
    message: 'Each line needs either a debit or a credit',
    path: ['debit'],
  });

export const journalEntryInputSchema = z
  .object({
    entryDate: isoDateSchema,
    description: z.string().trim().min(1, 'Required').max(500),
    reference: z.string().trim().max(100).nullable().default(null),
    lines: z.array(journalLineInputSchema).min(2, 'At least two lines').max(200),
  })
  .refine((e) => sumMoney(e.lines.map((l) => l.debit)) === sumMoney(e.lines.map((l) => l.credit)), {
    message: 'Debits and credits must be equal',
    path: ['lines'],
  });
export type JournalEntryInput = z.infer<typeof journalEntryInputSchema>;

export const updateJournalEntrySchema = z.object({
  entryDate: isoDateSchema,
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(100).nullable().default(null),
  lines: z.array(journalLineInputSchema).min(2).max(200),
  version: z.number().int().min(1),
});

export const reverseJournalEntrySchema = z.object({
  entryDate: isoDateSchema,
  reason: z.string().trim().min(5, 'Give a reason (5+ characters)').max(500),
});

export const journalQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'pending', 'approved', 'posted', 'reversed']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  accountId: z.string().uuid().optional(),
});

export const DAYBOOK_KINDS = ['income', 'expense', 'transfer'] as const;
export type DaybookKind = (typeof DAYBOOK_KINDS)[number];

export const daybookEntryInputSchema = z.object({
  entryDate: isoDateSchema,
  kind: z.enum(DAYBOOK_KINDS),
  amount: positiveMoneySchema,
  moneyAccountId: z.string().uuid(),
  counterAccountId: z.string().uuid(),
  counterparty: z.string().trim().max(200).nullable().default(null),
  description: z.string().trim().min(1, 'Required').max(500),
  reference: z.string().trim().max(100).nullable().default(null),
  /** Post straight to the ledger (needs accounting.approve); otherwise it waits for approval. */
  postImmediately: z.boolean().default(false),
});
export type DaybookEntryInput = z.infer<typeof daybookEntryInputSchema>;

export const daybookQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  kind: z.enum(DAYBOOK_KINDS).optional(),
  status: z.enum(['pending', 'posted', 'void']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  moneyAccountId: z.string().uuid().optional(),
});

export const accountingSettingsSchema = z.object({
  /** Entries dated on or before this date can't be posted or reversed into. */
  lockDate: isoDateSchema.nullable(),
  /** When false, users with accounting.approve can post drafts directly. */
  requireApproval: z.boolean(),
  /** When true, the person who created an entry can't approve it. */
  segregationOfDuties: z.boolean(),
});
export type AccountingSettings = z.infer<typeof accountingSettingsSchema>;

export const dateRangeSchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((r) => r.from <= r.to, { message: '"from" must be on or before "to"', path: ['from'] });
export const asOfSchema = z.object({ asOf: isoDateSchema });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  subtype: LedgerAccountSubtype;
  parentId: string | null;
  description: string;
  isActive: boolean;
  isSystem: boolean;
  /** Signed in the account's normal direction (positive = normal balance). */
  balance: string;
  hasPostings: boolean;
  version: number;
}

export type JournalStatus = 'draft' | 'pending' | 'approved' | 'posted' | 'reversed';

export interface JournalLineRow {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string;
  debit: string;
  credit: string;
}

export interface JournalEntryRow {
  id: string;
  number: string | null;
  entryDate: string;
  description: string;
  reference: string | null;
  source: 'manual' | 'daybook' | 'reversal' | 'opening';
  status: JournalStatus;
  totalAmount: string;
  createdBy: { id: string; name: string } | null;
  submittedBy: { id: string; name: string } | null;
  submittedAt: string | null;
  approvedBy: { id: string; name: string } | null;
  approvedAt: string | null;
  postedBy: { id: string; name: string } | null;
  postedAt: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  reversalReason: string | null;
  createdAt: string;
  version: number;
  lines?: JournalLineRow[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

export interface LedgerReport {
  account: { id: string; code: string; name: string; type: LedgerAccountType };
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  lines: {
    entryId: string;
    number: string;
    entryDate: string;
    description: string;
    lineDescription: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
}

export interface StatementSection {
  title: string;
  accounts: { accountId: string; code: string; name: string; amount: string }[];
  total: string;
}

export interface IncomeStatement {
  from: string;
  to: string;
  income: StatementSection;
  expenses: StatementSection;
  netIncome: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /** Income minus expenses not yet closed to retained earnings. */
  currentEarnings: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

export interface DaybookEntryRow {
  id: string;
  entryDate: string;
  kind: DaybookKind;
  amount: string;
  moneyAccount: { id: string; code: string; name: string };
  counterAccount: { id: string; code: string; name: string };
  counterparty: string | null;
  description: string;
  reference: string | null;
  status: 'pending' | 'posted' | 'void';
  journalEntryId: string | null;
  journalNumber: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  version: number;
}

export interface DaybookSummary {
  from: string;
  to: string;
  income: string;
  expense: string;
  net: string;
  byAccount: { accountId: string; code: string; name: string; inflow: string; outflow: string; balance: string }[];
}
