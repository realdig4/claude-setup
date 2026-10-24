import { cn } from '../../lib/cn'

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZES: Record<SpinnerSize, string> = {
  xs: 'size-3',
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-8'
}

export interface SpinnerProps {
  size?: SpinnerSize
  className?: string
  /** Screen-reader text. Pass null when a parent already announces the busy state. */
  label?: string | null
}

/** Circular loading indicator. Inherits the current text color. */
export function Spinner({ size = 'sm', className, label = 'Loading' }: SpinnerProps) {
  return (
    <span role={label ? 'status' : undefined} className={cn('inline-flex shrink-0', className)}>
      <svg viewBox="0 0 24 24" fill="none" className={cn('animate-spin', SIZES[size])} aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export interface LoadingStateProps {
  /** Visible text under the spinner (default "Loading…"). */
  label?: string
  /** 'sm' for cards, 'md' for page sections (default). */
  size?: 'sm' | 'md'
  className?: string
}

/** Centered spinner with a short label — for areas where a skeleton doesn't fit. */
export function LoadingState({ label = 'Loading…', size = 'md', className }: LoadingStateProps) {
  return (
    <div role="status" className={cn('flex flex-col items-center justify-center gap-3 text-fg-muted', size === 'sm' ? 'py-8' : 'py-16', className)}>
      <Spinner size={size === 'sm' ? 'sm' : 'md'} label={null} className="text-accent" />
      <span className={cn(size === 'sm' ? 'text-[13px]' : 'text-sm')}>{label}</span>
    </div>
  )
}
