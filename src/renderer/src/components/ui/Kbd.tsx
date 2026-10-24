import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { isMac } from '../../lib/hooks'
import { hotkeyLabels } from '../../lib/keys'

/** A single keyboard key cap. @example <Kbd>Esc</Kbd> */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-surface px-1',
        'font-sans text-[11px] leading-none font-medium text-fg-subtle',
        'shadow-[inset_0_-1px_0_var(--color-line)]',
        className
      )}
      {...props}
    />
  )
}

export interface ShortcutProps {
  /** Combo like 'mod+k' — rendered as ⌘K on macOS and Ctrl K elsewhere. */
  keys: string
  className?: string
}

/** Platform-aware shortcut hint built from Kbd caps. */
export function Shortcut({ keys, className }: ShortcutProps) {
  const labels = hotkeyLabels(keys, isMac)
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={labels.join(' ')}>
      {labels.map((label, i) => (
        <Kbd key={`${label}-${i}`} aria-hidden="true">
          {label}
        </Kbd>
      ))}
    </span>
  )
}
