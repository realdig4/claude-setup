import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transitions } from '../../lib/motion'
import type { Tone } from './Badge'
import { Button } from './Button'
import type { IconProp } from './icon'
import { IconTile } from './IconTile'
import { Portal, useLayer } from './overlay'

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  /** Optional icon tile next to the title. */
  icon?: IconProp
  /** Color of the icon tile. */
  tone?: Tone
  children?: ReactNode
  /** Action buttons, right-aligned (put the primary action last). */
  footer?: ReactNode
  /** sm 420px · md 520px (default) · lg 680px · xl 880px */
  size?: DialogSize
  /** Allow closing with Escape, the overlay and the × button (default true). Set false while saving. */
  dismissible?: boolean
  hideClose?: boolean
  /** Element to focus first (default: [data-autofocus] or the first focusable element). */
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
  bodyClassName?: string
}

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[680px]',
  xl: 'max-w-[880px]'
}

/**
 * Modal dialog with a spring entrance, focus trap, Escape/overlay close and focus restore.
 * @example
 * <Dialog open={open} onOpenChange={setOpen} title="Add a custom tool" description="Paste the command…"
 *   footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Add</Button></>}>
 *   …form…
 * </Dialog>
 */
export function Dialog(props: DialogProps) {
  return (
    <Portal>
      <AnimatePresence>{props.open ? <DialogLayer key="dialog" {...props} /> : null}</AnimatePresence>
    </Portal>
  )
}

function DialogLayer({
  onOpenChange,
  title,
  description,
  icon,
  tone = 'accent',
  children,
  footer,
  size = 'md',
  dismissible = true,
  hideClose,
  initialFocus,
  className,
  bodyClassName
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isPresent = useIsPresent()
  const titleId = useId()
  const descriptionId = useId()
  const close = (): void => {
    if (dismissible) onOpenChange(false)
  }
  useLayer({ active: isPresent, ref, onEscape: dismissible ? close : undefined, initialFocus })
  const showClose = dismissible && !hideClose

  return (
    <div ref={ref} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-6 outline-none">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={close}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'relative flex max-h-[min(86vh,780px)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-elevated text-fg shadow-2xl',
          SIZES[size],
          className
        )}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: transitions.dialog }}
        exit={{ opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12 } }}
      >
        {title || description ? (
          <div className={cn('flex shrink-0 items-start gap-4 px-6 pt-6', children ? 'pb-4' : 'pb-6', showClose && 'pr-14')}>
            {icon ? <IconTile icon={icon} tone={tone} size="md" /> : null}
            <div className="min-w-0 flex-1">
              {title ? (
                <h2 id={titleId} className="text-[17px] leading-6 font-semibold tracking-[-0.012em] text-fg">
                  {title}
                </h2>
              ) : null}
              {description ? (
                <div id={descriptionId} className={cn('text-sm leading-6 text-fg-muted', title && 'mt-1')}>
                  {description}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {showClose ? (
          <Button variant="ghost" size="icon-sm" className="absolute top-4 right-4" aria-label="Close" data-skip-autofocus onClick={close}>
            <X />
          </Button>
        ) : null}
        {children ? (
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6', !title && !description && 'pt-6', bodyClassName)}>{children}</div>
        ) : null}
        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-6 py-4">{footer}</div>
        ) : null}
      </motion.div>
    </div>
  )
}
