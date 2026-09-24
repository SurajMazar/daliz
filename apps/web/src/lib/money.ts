import { formatMoney as fmt, toUnits } from '@daliz/shared';

export const MONEY_INPUT_RE = /^\d{1,15}(\.\d{0,4})?$/;

/** Safe display of a money string; never parses through floating point. */
export function money(value: string | null | undefined, currency: string, locale?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return fmt(value, currency, locale);
  } catch {
    return value;
  }
}

/** Strict parse check for user-typed amounts ("", "12", "12.5"). */
export function isValidAmount(value: string): boolean {
  if (!value) return false;
  const v = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(v)) return false;
  return true;
}

export function amountOrZero(value: string): string {
  const v = value.trim().replace(/\.$/, '');
  return v && /^\d{1,15}(\.\d{1,4})?$/.test(v) ? v : '0';
}

export function isPositive(value: string): boolean {
  try {
    return toUnits(amountOrZero(value)) > 0n;
  } catch {
    return false;
  }
}
