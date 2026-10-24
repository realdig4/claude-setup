import type { ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Tone } from './Badge'
import { Button } from './Button'
import type { IconProp } from './icon'
import { IconTile } from './IconTile'

export interface EmptyStateProps {
  icon?: IconProp
  title: ReactNode
  description?: ReactNode
  /** Buttons (primary first). */
  actions?: ReactNode
  tone?: Tone
  /** 'sm' for inside cards/lists, 'md' (default) for page sections, 'lg' for whole pages. */
  size?: 'sm' | 'md' | 'lg'
  /** Draw a dashed frame (use when the empty state replaces a list). */
  framed?: boolean
  className?: string
  children?: ReactNode
}

/**
 * Friendly placeholder for "nothing here yet", "no results" or "coming soon".
 * @example
 * <EmptyState icon={Blocks} title="No tools yet" description="Add your first tool from Discover."
 *   actions={<Button variant="primary">Browse tools</Button>} />
 */
export function EmptyState({ icon, title, description, actions, tone = 'accent', size = 'md', framed, className, children }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center text-center',
        size === 'sm' && 'gap-2 px-4 py-8',
        size === 'md' && 'gap-3 px-6 py-14',
        size === 'lg' && 'gap-4 px-8 py-20',
        framed && 'rounded-2xl border border-dashed border-line-strong/70 bg-surface/40',
        className
      )}
    >
      {icon ? (
        <div className="relative isolate mb-1">
          <div
            aria-hidden="true"
            className={cn(
              'absolute inset-0 -z-10 scale-[2.2] rounded-full',
              'bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent)_14%,transparent),transparent)]'
            )}
          />
          <IconTile icon={icon} tone={tone} size={size === 'sm' ? 'md' : size === 'lg' ? 'xl' : 'lg'} />
        </div>
      ) : null}
      <div className={cn('max-w-md', size === 'sm' ? 'space-y-1' : 'space-y-1.5')}>
        <h3 className={cn('font-semibold tracking-[-0.01em] text-fg', size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-sm' : 'text-base')}>
          {title}
        </h3>
        {description ? (
          <p className={cn('text-fg-muted', size === 'sm' ? 'text-[13px] leading-5' : 'text-sm leading-6')}>{description}</p>
        ) : null}
      </div>
      {children}
      {actions ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  /** Short headline (default "Something went wrong"). */
  title?: ReactNode
  /** The friendly error message (e.g. useAsync().error). */
  error: ReactNode
  /** Shows a "Try again" button. */
  onRetry?: () => void
  retryLabel?: string
  size?: 'sm' | 'md' | 'lg'
  framed?: boolean
  className?: string
}

/**
 * Failed-to-load state with a retry button. Pair with useAsync:
 * @example if (error && !data) return <ErrorState error={error} onRetry={reload} />
 */
export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
  retryLabel = 'Try again',
  size = 'md',
  framed,
  className
}: ErrorStateProps) {
  return (
    <EmptyState
      icon={TriangleAlert}
      tone="danger"
      size={size}
      framed={framed}
      className={className}
      title={title}
      description={error}
      actions={
        onRetry ? (
          <Button variant="outline" size={size === 'sm' ? 'sm' : 'md'} leftIcon={RotateCcw} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    />
  )
}
