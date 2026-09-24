import { describe, expect, it } from 'vitest';
import { fromUnits, journalEntryInputSchema, normalizeMoney, positiveMoneySchema, sumMoney, toUnits } from './accounting.js';

describe('money', () => {
  it('is exact where floating point is not', () => {
    expect(sumMoney(['0.1', '0.2'])).toBe('0.3000');
    expect(sumMoney(['999999999999999.9999', '0.0001'])).toBe('1000000000000000.0000');
    expect(fromUnits(toUnits('-12.5'))).toBe('-12.5000');
    expect(normalizeMoney('7')).toBe('7.0000');
  });

  it('rejects malformed amounts', () => {
    expect(() => toUnits('1e5')).toThrow();
    expect(() => toUnits('1.23456')).toThrow();
    expect(positiveMoneySchema.safeParse('0').success).toBe(false);
    expect(positiveMoneySchema.safeParse('-5').success).toBe(false);
    expect(positiveMoneySchema.parse('10.5')).toBe('10.5000');
  });
});

describe('journal entry schema', () => {
  const acct = '00000000-0000-4000-8000-000000000001';
  const acct2 = '00000000-0000-4000-8000-000000000002';
  it('requires balanced lines with exactly one side each', () => {
    const ok = journalEntryInputSchema.safeParse({
      entryDate: '2026-09-01',
      description: 'Rent',
      lines: [
        { accountId: acct, debit: '1200' },
        { accountId: acct2, credit: '1200.00' },
      ],
    });
    expect(ok.success).toBe(true);
    const unbalanced = journalEntryInputSchema.safeParse({
      entryDate: '2026-09-01',
      description: 'Rent',
      lines: [
        { accountId: acct, debit: '1200' },
        { accountId: acct2, credit: '1100' },
      ],
    });
    expect(unbalanced.success).toBe(false);
    const both = journalEntryInputSchema.safeParse({
      entryDate: '2026-09-01',
      description: 'x',
      lines: [
        { accountId: acct, debit: '5', credit: '5' },
        { accountId: acct2, credit: '0' },
      ],
    });
    expect(both.success).toBe(false);
    expect(journalEntryInputSchema.safeParse({ entryDate: '2026-02-30', description: 'x', lines: [] }).success).toBe(false);
  });
});
