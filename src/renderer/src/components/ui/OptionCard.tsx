import { isValidElement, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { IconProp } from './icon'
import { IconTile } from './IconTile'

export interface OptionCardProps {
  title: ReactNode
  description?: ReactNode
  /** Lucide icon (shown in a tile) or any element (Monogram, ServerIcon). */
  icon?: IconProp
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  /** 'radio' (pick one, default) or 'checkbox' (pick many). */
  type?: 'radio' | 'checkbox'
  disabled?: boolean
  /** Small element next to the title (e.g. <Badge>Recommended</Badge>). */
  badge?: ReactNode
  /** Extra non-interactive content under the description (meta line, tags). */
  children?: ReactNode
  /** 'md' (default) or 'lg' for hero choices in wizards. */
  size?: 'md' | 'lg'
  className?: string
}

/**
 * Big selectable card for friendly choices (pick apps, pick a provider). Renders a button with
 * role radio/checkbox — don't put other interactive elements inside.
 * @example
 * <OptionCardGroup label="Where should this tool be added?" type="checkbox">
 *   <OptionCard type="checkbox" icon={<Monogram text="Claude Desktop" />} title="Claude Desktop"
 *     description="The chat app" checked={sel.desktop} onCheckedChange={…} />
 * </OptionCardGroup>
 */
export function OptionCard({
  title,
  description,
  icon,
  checked,
  onCheckedChange,
  type = 'radio',
  disabled,
  badge,
  children,
  size = 'md',
  className
}: OptionCardProps) {
  return (
    <button
      type="button"
      role={type}
      aria-checked={checked}
      disabled={disabled}
      data-checked={checked}
      onClick={() => onCheckedChange?.(type === 'radio' ? true : !checked)}
      className={cn(
        'group relative flex w-full items-start gap-3.5 rounded-xl border text-left',
        'transition-[border-color,background-color,box-shadow] duration-150 ease-smooth',
        'disabled:cursor-not-allowed disabled:opacity-55',
        size === 'lg' ? 'p-5' : 'p-4',
        checked
          ? 'border-accent-line bg-accent-soft/45 shadow-xs ring-1 ring-accent/50'
          : 'border-line bg-surface shadow-xs hover:border-line-strong hover:bg-surface-2/40 hover:shadow-sm',
        className
      )}
    >
      {icon ? (
        <span className="shrink-0">
          {isValidElement(icon) ? icon : <IconTile icon={icon} tone={checked ? 'accent' : 'neutral'} size={size === 'lg' ? 'lg' : 'md'} />}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 pr-7">
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn('font-semibold text-fg', size === 'lg' ? 'text-[15px]' : 'text-sm')}>{title}</span>
          {badge}
        </span>
        {description ? (
          <span className={cn('mt-0.5 block text-fg-muted', size === 'lg' ? 'text-sm leading-6' : 'text-[13px] leading-5')}>
            {description}
          </span>
        ) : null}
        {children ? <span className="mt-2.5 block">{children}</span> : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-4 right-4 grid size-[18px] place-items-center border transition-colors duration-150',
          type === 'radio' ? 'rounded-full' : 'rounded-[5px]',
          checked ? 'border-accent-solid bg-accent-solid text-accent-fg' : 'border-line-strong bg-surface group-hover:border-fg-subtle'
        )}
      >
        {checked ? (
          type === 'radio' ? (
            <span className="size-1.5 rounded-full bg-accent-fg" />
          ) : (
            <Check className="size-3" strokeWidth={3} />
          )
        ) : null}
      </span>
    </button>
  )
}

export interface OptionCardGroupProps {
  /** Accessible group label (visible label optional via `title`). */
  label: string
  type?: 'radio' | 'checkbox'
  /** Grid columns at the default width (1–3). */
  columns?: 1 | 2 | 3
  className?: string
  children: ReactNode
}

/** Columns respond to the group's own width (container queries), so it works in dialogs and pages alike. */
const COLUMNS = { 1: 'grid-cols-1', 2: 'grid-cols-1 @md:grid-cols-2', 3: 'grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3' }

/** Grid wrapper for OptionCards with radiogroup/group semantics and arrow-key navigation. */
export function OptionCardGroup({ label, type = 'radio', columns = 2, className, children }: OptionCardGroupProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(`[role="${type}"]:not([disabled])`))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    buttons[(index + delta + buttons.length) % buttons.length]?.focus()
  }
  return (
    <div className={cn('@container', className)}>
      <div role={type === 'radio' ? 'radiogroup' : 'group'} aria-label={label} onKeyDown={onKeyDown} className={cn('grid gap-3', COLUMNS[columns])}>
        {children}
      </div>
    </div>
  )
}
