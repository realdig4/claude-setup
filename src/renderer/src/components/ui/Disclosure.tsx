import { useId, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { EASE_OUT } from '../../lib/motion'

export interface DisclosureProps {
  title: ReactNode
  /** Quiet text next to/under the title (e.g. "Environment, arguments, scope"). */
  description?: ReactNode
  defaultOpen?: boolean
  /** Controlled open state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 'plain' (default, inline) or 'card' (bordered box). */
  variant?: 'plain' | 'card'
  children: ReactNode
  className?: string
}

/**
 * Collapsible section — ideal for "Advanced options" in Simple-mode flows.
 * @example <Disclosure title="Advanced options" description="Arguments and environment">…</Disclosure>
 */
export function Disclosure({ title, description, defaultOpen = false, open, onOpenChange, variant = 'plain', children, className }: DisclosureProps) {
  const [internal, setInternal] = useState(defaultOpen)
  const isOpen = open ?? internal
  const contentId = useId()
  const toggle = (): void => {
    const next = !isOpen
    if (open === undefined) setInternal(next)
    onOpenChange?.(next)
  }
  const card = variant === 'card'
  return (
    <div className={cn(card && 'rounded-xl border border-line bg-surface', className)}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={toggle}
        className={cn(
          'group flex w-full items-center gap-2 text-left',
          card ? 'rounded-xl px-4 py-3 hover:bg-surface-2/50' : 'rounded-md py-1.5'
        )}
      >
        <ChevronRight
          className={cn('size-4 shrink-0 text-fg-subtle transition-transform duration-200 ease-smooth', isOpen && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="text-[13.5px] font-medium text-fg group-hover:text-fg">{title}</span>
          {description ? <span className="ml-2 text-[13px] text-fg-subtle">{description}</span> : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            key="content"
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className={cn(card ? 'border-t border-line px-4 py-4' : 'pt-3 pb-1 pl-6')}>{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
