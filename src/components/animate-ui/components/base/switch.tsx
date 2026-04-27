import * as React from 'react';

import {
  Switch as SwitchPrimitive,
  SwitchThumb as SwitchThumbPrimitive,
  SwitchIcon as SwitchIconPrimitive,
  type SwitchProps as SwitchPrimitiveProps,
} from '@/components/animate-ui/primitives/base/switch';
import { cn } from '@/lib/utils';
import { playUi } from '@/lib/ui-sounds';

// Re-skinned to match our existing Toggle visual: track 38×22, thumb 18,
// off-state uses --bg-active with inset border, on-state uses --accent. Keeps
// the animate-ui spring/squish thumb behavior while adopting our palette.
//
// Sound: emits switchOn / switchOff on commit (animate-ui exposes
// onCheckedChange via the primitive, identical to its base-ui parent).

type SwitchProps = SwitchPrimitiveProps & {
  pressedWidth?: number;
  startIcon?: React.ReactElement;
  endIcon?: React.ReactElement;
  thumbIcon?: React.ReactElement;
  /** Skip the switchOn / switchOff sound. */
  silent?: boolean;
};

function Switch({
  className,
  pressedWidth = 21,
  startIcon,
  endIcon,
  thumbIcon,
  silent,
  onCheckedChange,
  ...props
}: SwitchProps) {
  const handleChange: NonNullable<SwitchPrimitiveProps['onCheckedChange']> = (
    checked,
    event,
  ) => {
    if (!silent) playUi(checked ? 'switchOn' : 'switchOff');
    onCheckedChange?.(checked, event);
  };

  return (
    <SwitchPrimitive
      onCheckedChange={handleChange}
      className={cn(
        'relative peer flex shrink-0 items-center justify-start rounded-full outline-none transition-colors duration-200',
        'h-[22px] w-[38px] px-px',
        'data-[checked]:bg-[var(--accent)] data-[unchecked]:bg-[var(--bg-active)]',
        'data-[checked]:justify-end',
        'shadow-[inset_0_0_0_0.5px_var(--border)] data-[checked]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.10),inset_0_1px_1px_rgba(0,0,0,0.10)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchThumbPrimitive
        className={cn(
          'relative z-10 pointer-events-none block size-[18px] rounded-full bg-white',
          'shadow-[0_1px_3px_rgba(0,0,0,0.25)]',
        )}
        pressedAnimation={{ width: pressedWidth }}
      >
        {thumbIcon && (
          <SwitchIconPrimitive
            position="thumb"
            className="absolute [&_svg]:size-[10px] left-1/2 top-1/2 -translate-1/2 text-[var(--fg-muted)]"
          >
            {thumbIcon}
          </SwitchIconPrimitive>
        )}
      </SwitchThumbPrimitive>

      {startIcon && (
        <SwitchIconPrimitive
          position="left"
          className="absolute [&_svg]:size-[10px] left-1 top-1/2 -translate-y-1/2 text-white/85"
        >
          {startIcon}
        </SwitchIconPrimitive>
      )}
      {endIcon && (
        <SwitchIconPrimitive
          position="right"
          className="absolute [&_svg]:size-[10px] right-1 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]"
        >
          {endIcon}
        </SwitchIconPrimitive>
      )}
    </SwitchPrimitive>
  );
}

export { Switch, type SwitchProps };
