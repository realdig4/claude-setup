import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../lib/store'
import { Button } from './Button'
import type { IconProp } from './icon'
import { IconTile } from './IconTile'

export interface PageHeaderProps {
  title: ReactNode
  /** One friendly sentence about what this page is for. */
  subtitle?: ReactNode
  /** Page icon (shown in an accent tile). */
  icon?: IconProp
  /** Buttons on the right (primary action last). */
  actions?: ReactNode
  /** Small label above the title (e.g. a step or category). */
  eyebrow?: ReactNode
  /** Show a Back button (uses navigation history, or a custom handler/label). */
  back?: boolean | { label?: string; onClick?: () => void }
  /** Content under the header row (tabs, filters). */
  children?: ReactNode
  className?: string
}

/**
 * Top of every page: icon, title, subtitle and actions.
 * @example <PageHeader icon={Compass} title="Discover" subtitle="Find tools that give Claude new abilities." actions={<Button>Refresh</Button>} />
 */
export function PageHeader({ title, subtitle, icon, actions, eyebrow, back, children, className }: PageHeaderProps) {
  const goBack = useAppStore((s) => s.back)
  const backConfig = typeof back === 'object' ? back : {}
  return (
    <header className={cn('mb-8', className)}>
      {back ? (
        <Button variant="ghost" size="sm" leftIcon={ArrowLeft} className="mb-4 -ml-2.5 text-fg-muted" onClick={backConfig.onClick ?? goBack}>
          {backConfig.label ?? 'Back'}
        </Button>
      ) : null}
      <div className="flex items-start gap-4">
        {icon ? <IconTile icon={icon} tone="accent" size="lg" className="mt-0.5" /> : null}
        <div className="min-w-0 flex-1">
          {eyebrow ? <div className="mb-1 text-xs font-semibold tracking-wide text-accent-text">{eyebrow}</div> : null}
          <h1 className="text-[26px] leading-[34px] font-semibold tracking-[-0.022em] text-fg">{title}</h1>
          {subtitle ? <p className="mt-1 max-w-2xl text-[15px] leading-6 text-fg-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1.5">{actions}</div> : null}
      </div>
      {children ? <div className="mt-6">{children}</div> : null}
    </header>
  )
}
