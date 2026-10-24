/**
 * Discover filters: category chips (the most common first, the rest behind "More"), plus the
 * "no key needed" / "nothing to install" toggles and the Advanced registry picker.
 */
import { useState } from 'react'
import { ChevronDown, ChevronUp, Cloud, LayoutGrid, LockOpen } from 'lucide-react'
import type { CatalogSource, CategoryInfo } from '@shared/types'
import { Chip, Select, Skeleton } from '@renderer/components/ui'
import { categoryIcon } from './categoryIcons'
import { SOURCE_LABELS, SOURCE_ORDER } from './lib/catalog'

/** Categories shown before "More". */
const VISIBLE_CATEGORIES = 9

export interface CategoryChipsProps {
  categories: CategoryInfo[] | undefined
  category?: string
  onCategory: (id: string | undefined) => void
  advanced: boolean
}

/** Category filter chips. */
export function CategoryChips({ categories, category, onCategory, advanced }: CategoryChipsProps) {
  const [expanded, setExpanded] = useState(false)
  if (!categories) {
    return (
      <div className="flex flex-wrap gap-2" aria-hidden="true">
        {[64, 120, 104, 116, 132, 96, 126, 108].map((w, i) => (
          <Skeleton key={i} className="h-8 rounded-full" style={{ width: w }} />
        ))}
      </div>
    )
  }
  const list = categories.filter((c) => c.count > 0 || c.id === category)
  const hiddenCount = Math.max(0, list.length - VISIBLE_CATEGORIES)
  const visible = expanded || hiddenCount <= 1 ? list : list.slice(0, VISIBLE_CATEGORIES)
  const selectedHidden = !!category && !visible.some((c) => c.id === category)
  const shown = selectedHidden ? [...visible, ...list.filter((c) => c.id === category)] : visible

  return (
    <div role="group" aria-label="Categories" className="flex flex-wrap gap-2">
      <Chip selected={!category} icon={LayoutGrid} onClick={() => onCategory(undefined)}>
        All
      </Chip>
      {shown.map((c) => (
        <Chip
          key={c.id}
          selected={category === c.id}
          icon={categoryIcon(c.id)}
          count={advanced ? c.count : undefined}
          onClick={() => onCategory(category === c.id ? undefined : c.id)}
        >
          {c.label}
        </Chip>
      ))}
      {hiddenCount > 1 ? (
        <Chip icon={expanded ? ChevronUp : ChevronDown} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="border-dashed">
          {expanded ? 'Fewer' : `${hiddenCount} more`}
        </Chip>
      ) : null}
    </div>
  )
}

export interface FilterTogglesProps {
  noKey: boolean
  onNoKey: (value: boolean) => void
  remote: boolean
  onRemote: (value: boolean) => void
  source?: CatalogSource
  onSource: (source: CatalogSource | undefined) => void
  advanced: boolean
}

/** "Only show…" toggles and the registry picker. */
export function FilterToggles(props: FilterTogglesProps) {
  return (
    <div role="group" aria-label="Only show" className="flex flex-wrap items-center gap-2">
      <Chip size="sm" selected={props.noKey} icon={LockOpen} onClick={() => props.onNoKey(!props.noKey)}>
        No key needed
      </Chip>
      <Chip size="sm" selected={props.remote} icon={Cloud} onClick={() => props.onRemote(!props.remote)}>
        Nothing to install
      </Chip>
      {props.advanced ? (
        <Select
          size="sm"
          aria-label="Registry"
          value={props.source ?? ''}
          containerClassName="w-auto"
          className="h-7 rounded-full pr-8 text-xs"
          onValueChange={(value) => props.onSource(value ? (value as CatalogSource) : undefined)}
          options={[{ value: '', label: 'All registries' }, ...SOURCE_ORDER.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))]}
        />
      ) : null}
    </div>
  )
}
