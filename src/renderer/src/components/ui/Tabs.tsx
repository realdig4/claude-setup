import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatCompact } from '../../lib/format'
import { transitions } from '../../lib/motion'

export interface TabItem<V extends string = string> {
  value: V
  label: ReactNode
  icon?: LucideIcon
  /** Small count after the label. */
  count?: number
  disabled?: boolean
}

export interface TabsProps<V extends string = string> {
  value: V
  onValueChange: (value: V) => void
  items: ReadonlyArray<TabItem<V>>
  /** 'underline' (page sections, default) or 'pill' (compact switchers inside cards). */
  variant?: 'underline' | 'pill'
  size?: 'sm' | 'md'
  /** Accessible name for the tab list. */
  'aria-label'?: string
  className?: string
  /** id prefix used to link tabs and panels: tab = `${idBase}-tab-${value}`, panel = `${idBase}-panel-${value}`. */
  idBase?: string
}

/**
 * Controlled tab list with an animated indicator. Render the active panel yourself (optionally with TabPanel).
 * Arrow keys move between tabs.
 * @example
 * <Tabs value={tab} onValueChange={setTab} items={[{ value: 'all', label: 'All', count: 24 }, { value: 'skills', label: 'Skills' }]} />
 */
export function Tabs<V extends string>({
  value,
  onValueChange,
  items,
  variant = 'underline',
  size = 'md',
  className,
  idBase,
  'aria-label': ariaLabel
}: TabsProps<V>) {
  const autoId = useId()
  const base = idBase ?? `tabs-${autoId}`
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = items.filter((i) => !i.disabled)
    const index = enabled.findIndex((i) => i.value === value)
    let next: TabItem<V> | undefined
    if (event.key === 'ArrowRight') next = enabled[(index + 1) % enabled.length]
    else if (event.key === 'ArrowLeft') next = enabled[(index - 1 + enabled.length) % enabled.length]
    else if (event.key === 'Home') next = enabled[0]
    else if (event.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    event.preventDefault()
    onValueChange(next.value)
    listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus()
  }

  const underline = variant === 'underline'
  return (
    <LayoutGroup id={base}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cn(
          'relative flex items-center',
          underline ? 'gap-1 border-b border-line' : 'gap-0.5 rounded-xl bg-surface-3/60 p-1 dark:bg-black/25',
          className
        )}
      >
        {items.map((item) => {
          const active = item.value === value
          const Icon = item.icon
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`${base}-tab-${item.value}`}
              aria-selected={active}
              aria-controls={idBase ? `${base}-panel-${item.value}` : undefined}
              tabIndex={active ? 0 : -1}
              data-value={item.value}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              className={cn(
                'relative inline-flex items-center gap-2 font-medium whitespace-nowrap transition-colors duration-150',
                'disabled:cursor-not-allowed disabled:opacity-45',
                underline
                  ? cn('-mb-px px-3', size === 'sm' ? 'h-9 text-[13px]' : 'h-10 text-sm')
                  : cn('rounded-lg px-3', size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8 text-[13px]'),
                active ? 'text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              {!underline && active ? (
                <motion.span
                  layoutId="tab-pill"
                  transition={transitions.indicator}
                  className="absolute inset-0 rounded-lg bg-surface shadow-sm ring-1 ring-line/70 dark:bg-surface-3 dark:ring-white/[0.06]"
                />
              ) : null}
              {Icon ? <Icon className={cn('relative size-4', active ? 'text-accent-text' : 'text-fg-subtle')} aria-hidden="true" /> : null}
              <span className="relative">{item.label}</span>
              {item.count !== undefined ? (
                <span
                  className={cn(
                    'relative rounded-md px-1.5 text-2xs leading-[18px] font-semibold tabular-nums',
                    active ? 'bg-accent-soft text-accent-text' : 'bg-surface-3/80 text-fg-subtle'
                  )}
                >
                  {formatCompact(item.count)}
                </span>
              ) : null}
              {underline && active ? (
                <motion.span
                  layoutId="tab-underline"
                  transition={transitions.indicator}
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                />
              ) : null}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}

export interface TabPanelProps {
  /** Same idBase passed to Tabs. */
  idBase: string
  value: string
  children: ReactNode
  className?: string
}

/** Accessible panel for a tab (pair with Tabs' idBase). */
export function TabPanel({ idBase, value, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${value}`}
      aria-labelledby={`${idBase}-tab-${value}`}
      tabIndex={0}
      className={cn('outline-none', className)}
    >
      {children}
    </div>
  )
}
