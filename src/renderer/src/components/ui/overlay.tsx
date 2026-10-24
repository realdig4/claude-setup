/**
 * Overlay plumbing shared by Dialog, Sheet, Menu and the command palette:
 * a body Portal and useLayer() — Escape handling, focus trap, initial focus, focus restore and an
 * inert background (only the topmost modal layer is interactive).
 */
import { useEffect, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useLatest } from '../../lib/hooks'
import { isTopLayer, openLayers, pushLayer, removeLayer } from '../../lib/layers'

/** Render children into document.body (outside the app root, so they stay interactive over inert content). */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
].join(',')

/** Focusable, visible elements inside a container, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[inert]') && el.getClientRects().length > 0
  )
}

/** Make everything except the topmost modal layer (and layers above it) inert. */
function syncInert(): void {
  const root = document.getElementById('root')
  const layers = openLayers()
  let topModal = -1
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i]?.modal) {
      topModal = i
      break
    }
  }
  if (root) root.inert = topModal >= 0
  layers.forEach((layer, i) => {
    const el = layer.element()
    if (el) el.inert = i < topModal
  })
}

export interface UseLayerOptions {
  /** The layer is open and present (pass false while it animates out). */
  active: boolean
  /** Root element of the layer. */
  ref: RefObject<HTMLElement | null>
  /** Modal layers trap focus and make the rest of the app inert (default true). */
  modal?: boolean
  /** Called on Escape (when this is the topmost layer). Omit to ignore Escape. */
  onEscape?: () => void
  /** Element to focus on open. Default: [data-autofocus], else the first focusable, else the container. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Move focus back to the previously focused element on close (default true). */
  restoreFocus?: boolean
}

/** Register an overlay layer for its lifetime. See UseLayerOptions. */
export function useLayer({ active, ref, modal = true, onEscape, initialFocus, restoreFocus = true }: UseLayerOptions): void {
  const onEscapeRef = useLatest(onEscape)
  const initialFocusRef = useLatest(initialFocus)

  useEffect(() => {
    if (!active) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const id = pushLayer({ modal, element: () => ref.current })
    syncInert()

    const frame = requestAnimationFrame(() => {
      const container = ref.current
      if (!container || container.contains(document.activeElement)) return
      const target =
        initialFocusRef.current?.current ??
        container.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableWithin(container).find((el) => !el.hasAttribute('data-skip-autofocus')) ??
        container
      target.focus({ preventScroll: true })
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopLayer(id)) return
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault()
        event.stopPropagation()
        onEscapeRef.current()
        return
      }
      if (event.key === 'Tab' && modal) {
        const container = ref.current
        if (!container) return
        const items = focusableWithin(container)
        if (items.length === 0) {
          event.preventDefault()
          container.focus()
          return
        }
        const first = items[0]!
        const last = items[items.length - 1]!
        const current = document.activeElement
        if (event.shiftKey && (current === first || !container.contains(current))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (current === last || !container.contains(current))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      removeLayer(id)
      syncInert()
      if (restoreFocus && previouslyFocused && previouslyFocused.isConnected && !previouslyFocused.closest('[inert]')) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [active, modal, restoreFocus, ref, onEscapeRef, initialFocusRef])
}
