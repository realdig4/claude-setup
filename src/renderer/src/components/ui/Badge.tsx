import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { renderIcon, type IconProp } from './icon'

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'
export type BadgeSize = 'sm' | 'md'

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: Tone
  size?: BadgeSize
  /** 'soft' (tinted, default), 'outline' (border only) or 'solid' (strong emphasis). */
  variant?: 'soft' | 'outline' | 'solid'
  icon?: IconProp
  /** Small colored dot before the label. */
  dot?: boolean
}

const SOFT: Record<Tone, string> = {
  neutral: 'bg-surface-3/70 text-fg-muted border-transparent',
  accent: 'bg-accent-soft text-accent-text border-accent-line/50',
  success: 'bg-success-soft text-success-text border-success-line/50',
  warn: 'bg-warn-soft text-warn-text border-warn-line/60',
  danger: 'bg-danger-soft text-danger-text border-danger-line/50',
  info: 'bg-info-soft text-info-text border-info-line/50'
}

const OUTLINE: Record<Tone, string> = {
  neutral: 'border-line text-fg-muted',
  accent: 'border-accent-line text-accent-text',
  success: 'border-success-line text-success-text',
  warn: 'border-warn-line text-warn-text',
  danger: 'border-danger-line text-danger-text',
  info: 'border-info-line text-info-text'
}

const SOLID: Record<Tone, string> = {
  neutral: 'bg-inverse text-fg-inverse border-transparent',
  accent: 'bg-accent-solid text-accent-fg border-transparent',
  success: 'bg-success-text text-canvas border-transparent',
  warn: 'bg-warn text-[oklch(0.25_0.04_60)] border-transparent',
  danger: 'bg-danger-solid text-white border-transparent',
  info: 'bg-info-text text-canvas border-transparent'
}

const DOTS: Record<Tone, string> = {
  neutral: 'bg-fg-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info'
}

const SIZES: Record<BadgeSize, string> = {
  sm: 'h-5 gap-1 rounded-md px-1.5 text-2xs [&>svg]:size-3',
  md: 'h-6 gap-1.5 rounded-lg px-2 text-xs [&>svg]:size-3.5'
}

/**
 * Small status label.
 * @example <Badge tone="success" icon={Check}>Installed</Badge>
 * @example <Badge tone="warn" dot>Needs restart</Badge>
 */
export function Badge({ tone = 'neutral', size = 'md', variant = 'soft', icon, dot, className, children, ...props }: BadgeProps) {
  const colors = variant === 'outline' ? OUTLINE[tone] : variant === 'solid' ? SOLID[tone] : SOFT[tone]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center border font-medium whitespace-nowrap tabular-nums [&>svg]:shrink-0',
        SIZES[size],
        colors,
        className
      )}
      {...props}
    >
      {dot ? <span aria-hidden="true" className={cn('size-1.5 rounded-full', DOTS[tone])} /> : null}
      {renderIcon(icon)}
      {children}
    </span>
  )
}
