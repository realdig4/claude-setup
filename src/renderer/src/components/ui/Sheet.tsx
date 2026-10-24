import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transitions } from '../../lib/motion'
import { Button } from './Button'
import { Portal, useLayer } from './overlay'

export type SheetSize = 'sm' | 'md' | 'lg' | 'xl'

export interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  /** Element shown left of the title (e.g. a ServerIcon). */
  media?: ReactNode
  /** Extra header content under the title (badges, tabs). */
  headerExtra?: ReactNode
  children?: ReactNode
  /** Sticky action bar at the bottom. */
  footer?: ReactNode
  /** sm 400px · md 480px (default) · lg 640px · xl 800px */
  size?: SheetSize
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
  bodyClassName?: string
}

const SIZES: Record<SheetSize, string> = {
  sm: 'max-w-[400px]',
  md: 'max-w-[480px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[800px]'
}

/**
 * Right-side drawer for details (server info, config preview, logs). Sits below the title bar so the
 * window controls stay reachable.
 * @example <Sheet open={!!server} onOpenChange={(o) => !o && setServer(null)} title={server?.name} media={<ServerIcon … />}>…</Sheet>
 */
export function Sheet(props: SheetProps) {
  return (
    <Portal>
      <AnimatePresence>{props.open ? <SheetLayer key="sheet" {...props} /> : null}</AnimatePresence>
    </Portal>
  )
}

function SheetLayer({
  onOpenChange,
  title,
  description,
  media,
  headerExtra,
  children,
  footer,
  size = 'md',
  dismissible = true,
  initialFocus,
  className,
  bodyClassName
}: SheetProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isPresent = useIsPresent()
  const titleId = useId()
  const descriptionId = useId()
  const close = (): void => {
    if (dismissible) onOpenChange(false)
  }
  useLayer({ active: isPresent, ref, onEscape: dismissible ? close : undefined, initialFocus })

  return (
    <div ref={ref} tabIndex={-1} className="fixed inset-0 z-50 outline-none">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={close}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'absolute top-[var(--titlebar-height)] right-0 bottom-0 flex w-full flex-col overflow-hidden',
          'rounded-tl-2xl border-t border-l border-line bg-elevated text-fg shadow-2xl',
          SIZES[size],
          className
        )}
        initial={{ x: '100%' }}
        animate={{ x: 0, transition: transitions.sheet }}
        exit={{ x: '100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
      >
        <div className="flex shrink-0 items-start gap-3.5 border-b border-line px-6 pt-5 pb-4">
          {media ? <div className="shrink-0">{media}</div> : null}
          <div className="min-w-0 flex-1 pt-0.5">
            {title ? (
              <h2 id={titleId} className="truncate text-[17px] leading-6 font-semibold tracking-[-0.012em]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <div id={descriptionId} className="mt-0.5 text-[13px] leading-5 text-fg-muted">
                {description}
              </div>
            ) : null}
            {headerExtra ? <div className="mt-3">{headerExtra}</div> : null}
          </div>
          {dismissible ? (
            <Button variant="ghost" size="icon-sm" className="-mt-0.5 -mr-2" aria-label="Close" data-skip-autofocus onClick={close}>
              <X />
            </Button>
          ) : null}
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', bodyClassName)}>{children}</div>
        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-6 py-3.5">{footer}</div>
        ) : null}
      </motion.div>
    </div>
  )
}
