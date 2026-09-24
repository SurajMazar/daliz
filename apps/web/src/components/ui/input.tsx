import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const inputClass =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 file:border-0 file:bg-transparent file:text-sm file:font-medium';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type ?? 'text'} className={cn(inputClass, className)} {...props} />;
}
