import { cn } from '../../lib/cn'

export type Status = 'ok' | 'warn' | 'error' | 'idle' | 'busy'

const COLORS: Record<Status, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  error: 'bg-danger',
  idle: 'bg-fg-subtle/60',
  busy: 'bg-accent'
}

const DEFAULT_LABELS: Record<Status, string> = {
  ok: 'Working',
  warn: 'Needs attention',
  error: 'Not working',
  idle: 'Off',
  busy: 'Working on it'
}

export interface StatusDotProps {
  status: Status
  /** Animated halo. Defaults to true for 'busy' and 'ok'. */
  pulse?: boolean
  size?: 'sm' | 'md'
  /** Screen-reader text (defaults to a plain description of the status). Pass null if a visible label exists. */
  label?: string | null
  className?: string
}

/**
 * Small colored status indicator with an optional soft pulse.
 * @example <StatusDot status="ok" /> Running
 */
export function StatusDot({ status, pulse, size = 'md', label, className }: StatusDotProps) {
  const animate = pulse ?? (status === 'busy' || status === 'ok')
  const text = label === undefined ? DEFAULT_LABELS[status] : label
  return (
    <span className={cn('relative inline-flex shrink-0', size === 'sm' ? 'size-1.5' : 'size-2', className)}>
      {animate ? (
        <span aria-hidden="true" className={cn('absolute inset-0 animate-ping-soft rounded-full', COLORS[status])} />
      ) : null}
      <span aria-hidden="true" className={cn('relative inline-flex size-full rounded-full', COLORS[status])} />
      {text ? <span className="sr-only">{text}</span> : null}
    </span>
  )
}
