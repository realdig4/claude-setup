/**
 * Catalog server card (Discover grid and Home "Popular tools"). The whole card opens the details;
 * the Add button opens the install wizard. Both are separate keyboard stops (no nested buttons).
 */
import { BadgeCheck, Check, Plus, Star } from 'lucide-react'
import type { CatalogServer, InstalledServer } from '@shared/types'
import { Badge, Button, Card, ServerIcon, Skeleton, Tooltip } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatCompact, formatRelativeTime, joinList } from '@renderer/lib/format'
import { isInstallable } from './lib/catalog'
import { TARGET_NAMES } from './lib/targets'
import { ServerBadges } from './ServerBadges'

export interface ServerCardProps {
  server: CatalogServer
  /** Where it is already installed (empty when not installed). */
  installed?: readonly InstalledServer[]
  onOpen: () => void
  onAdd: () => void
  advanced: boolean
  /** Smaller card for rows on Home. */
  compact?: boolean
  className?: string
}

/** Names of the apps a tool is installed in ("Claude Desktop and Claude Code"). */
export function installedWhere(installed: readonly InstalledServer[]): string {
  return joinList([...new Set(installed.map((s) => TARGET_NAMES[s.target.target]))])
}

/** One server in a grid. */
export function ServerCard({ server, installed = [], onOpen, onAdd, advanced, compact, className }: ServerCardProps) {
  const isInstalled = installed.length > 0
  const installable = isInstallable(server)
  const meta: string[] = []
  if (server.stars) meta.push(formatCompact(server.stars))
  if (!compact && server.updatedAt) meta.push(`Updated ${formatRelativeTime(server.updatedAt)}`)

  return (
    <Card
      className={cn(
        'group/card relative flex h-full flex-col transition-[border-color,box-shadow,transform] duration-200 ease-smooth',
        'hover:-translate-y-px hover:border-line-strong hover:shadow-md',
        'has-[.card-open:focus-visible]:outline-2 has-[.card-open:focus-visible]:outline-offset-2 has-[.card-open:focus-visible]:outline-ring',
        compact ? 'p-4' : 'p-5',
        className
      )}
    >
      <div className="flex items-start gap-3.5">
        <ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size={compact ? 'md' : 'lg'} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className={cn('flex min-w-0 items-center gap-1.5 leading-6 font-semibold text-fg', compact ? 'text-sm' : 'text-[15px]')}>
            <button
              type="button"
              onClick={onOpen}
              className="card-open min-w-0 truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {server.name}
            </button>
            {compact && server.official ? (
              <BadgeCheck className="size-4 shrink-0 text-accent-text" aria-label="Official" role="img" />
            ) : null}
          </h3>
          {server.publisher ? <p className="truncate text-[13px] leading-5 text-fg-muted">by {server.publisher}</p> : null}
        </div>
        {isInstalled ? (
          <Tooltip content={`Added to ${installedWhere(installed)}`}>
            <Badge tone="success" size="sm" icon={Check} className="relative z-10 mt-0.5">
              Added<span className="sr-only"> to {installedWhere(installed)}</span>
            </Badge>
          </Tooltip>
        ) : null}
      </div>

      <p className={cn('line-clamp-2 text-fg-muted', compact ? 'mt-2.5 text-[13px] leading-5' : 'mt-3 text-[13.5px] leading-[1.55]')}>
        {server.description || 'No description yet.'}
      </p>

      {compact ? null : <ServerBadges server={server} advanced={advanced} className="mt-3.5" />}

      <div className={cn('mt-auto flex items-center justify-between gap-3', compact ? 'pt-3' : 'pt-4')}>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-fg-subtle tabular-nums">
          {server.stars ? <Star className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {meta.length ? <span className="truncate">{meta.join(' · ')}</span> : null}
          {server.stars ? <span className="sr-only"> stars</span> : null}
        </span>
        {installable ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Plus}
            className="relative z-10"
            onClick={onAdd}
            aria-label={`Add ${server.name}${isInstalled ? ' to more apps' : ''}`}
          >
            Add
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="relative z-10" onClick={onOpen}>
            How to set up
          </Button>
        )}
      </div>
    </Card>
  )
}

/** Placeholder with the same shape as a ServerCard. */
export function ServerCardSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface shadow-xs', compact ? 'p-4' : 'p-5')} aria-hidden="true">
      <div className="flex items-start gap-3.5">
        <Skeleton className={compact ? 'size-9 rounded-[10px]' : 'size-11 rounded-xl'} />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
      {compact ? null : (
        <div className="mt-4 flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-5 w-20 rounded-md" />
        </div>
      )}
      <div className="mt-5 flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-16 rounded-lg" />
      </div>
    </div>
  )
}
