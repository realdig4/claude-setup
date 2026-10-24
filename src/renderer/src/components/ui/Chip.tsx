import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatCompact } from '../../lib/format'

export interface ChipProps extends ComponentProps<'button'> {
  selected?: boolean
  icon?: LucideIcon
  /** Small count after the label. */
  count?: number
  size?: 'sm' | 'md'
}

/**
 * Toggleable filter pill (categories, sources, kinds). Use aria-pressed semantics.
 * @example <Chip selected={cat === 'databases'} count={42} onClick={() => setCat('databases')}>Databases</Chip>
 */
export function Chip({ selected = false, icon: Icon, count, size = 'md', className, children, type = 'button', ...props }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        'transition-[background-color,border-color,color] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        selected
          ? 'border-transparent bg-inverse text-fg-inverse shadow-sm'
          : 'border-line bg-surface text-fg-muted shadow-xs hover:border-line-strong hover:text-fg',
        className
      )}
      {...props}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {children}
      {count !== undefined ? (
        <span className={cn('tabular-nums', selected ? 'text-fg-inverse/70' : 'text-fg-subtle')}>{formatCompact(count)}</span>
      ) : null}
    </button>
  )
}
