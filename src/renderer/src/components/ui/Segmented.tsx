import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transitions } from '../../lib/motion'

export interface SegmentedOption<V extends string = string> {
  value: V
  label?: ReactNode
  icon?: LucideIcon
  /** Required for icon-only options. */
  'aria-label'?: string
  disabled?: boolean
}

export interface SegmentedProps<V extends string = string> {
  value: V
  onValueChange: (value: V) => void
  options: ReadonlyArray<SegmentedOption<V>>
  size?: 'sm' | 'md'
  /** Stretch options to fill the width. */
  fullWidth?: boolean
  /** Accessible name of the group. */
  'aria-label': string
  className?: string
}

/**
 * Compact single-choice control with a sliding thumb (radiogroup semantics).
 * @example
 * <Segmented aria-label="Mode" value={mode} onValueChange={setMode}
 *   options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]} />
 */
export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  size = 'md',
  fullWidth,
  className,
  'aria-label': ariaLabel
}: SegmentedProps<V>) {
  const groupId = useId()
  const ref = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = options.filter((o) => !o.disabled)
    const index = enabled.findIndex((o) => o.value === value)
    let next: SegmentedOption<V> | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length]
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length]
    if (!next) return
    event.preventDefault()
    onValueChange(next.value)
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus()
  }

  return (
    <LayoutGroup id={groupId}>
      <div
        ref={ref}
        role="radiogroup"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cn(
          'relative inline-flex items-center gap-0.5 rounded-[10px] bg-surface-3/70 p-0.5 dark:bg-black/25',
          fullWidth && 'flex w-full',
          className
        )}
      >
        {options.map((option) => {
          const active = option.value === value
          const Icon = option.icon
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option['aria-label']}
              tabIndex={active ? 0 : -1}
              data-value={option.value}
              disabled={option.disabled}
              onClick={() => onValueChange(option.value)}
              className={cn(
                'relative inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors duration-150',
                'disabled:cursor-not-allowed disabled:opacity-45',
                size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13px]',
                !option.label && (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0'),
                fullWidth && 'flex-1',
                active ? 'text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              {active ? (
                <motion.span
                  layoutId="segmented-thumb"
                  transition={transitions.indicator}
                  className="absolute inset-0 rounded-lg bg-surface shadow-sm ring-1 ring-line/70 dark:bg-surface-3 dark:ring-white/[0.06]"
                />
              ) : null}
              {Icon ? <Icon className={cn('relative size-[15px]', active && 'text-accent-text')} aria-hidden="true" /> : null}
              {option.label ? <span className="relative">{option.label}</span> : null}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
