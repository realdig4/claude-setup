/**
 * Shared motion presets (motion/react). Keep animations short, calm and consistent.
 * Reduced motion is handled globally by <MotionConfig reducedMotion="user"> in App.
 */
import type { Transition, Variants } from 'motion/react'

/** Smooth deceleration curve used across the app. */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]

export const transitions = {
  /** Page enter/exit. */
  page: { duration: 0.22, ease: EASE_OUT } satisfies Transition,
  /** Small UI changes (hover reveals, fades). */
  fast: { duration: 0.14, ease: EASE_OUT } satisfies Transition,
  /** Dialogs and popovers. */
  dialog: { type: 'spring', stiffness: 460, damping: 34, mass: 0.8 } satisfies Transition,
  /** Side sheets. */
  sheet: { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 } satisfies Transition,
  /** Sliding indicators (active nav item, tab underline, segmented thumb). */
  indicator: { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } satisfies Transition
}

/** Fade + slight rise, for list items (pass the item index as `custom`). */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE_OUT, delay: Math.min(index, 14) * 0.03 }
  })
}

/** Page transition variants used by the router. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: transitions.page },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE_OUT } }
}
