import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { EASE_OUT, listItem } from '../../lib/motion'

export interface FadeInProps {
  children: ReactNode
  /** Seconds before the animation starts. */
  delay?: number
  /** Initial vertical offset in px (default 6). */
  y?: number
  className?: string
}

/** Fade + rise on mount. @example <FadeIn delay={0.1}><Card>…</Card></FadeIn> */
export function FadeIn({ children, delay = 0, y = 6, className }: FadeInProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT, delay }}
    >
      {children}
    </motion.div>
  )
}

export interface StaggerProps {
  children: ReactNode
  className?: string
}

/**
 * Container that reveals its StaggerItems one after another (capped, so long lists stay fast).
 * @example
 * <Stagger className="grid grid-cols-3 gap-4">
 *   {items.map((item, i) => <StaggerItem key={item.id} index={i}><Card>…</Card></StaggerItem>)}
 * </Stagger>
 */
export function Stagger({ children, className }: StaggerProps) {
  return (
    <motion.div className={className} initial="hidden" animate="show">
      {children}
    </motion.div>
  )
}

export interface StaggerItemProps {
  children: ReactNode
  /** Position in the list (drives the delay; capped after ~14 items). */
  index: number
  className?: string
}

/** One item inside <Stagger>. */
export function StaggerItem({ children, index, className }: StaggerItemProps) {
  return (
    <motion.div className={className} variants={listItem} custom={index}>
      {children}
    </motion.div>
  )
}
