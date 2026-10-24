/**
 * Minimal anchored positioning for tooltips and menus (fixed positioning, flip + clamp to viewport).
 */
import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface PositionResult {
  top: number
  left: number
  side: Side
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** Compute where a floating box of `size` should go next to `anchor` (all in viewport coordinates). */
export function computePosition(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: Side,
  align: Align,
  offset = 8,
  padding = 8
): PositionResult {
  const fits = (s: Side): boolean => {
    if (s === 'top') return anchor.top - offset - size.height >= padding
    if (s === 'bottom') return anchor.top + anchor.height + offset + size.height <= viewport.height - padding
    if (s === 'left') return anchor.left - offset - size.width >= padding
    return anchor.left + anchor.width + offset + size.width <= viewport.width - padding
  }
  const finalSide = fits(side) || !fits(OPPOSITE[side]) ? side : OPPOSITE[side]

  let top = 0
  let left = 0
  if (finalSide === 'top' || finalSide === 'bottom') {
    top = finalSide === 'top' ? anchor.top - offset - size.height : anchor.top + anchor.height + offset
    if (align === 'start') left = anchor.left
    else if (align === 'end') left = anchor.left + anchor.width - size.width
    else left = anchor.left + anchor.width / 2 - size.width / 2
  } else {
    left = finalSide === 'left' ? anchor.left - offset - size.width : anchor.left + anchor.width + offset
    if (align === 'start') top = anchor.top
    else if (align === 'end') top = anchor.top + anchor.height - size.height
    else top = anchor.top + anchor.height / 2 - size.height / 2
  }

  left = Math.min(Math.max(left, padding), Math.max(padding, viewport.width - size.width - padding))
  top = Math.min(Math.max(top, padding), Math.max(padding, viewport.height - size.height - padding))
  return { top: Math.round(top), left: Math.round(left), side: finalSide }
}

export interface FloatingOptions {
  open: boolean
  side?: Side
  align?: Align
  offset?: number
}

/**
 * Keep a floating element positioned next to an anchor while open (follows scroll and resize).
 * Returns inline styles for the floating element and the side it ended up on.
 */
export function useFloating(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  { open, side = 'bottom', align = 'center', offset = 8 }: FloatingOptions
): { style: CSSProperties; side: Side } {
  const [position, setPosition] = useState<PositionResult | null>(null)

  const update = useCallback(() => {
    const anchor = anchorRef.current
    const floating = floatingRef.current
    if (!anchor || !floating) return
    const a = anchor.getBoundingClientRect()
    const result = computePosition(
      { top: a.top, left: a.left, width: a.width, height: a.height },
      { width: floating.offsetWidth, height: floating.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      side,
      align,
      offset
    )
    setPosition((prev) => (prev && prev.top === result.top && prev.left === result.left && prev.side === result.side ? prev : result))
  }, [anchorRef, floatingRef, side, align, offset])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    update()
    const frame = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (observer && floatingRef.current) observer.observe(floatingRef.current)
    if (observer && anchorRef.current) observer.observe(anchorRef.current)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [open, update, anchorRef, floatingRef])

  const style: CSSProperties = position
    ? { position: 'fixed', top: position.top, left: position.left }
    : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
  return { style, side: position?.side ?? side }
}
