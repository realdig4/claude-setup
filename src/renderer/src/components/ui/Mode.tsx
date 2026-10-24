import type { ReactNode } from 'react'
import { useMode } from '../../lib/store'

export interface ModeGateProps {
  children: ReactNode
  /** Rendered in the other mode instead (optional). */
  fallback?: ReactNode
}

/**
 * Render children only in Advanced mode (raw JSON, scopes, env vars, paths…).
 * @example <AdvancedOnly><CodeBlock code={server.config} /></AdvancedOnly>
 */
export function AdvancedOnly({ children, fallback = null }: ModeGateProps) {
  return <>{useMode() === 'advanced' ? children : fallback}</>
}

/**
 * Render children only in Simple mode (friendly explanations, wizards).
 * @example <SimpleOnly><Callout tone="accent">Pick the apps you use — we handle the rest.</Callout></SimpleOnly>
 */
export function SimpleOnly({ children, fallback = null }: ModeGateProps) {
  return <>{useMode() === 'simple' ? children : fallback}</>
}
