import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/12 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        // Soft tokens (07 §9.3 F2): text-on-tint pairs that pass AA in every theme (5.7-9.6:1).
        success: 'border-transparent bg-success-soft text-success-fg',
        warning: 'border-transparent bg-warning-soft text-warning-fg',
        destructive: 'border-transparent bg-destructive-soft text-destructive-fg',
        info: 'border-transparent bg-info-soft text-info-fg',
        neutral: 'border-transparent bg-neutral-soft text-neutral-fg',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
