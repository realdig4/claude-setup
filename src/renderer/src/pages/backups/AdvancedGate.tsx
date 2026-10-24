import type { ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button, EmptyState, type IconProp } from '@renderer/components/ui'
import { useAppStore, useIsAdvanced } from '@renderer/lib/store'

export interface AdvancedGateProps {
  icon: IconProp
  /** What the page is, in plain words. */
  title: string
  description: string
  children: ReactNode
}

/**
 * Renders an Advanced-only page, or (in Simple mode) a friendly explanation with a button to switch modes — for
 * deep links and the command palette that reach the page while Simple mode is on.
 */
export function AdvancedGate({ icon, title, description, children }: AdvancedGateProps) {
  const advanced = useIsAdvanced()
  const setMode = useAppStore((s) => s.setMode)
  if (advanced) return <>{children}</>
  return (
    <EmptyState
      framed
      size="lg"
      icon={icon}
      title={title}
      description={description}
      actions={
        <Button variant="primary" leftIcon={SlidersHorizontal} onClick={() => setMode('advanced')}>
          Turn on Advanced mode
        </Button>
      }
    />
  )
}
