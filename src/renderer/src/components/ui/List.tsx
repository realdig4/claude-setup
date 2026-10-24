import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface ListProps {
  children: ReactNode
  /** Optional heading row inside the card. */
  header?: ReactNode
  /** 'card' (default: bordered surface with dividers) or 'plain' (dividers only). */
  variant?: 'card' | 'plain'
  className?: string
  'aria-label'?: string
}

/**
 * Vertical list of rows with hairline dividers — settings, installed tools, checks, backups.
 * @example
 * <List aria-label="Installed tools">
 *   <ListItem media={<ServerIcon … />} title="GitHub" description="Claude Code · user" actions={<Switch … />} />
 * </List>
 */
export function List({ children, header, variant = 'card', className, 'aria-label': ariaLabel }: ListProps) {
  return (
    <div className={cn(variant === 'card' && 'overflow-hidden rounded-xl border border-line bg-surface shadow-xs', className)}>
      {header ? <div className="border-b border-line bg-surface-2/50 px-4 py-2.5 text-xs font-semibold text-fg-muted">{header}</div> : null}
      <ul aria-label={ariaLabel} className="divide-y divide-line">
        {children}
      </ul>
    </div>
  )
}

export interface ListItemProps {
  title: ReactNode
  description?: ReactNode
  /** Left element: ServerIcon, Monogram, IconTile, StatusDot… */
  media?: ReactNode
  /** Small right-aligned text before actions (e.g. "2 hours ago"). */
  meta?: ReactNode
  /** Right-aligned controls (Switch, Button, Menu). Clicks here don't trigger onClick. */
  actions?: ReactNode
  /** Makes the row clickable (shows a chevron when there are no actions). */
  onClick?: () => void
  /** Content under the main row (expanded details). */
  children?: ReactNode
  /** Dim the row (e.g. a disabled tool). */
  muted?: boolean
  className?: string
}

/** One row of a List. */
export function ListItem({ title, description, media, meta, actions, onClick, children, muted, className }: ListItemProps) {
  const clickable = !!onClick
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable || event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick?.()
    }
  }
  return (
    <li className={cn('relative', className)}>
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          'flex items-center gap-3.5 px-4 py-3.5',
          clickable && 'cursor-pointer transition-colors duration-150 hover:bg-surface-2/60 focus-visible:-outline-offset-2',
          muted && 'opacity-60'
        )}
      >
        {media ? <div className="flex shrink-0 items-center">{media}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-5 font-medium text-fg">{title}</div>
          {description ? <div className="mt-0.5 truncate text-[13px] leading-5 text-fg-muted">{description}</div> : null}
        </div>
        {meta ? <div className="shrink-0 text-xs text-fg-subtle tabular-nums">{meta}</div> : null}
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {actions}
          </div>
        ) : clickable ? (
          <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        ) : null}
      </div>
      {children ? <div className="px-4 pb-4">{children}</div> : null}
    </li>
  )
}
