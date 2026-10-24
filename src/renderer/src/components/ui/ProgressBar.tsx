import { cn } from '../../lib/cn'

export interface ProgressBarProps {
  /** 0–100. Omit for an indeterminate (unknown duration) bar. */
  value?: number
  /** Accessible name, e.g. "Installing GitHub". */
  label: string
  tone?: 'accent' | 'success' | 'warn' | 'danger'
  size?: 'sm' | 'md'
  /** Show the percentage on the right. */
  showValue?: boolean
  className?: string
}

const TONES = { accent: 'bg-accent', success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' }

/**
 * Determinate or indeterminate progress bar.
 * @example <ProgressBar label="Refreshing catalog" value={pct} showValue />
 */
export function ProgressBar({ value, label, tone = 'accent', size = 'md', showValue, className }: ProgressBarProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value)
  const pct = determinate ? Math.min(100, Math.max(0, value)) : 0
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? Math.round(pct) : undefined}
        className={cn('relative flex-1 overflow-hidden rounded-full bg-surface-3', size === 'sm' ? 'h-1' : 'h-1.5')}
      >
        {determinate ? (
          <div className={cn('h-full rounded-full transition-[width] duration-300 ease-smooth', TONES[tone])} style={{ width: `${pct}%` }} />
        ) : (
          <div className={cn('absolute inset-y-0 left-0 w-2/5 animate-indeterminate rounded-full', TONES[tone])} />
        )}
      </div>
      {showValue && determinate ? (
        <span className="w-9 shrink-0 text-right text-xs font-medium text-fg-muted tabular-nums">{Math.round(pct)}%</span>
      ) : null}
    </div>
  )
}
