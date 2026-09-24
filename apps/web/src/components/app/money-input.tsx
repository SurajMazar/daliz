import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Amount entry as a string (money is never a float). Accepts digits and up to 4 decimals;
 * anything else typed is ignored.
 */
export function MoneyInput({ value, onValueChange, className, ...props }: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & { value: string; onValueChange: (v: string) => void }) {
  return (
    <Input
      {...props}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      className={cn('text-right font-mono tabular-nums', className)}
      onChange={(e) => {
        const v = e.target.value.replace(/,/g, '').trim();
        if (v === '' || /^\d{0,15}(\.\d{0,4})?$/.test(v)) onValueChange(v);
      }}
    />
  );
}
