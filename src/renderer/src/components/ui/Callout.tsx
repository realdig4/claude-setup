import type { ReactNode } from 'react'
import { CircleCheck, Info, OctagonAlert, Sparkles, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { renderIcon, type IconProp } from './icon'

export type CalloutTone = 'info' | 'success' | 'warn' | 'danger' | 'neutral' | 'accent'

const TONES: Record<CalloutTone, { box: string; icon: string; Icon: IconProp }> = {
  info: { box: 'border-info-line/70 bg-info-soft/70', icon: 'text-info-text', Icon: Info },
  success: { box: 'border-success-line/70 bg-success-soft/70', icon: 'text-success-text', Icon: CircleCheck },
  warn: { box: 'border-warn-line/80 bg-warn-soft/80', icon: 'text-warn-text', Icon: TriangleAlert },
  danger: { box: 'border-danger-line/70 bg-danger-soft/70', icon: 'text-danger-text', Icon: OctagonAlert },
  neutral: { box: 'border-line bg-surface-2/70', icon: 'text-fg-muted', Icon: Info },
  accent: { box: 'border-accent-line/60 bg-accent-soft/60', icon: 'text-accent-text', Icon: Sparkles }
}

export interface CalloutProps {
  tone?: CalloutTone
  title?: ReactNode
  children?: ReactNode
  /** Button(s) on the right (or below on narrow layouts). */
  action?: ReactNode
  /** Override the tone's default icon (null hides it). */
  icon?: IconProp | null
  /** Shows a × button. */
  onDismiss?: () => void
  /** Use role="alert" for urgent messages that appear dynamically. */
  role?: 'alert' | 'status'
  className?: string
}

/**
 * Inline message box for tips, warnings and errors.
 * @example
 * <Callout tone="warn" title="Restart needed" action={<Button size="sm">Restart now</Button>}>
 *   Claude Desktop loads new tools when it starts.
 * </Callout>
 */
export function Callout({ tone = 'info', title, children, action, icon, onDismiss, role, className }: CalloutProps) {
  const t = TONES[tone]
  const iconToShow = icon === null ? null : (icon ?? t.Icon)
  return (
    <div role={role} className={cn('flex items-start gap-3 rounded-xl border px-4 py-3.5', t.box, className)}>
      {iconToShow ? <span className={cn('mt-px flex shrink-0 [&>svg]:size-[18px]', t.icon)}>{renderIcon(iconToShow)}</span> : null}
      <div className="min-w-0 flex-1 text-[13.5px] leading-[1.55]">
        {title ? <div className="font-semibold text-fg">{title}</div> : null}
        {children ? <div className={cn('text-fg-muted', title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            '-mt-0.5 -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors',
            'hover:bg-surface-3/60 hover:text-fg'
          )}
          aria-label="Dismiss"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
