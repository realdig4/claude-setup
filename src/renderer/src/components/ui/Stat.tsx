import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { Tone } from './Badge'
import type { IconProp } from './icon'
import { IconTile } from './IconTile'

export interface StatProps {
  label: ReactNode
  value: ReactNode
  icon?: IconProp
  tone?: Tone
  /** Quiet line under the value ("across 3 apps"). */
  hint?: ReactNode
  /** Makes the whole tile a button. */
  onClick?: () => void
  className?: string
}

/**
 * Metric tile for dashboards (Home).
 * @example <Stat icon={Blocks} label="Tools installed" value={12} hint="across 3 apps" onClick={() => navigate('installed')} />
 */
export function Stat({ label, value, icon, tone = 'accent', hint, onClick, className }: StatProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] leading-5 font-medium text-fg-muted">{label}</span>
        {icon ? <IconTile icon={icon} tone={tone} size="sm" /> : null}
      </div>
      <div className="mt-1.5 text-[26px] leading-8 font-semibold tracking-[-0.02em] text-fg tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-fg-subtle">{hint}</div> : null}
    </>
  )
  const classes = cn('block w-full rounded-xl border border-line bg-surface p-4 text-left shadow-xs', className)
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          classes,
          'transition-[border-color,box-shadow,transform] duration-200 ease-smooth',
          'hover:-translate-y-px hover:border-line-strong hover:shadow-md'
        )}
      >
        {body}
      </button>
    )
  }
  return <div className={classes}>{body}</div>
}
