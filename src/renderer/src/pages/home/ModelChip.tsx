/** Which AI model Claude Code uses right now — a small chip that leads to the Models page. */
import { BrainCircuit, ChevronRight } from 'lucide-react'
import type { ModelStatus } from '@shared/types'
import { Skeleton, StatusDot } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'

export interface ModelChipProps {
  status: ModelStatus | undefined
  loading: boolean
  onClick: () => void
  className?: string
}

/** Plain-words description of the current model setup. */
export function modelSummary(status: ModelStatus): string {
  if (status.mode === 'anthropic') return 'Claude (default)'
  const provider = status.providerName ?? (status.mode === 'cloud' ? 'Claude via your cloud' : 'Another provider')
  return status.model ? `${provider} · ${status.model}` : provider
}

/** Chip showing the model status (hidden when it couldn't be loaded). */
export function ModelChip({ status, loading, onClick, className }: ModelChipProps) {
  if (!status) return loading ? <Skeleton className={cn('h-8 w-52 rounded-full', className)} /> : null
  const problems = status.problems.length
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-line bg-surface-2/60 pr-2 pl-3 text-[13px] text-fg-muted',
        'transition-colors duration-150 hover:border-line-strong hover:bg-surface-2 hover:text-fg',
        className
      )}
    >
      <BrainCircuit className="size-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      <span className="shrink-0">AI model:</span>
      <span className="min-w-0 truncate font-medium text-fg">{modelSummary(status)}</span>
      {problems ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-warn-text">
          <StatusDot status="warn" size="sm" label={null} pulse={false} />
          needs attention
        </span>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  )
}
