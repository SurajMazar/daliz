import { Avatar as AvatarPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn, initials } from '@/lib/utils';

export function Avatar({ className, name, src, ...props }: ComponentProps<typeof AvatarPrimitive.Root> & { name?: string | null; src?: string | null }) {
  return (
    <AvatarPrimitive.Root className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)} {...props}>
      {src ? <AvatarPrimitive.Image src={src} alt="" className="aspect-square size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center bg-primary/10 text-xs font-semibold text-primary">
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
