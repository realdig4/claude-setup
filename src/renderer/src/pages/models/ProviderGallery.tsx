import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, SearchX } from 'lucide-react'
import type { ProviderPreset } from '@shared/types'
import { Button, CardGrid, Chip, EmptyState, SearchInput, SkeletonCard, Stagger, StaggerItem } from '@renderer/components/ui'
import { ProviderCard } from './ProviderCard'
import { TAG_META, TAG_ORDER, featuredProviders, groupProviders, matchesProvider, type ProviderTag } from './logic'

export interface ProviderGalleryProps {
  providers: ProviderPreset[] | undefined
  loading: boolean
  onSelect: (preset: ProviderPreset) => void
  activeProviderId?: string
  advanced: boolean
}

function Grid({ items, onSelect, activeProviderId, activeFamilyId, advanced, featured }: {
  items: ProviderPreset[]
  onSelect: (preset: ProviderPreset) => void
  activeProviderId?: string
  /** Family of the provider in use (featured cards stand for their whole family). */
  activeFamilyId?: string
  advanced: boolean
  featured?: boolean
}) {
  return (
    <Stagger>
      <CardGrid minItemWidth={featured ? 250 : 240} gap={featured ? 4 : 3}>
        {items.map((preset, i) => (
          <StaggerItem key={preset.id} index={i} className="h-full">
            <ProviderCard
              preset={preset}
              onSelect={onSelect}
              active={preset.id === activeProviderId || (featured && !!activeFamilyId && preset.family?.id === activeFamilyId)}
              advanced={advanced}
              featured={featured}
              asFamily={featured}
            />
          </StaggerItem>
        ))}
      </CardGrid>
    </Stagger>
  )
}

/** Provider gallery: friendly featured picks (Simple) or every provider with search and tag filters (Advanced). */
export function ProviderGallery({ providers, loading, onSelect, activeProviderId, advanced }: ProviderGalleryProps) {
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<ProviderTag | null>(null)

  const list = providers ?? []
  const featured = useMemo(() => featuredProviders(list), [list])
  const tags = useMemo(() => TAG_ORDER.filter((t) => list.some((p) => p.tags.includes(t))), [list])
  const filtering = advanced && (query.trim() !== '' || tag !== null)
  const matches = useMemo(
    () => list.filter((p) => matchesProvider(p, query) && (!tag || p.tags.includes(tag))),
    [list, query, tag]
  )
  const groups = useMemo(() => groupProviders(list, { includeClaude: advanced }), [list, advanced])

  if (loading && !providers) {
    return (
      <CardGrid minItemWidth={250}>
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </CardGrid>
    )
  }

  const grouped = (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`group-${group.id}`} className="flex flex-col gap-3">
          <div>
            <h3 id={`group-${group.id}`} className="text-sm font-semibold text-fg">
              {group.title}
            </h3>
            <p className="text-[13px] text-fg-muted">{group.description}</p>
          </div>
          <Grid items={group.providers} onSelect={onSelect} activeProviderId={activeProviderId} advanced={advanced} />
        </section>
      ))}
    </div>
  )

  if (!advanced) {
    return (
      <div className="flex flex-col gap-6">
        <Grid
          items={featured}
          onSelect={onSelect}
          activeProviderId={activeProviderId}
          activeFamilyId={list.find((p) => p.id === activeProviderId)?.family?.id}
          advanced={false}
          featured
        />
        {list.length > featured.length ? (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              rightIcon={showAll ? ChevronUp : ChevronDown}
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
            >
              {showAll ? 'Show fewer providers' : 'Show all providers'}
            </Button>
          </div>
        ) : null}
        {showAll ? grouped : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search providers and models…"
          shortcut="/"
          className="max-w-md"
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by tag">
          <Chip size="sm" selected={tag === null} onClick={() => setTag(null)} count={list.length}>
            All
          </Chip>
          {tags.map((t) => (
            <Chip
              key={t}
              size="sm"
              selected={tag === t}
              onClick={() => setTag(tag === t ? null : t)}
              count={list.filter((p) => p.tags.includes(t)).length}
            >
              {TAG_META[t].label}
            </Chip>
          ))}
        </div>
      </div>
      {filtering ? (
        matches.length ? (
          <Grid items={matches} onSelect={onSelect} activeProviderId={activeProviderId} advanced />
        ) : (
          <EmptyState
            framed
            size="sm"
            icon={SearchX}
            title="No providers match"
            description="Try another word, or clear the filters."
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setQuery('')
                  setTag(null)
                }}
              >
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        grouped
      )}
    </div>
  )
}
