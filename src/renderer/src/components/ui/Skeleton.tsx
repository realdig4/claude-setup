import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

/**
 * Placeholder block with a gentle shimmer while content loads. Size it with classes.
 * @example <Skeleton className="h-4 w-40" />
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-md bg-surface-3 skeleton-shimmer', className)} {...props} />
}

export interface SkeletonTextProps {
  lines?: number
  className?: string
}

/** Several text-line skeletons (the last line is shorter). */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </div>
  )
}

/** A card-shaped skeleton (icon + two lines), handy for grids while loading. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface p-5 shadow-xs', className)} aria-hidden="true">
      <div className="flex items-start gap-3.5">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex-1 space-y-2 pt-0.5">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>
      <SkeletonText lines={2} className="mt-5" />
    </div>
  )
}
