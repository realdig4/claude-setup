import { isValidElement, type ReactElement, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** An icon prop accepts a lucide component (`Plus`) or a ready element (`<Monogram text="Kimi" />`). */
export type IconProp = LucideIcon | ReactElement

/** Render an IconProp with the given classes (classes apply to lucide components only). */
export function renderIcon(icon: IconProp | null | undefined, className?: string): ReactNode {
  if (!icon) return null
  if (isValidElement(icon)) return icon
  const Icon = icon as LucideIcon
  return <Icon className={className} aria-hidden="true" />
}
