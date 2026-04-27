import * as React from 'react';

import {
  Checkbox as CheckboxPrimitive,
  CheckboxIndicator as CheckboxIndicatorPrimitive,
  type CheckboxProps as CheckboxPrimitiveProps,
} from '@/components/animate-ui/primitives/base/checkbox';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import { playUi } from '@/lib/ui-sounds';

// Re-skinned to match our card-glass aesthetic: --bg-input surface, --border-strong
// resting border, --accent fill on checked. Keeps the animate-ui motion-driven
// indicator (spring scale-in on tick).

const checkboxVariants = cva(
  cn(
    'peer shrink-0 flex items-center justify-center outline-none transition-all duration-200',
    'disabled:cursor-not-allowed disabled:opacity-50',
    "[&[data-checked],&[data-indeterminate]]:bg-[var(--accent)] [&[data-checked],&[data-indeterminate]]:text-white [&[data-checked],&[data-indeterminate]]:border-transparent",
    "[&[data-checked],&[data-indeterminate]]:shadow-[0_1px_2px_rgba(10,132,255,0.3),inset_0_1px_0_rgba(255,255,255,0.18)]",
  ),
  {
    variants: {
      variant: {
        default:
          'bg-[var(--bg-input)] border border-[var(--border-strong)] hover:border-[var(--accent)]',
        accent: 'bg-[var(--bg-active)] border border-transparent',
      },
      size: {
        default: 'size-5 rounded-[5px]',
        sm: 'size-4 rounded-[4px]',
        lg: 'size-6 rounded-[7px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const checkboxIndicatorVariants = cva('', {
  variants: {
    size: {
      default: 'size-3.5',
      sm: 'size-3',
      lg: 'size-4',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

type CheckboxProps = CheckboxPrimitiveProps &
  VariantProps<typeof checkboxVariants> & {
    children?: React.ReactNode;
    silent?: boolean;
  };

function Checkbox({
  className,
  children,
  variant,
  size,
  silent,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const handleChange: NonNullable<CheckboxPrimitiveProps['onCheckedChange']> = (
    checked,
    event,
  ) => {
    if (!silent) playUi(checked === true ? 'switchOn' : 'switchOff');
    onCheckedChange?.(checked, event);
  };

  return (
    <CheckboxPrimitive
      onCheckedChange={handleChange}
      className={cn(checkboxVariants({ variant, size, className }))}
      {...props}
    >
      {children}
      <CheckboxIndicatorPrimitive
        className={cn(checkboxIndicatorVariants({ size }))}
      />
    </CheckboxPrimitive>
  );
}

export { Checkbox, type CheckboxProps };
