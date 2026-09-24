import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative flex w-full gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      info: 'border-primary/30 bg-primary/5 text-foreground [&>svg]:text-primary',
      success: 'border-success/30 bg-success/5 text-foreground [&>svg]:text-success',
      warning: 'border-warning/30 bg-warning/5 text-foreground [&>svg]:text-warning',
      destructive: 'border-destructive/30 bg-destructive/5 text-foreground [&>svg]:text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

const ICONS = { default: Info, info: Info, success: CircleCheck, warning: TriangleAlert, destructive: CircleAlert } as const;

export function Alert({
  className,
  variant,
  title,
  children,
  icon,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & VariantProps<typeof alertVariants> & { title?: ReactNode; icon?: ReactNode }) {
  const Icon = ICONS[variant ?? 'default'];
  return (
    <div role={variant === 'destructive' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)} {...props}>
      {icon ?? <Icon aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <div className="leading-snug font-medium">{title}</div> : null}
        {children ? <div className="text-muted-foreground [&_p]:leading-relaxed">{children}</div> : null}
      </div>
    </div>
  );
}
