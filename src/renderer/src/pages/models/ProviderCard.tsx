import { useId } from 'react'
import { ArrowRight } from 'lucide-react'
import type { ProviderPreset } from '@shared/types'
import { Badge, Card, Monogram } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatTokens } from '@renderer/lib/format'
import { TAG_META, sortedTags } from './logic'

export interface ProviderCardProps {
  preset: ProviderPreset
  onSelect: (preset: ProviderPreset) => void
  /** Claude Code uses this provider right now. */
  active?: boolean
  advanced: boolean
  /** Bigger, friendlier card (Simple mode featured picks). */
  featured?: boolean
}

/** A provider in the gallery: brand monogram, name, vendor, tags and a short description. Click to set it up. */
export function ProviderCard({ preset, onSelect, active, advanced, featured }: ProviderCardProps) {
  const descriptionId = useId()
  const allTags = sortedTags(preset)
  const tags = allTags.slice(0, 3)
  const hidden = allTags.slice(3)
  const largest = preset.models.reduce((max, m) => Math.max(max, m.context ?? 0), 0)

  return (
    <Card
      interactive
      onClick={() => onSelect(preset)}
      aria-label={`Set up ${preset.name}`}
      aria-describedby={descriptionId}
      className={cn('group flex h-full flex-col', featured ? 'p-5' : 'p-4')}
    >
      <div className="flex items-start gap-3.5">
        <Monogram text={preset.name} letters={preset.monogram} color={preset.color} size={featured ? 'lg' : 'md'} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">{preset.name}</div>
          <div className="truncate text-[13px] leading-5 text-fg-muted">{preset.vendor}</div>
        </div>
        {active ? (
          <Badge tone="success" size="sm" dot>
            In use
          </Badge>
        ) : (
          <ArrowRight
            className={cn(
              'mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition-[opacity,transform] duration-200',
              'group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100'
            )}
            aria-hidden="true"
          />
        )}
      </div>
      <p id={descriptionId} className={cn('mt-3 text-[13px] leading-5 text-fg-muted', featured ? 'line-clamp-3' : 'line-clamp-2')}>
        {preset.description}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        {tags.map((tag) => (
          <Badge key={tag} size="sm" tone={TAG_META[tag].tone}>
            {advanced ? TAG_META[tag].label : TAG_META[tag].simple}
          </Badge>
        ))}
        {hidden.length ? (
          <Badge size="sm" variant="outline" title={hidden.map((t) => (advanced ? TAG_META[t].label : TAG_META[t].simple)).join(', ')}>
            +{hidden.length}
          </Badge>
        ) : null}
        {advanced && preset.models.length ? (
          <span className="ml-auto text-2xs text-fg-subtle tabular-nums">
            {preset.models.length} {preset.models.length === 1 ? 'model' : 'models'}
            {largest ? ` · up to ${formatTokens(largest)}` : ''}
          </span>
        ) : null}
      </div>
    </Card>
  )
}
