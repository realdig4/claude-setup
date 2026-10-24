import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useFloating, type Align } from './floating'
import { Shortcut } from './Kbd'
import { Portal, useLayer } from './overlay'

export interface MenuAction {
  type?: 'item'
  /** Stable key (defaults to the index). */
  id?: string
  label: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  onSelect: () => void
  /** 'danger' for destructive actions (shown in red). */
  tone?: 'danger'
  disabled?: boolean
  /** Shortcut hint, e.g. 'mod+c' (display only). */
  shortcut?: string
}

export type MenuItem = MenuAction | { type: 'separator' } | { type: 'label'; label: ReactNode }

export interface MenuProps {
  /** The button that opens the menu (receives ref, onClick, aria-haspopup/expanded). */
  trigger: ReactElement
  items: MenuItem[]
  align?: Align
  side?: 'bottom' | 'top'
  /** Accessible name of the menu. */
  label?: string
  /** Minimum width in px (default 200). */
  minWidth?: number
}

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value
}

/**
 * Dropdown menu of actions (keyboard: arrows, Home/End, Enter, Escape).
 * @example
 * <Menu label="Tool actions" trigger={<Button variant="ghost" size="icon" aria-label="More"><Ellipsis /></Button>}
 *   items={[{ label: 'Test connection', icon: Activity, onSelect: test }, { type: 'separator' },
 *           { label: 'Remove', icon: Trash2, tone: 'danger', onSelect: remove }]} />
 */
export function Menu({ trigger, items, align = 'end', side = 'bottom', label, minWidth = 200 }: MenuProps) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const menuId = useId()

  if (!isValidElement(trigger)) return trigger
  const triggerProps = trigger.props as TriggerProps

  const triggerEl = cloneElement(trigger as ReactElement<TriggerProps & Record<string, unknown>>, {
    ref: (el: HTMLElement | null) => {
      anchorRef.current = el
      setRef(triggerProps.ref, el)
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      triggerProps.onClick?.(e)
      if (!e.defaultPrevented) setOpen((v) => !v)
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      triggerProps.onKeyDown?.(e)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined
  })

  return (
    <>
      {triggerEl}
      <Portal>
        <AnimatePresence>
          {open ? (
            <MenuPopover
              key="menu"
              id={menuId}
              anchorRef={anchorRef}
              items={items}
              align={align}
              side={side}
              label={label}
              minWidth={minWidth}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </AnimatePresence>
      </Portal>
    </>
  )
}

interface MenuPopoverProps {
  id: string
  anchorRef: { current: HTMLElement | null }
  items: MenuItem[]
  align: Align
  side: 'bottom' | 'top'
  label?: string
  minWidth: number
  onClose: () => void
}

function MenuPopover({ id, anchorRef, items, align, side, label, minWidth, onClose }: MenuPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isPresent = useIsPresent()
  const { style, side: finalSide } = useFloating(anchorRef, ref, { open: true, side, align, offset: 6 })
  useLayer({ active: isPresent, ref, modal: false, onEscape: onClose })

  useEffect(() => {
    if (!isPresent) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const onBlurWindow = (): void => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlurWindow)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlurWindow)
    }
  }, [isPresent, onClose, anchorRef])

  const itemButtons = (): HTMLButtonElement[] =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = itemButtons()
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    else if (e.key === 'Tab') {
      e.preventDefault()
      onClose()
      return
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const lower = e.key.toLowerCase()
      const start = index + 1
      const ordered = [...buttons.slice(start), ...buttons.slice(0, start)]
      const match = ordered.find((b) => (b.textContent ?? '').trim().toLowerCase().startsWith(lower))
      if (match) next = buttons.indexOf(match)
    }
    if (next >= 0) {
      e.preventDefault()
      buttons[next]?.focus()
    }
  }

  const origin = `${finalSide === 'top' ? 'bottom' : 'top'} ${align === 'start' ? 'left' : align === 'end' ? 'right' : 'center'}`

  return (
    <div ref={ref} style={{ ...style, zIndex: 65 }} onKeyDown={onKeyDown}>
      <motion.div
        id={id}
        role="menu"
        aria-label={label}
        style={{ minWidth, transformOrigin: origin }}
        initial={{ opacity: 0, scale: 0.96, y: finalSide === 'top' ? 4 : -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        className="max-h-[min(420px,70vh)] max-w-[320px] overflow-y-auto rounded-xl border border-line bg-elevated p-1.5 text-fg shadow-xl"
      >
        {items.map((item, i) => {
          if (item.type === 'separator') return <div key={`sep-${i}`} role="separator" className="-mx-1.5 my-1.5 h-px bg-line" />
          if (item.type === 'label') {
            return (
              <div key={`label-${i}`} className="px-2.5 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
                {item.label}
              </div>
            )
          }
          const Icon = item.icon
          return (
            <button
              key={item.id ?? `item-${i}`}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                onClose()
                // Return focus to the trigger first, so a dialog opened by onSelect restores focus there.
                anchorRef.current?.focus({ preventScroll: true })
                item.onSelect()
              }}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 outline-none',
                'transition-colors duration-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45',
                item.tone === 'danger'
                  ? 'text-danger-text hover:bg-danger-soft focus:bg-danger-soft'
                  : 'text-fg hover:bg-surface-2 focus:bg-surface-2'
              )}
            >
              {Icon ? (
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', item.tone === 'danger' ? 'text-danger-text' : 'text-fg-subtle')}
                  aria-hidden="true"
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{item.label}</span>
                {item.description ? <span className="mt-0.5 block text-xs text-fg-muted">{item.description}</span> : null}
              </span>
              {item.shortcut ? <Shortcut keys={item.shortcut} className="mt-px ml-3 opacity-80" /> : null}
            </button>
          )
        })}
      </motion.div>
    </div>
  )
}
