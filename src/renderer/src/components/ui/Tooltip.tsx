import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '../../lib/cn'
import { useFloating, type Align, type Side } from './floating'
import { Portal } from './overlay'

export interface TooltipProps {
  /** Tooltip text. Falsy content disables the tooltip. */
  content: ReactNode
  /** A single element that accepts ref + pointer/focus handlers (DOM element or a ui component). */
  children: ReactElement
  side?: Side
  align?: Align
  /** Hover delay in ms (default 450). Keyboard focus shows it immediately. */
  delay?: number
  disabled?: boolean
  className?: string
}

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  'aria-describedby'?: string
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value
}

/**
 * Small hint shown on hover/focus. Not for essential information (it is invisible on touch and to some users).
 * Icon-only buttons still need an aria-label.
 * @example <Tooltip content="Restart Claude Desktop"><Button size="icon" aria-label="Restart"><RotateCw /></Button></Tooltip>
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delay = 450, disabled, className }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const floatingRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const id = useId()
  const enabled = !disabled && !!content
  const { style, side: finalSide } = useFloating(anchorRef, floatingRef, { open: open && enabled, side, align, offset: 8 })

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!isValidElement(children)) return children
  const childProps = children.props as TriggerProps

  const show = (immediate: boolean): void => {
    if (!enabled) return
    window.clearTimeout(timer.current)
    if (immediate) setOpen(true)
    else timer.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }

  const trigger = cloneElement(children as ReactElement<TriggerProps>, {
    ref: (el: HTMLElement | null) => {
      anchorRef.current = el
      setRef(childProps.ref, el)
    },
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(e)
      if (e.pointerType !== 'touch') show(false)
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(e)
      hide()
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(e)
      hide()
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e)
      if (e.currentTarget.matches(':focus-visible')) show(true)
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e)
      hide()
    },
    'aria-describedby': open && enabled ? [childProps['aria-describedby'], id].filter(Boolean).join(' ') : childProps['aria-describedby']
  })

  const offset = { top: { y: 4 }, bottom: { y: -4 }, left: { x: 4 }, right: { x: -4 } }[finalSide]

  return (
    <>
      {trigger}
      <Portal>
        <AnimatePresence>
          {open && enabled ? (
            <div key="tooltip" ref={floatingRef} style={{ ...style, zIndex: 70 }} className="pointer-events-none">
              <motion.div
                id={id}
                role="tooltip"
                initial={{ opacity: 0, scale: 0.97, ...offset }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'max-w-[280px] rounded-lg bg-inverse px-2.5 py-1.5 text-[12.5px] leading-[1.45] font-medium text-fg-inverse shadow-lg',
                  className
                )}
              >
                {content}
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>
      </Portal>
    </>
  )
}
