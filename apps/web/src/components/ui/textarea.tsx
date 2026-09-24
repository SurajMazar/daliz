import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { inputClass } from './input';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(inputClass, 'h-auto min-h-20 py-2 leading-relaxed', className)} {...props} />;
}
