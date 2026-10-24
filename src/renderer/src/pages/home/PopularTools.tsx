/** Home "Popular tools": hand-picked, beginner-friendly servers with one-click Add. */
import type { CatalogServer, InstalledServer } from '@shared/types'
import { ErrorState } from '@renderer/components/ui'
import { openInstallWizard } from '../discover/install/store'
import { ServerCard, ServerCardSkeleton } from '../discover/ServerCard'

export interface PopularToolsProps {
  servers: CatalogServer[] | undefined
  error: string | null
  onRetry: () => void
  installedFor: (server: CatalogServer) => InstalledServer[]
  onOpen: (server: CatalogServer) => void
  advanced: boolean
  /** How many to show (default 6 — two full rows of three). */
  limit?: number
}

/** Grid of featured tools — ones not added yet come first. */
export function PopularTools({ servers, error, onRetry, installedFor, onOpen, advanced, limit = 6 }: PopularToolsProps) {
  if (error && !servers) return <ErrorState size="sm" framed title="Couldn’t load popular tools" error={error} onRetry={onRetry} />
  const ordered = servers ? [...servers].sort((a, b) => Number(installedFor(a).length > 0) - Number(installedFor(b).length > 0)) : undefined
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy={!servers || undefined}>
      {ordered
        ? ordered.slice(0, limit).map((server) => (
            <ServerCard
              key={server.id}
              compact
              server={server}
              installed={installedFor(server)}
              advanced={advanced}
              onOpen={() => onOpen(server)}
              onAdd={() => openInstallWizard(server)}
            />
          ))
        : Array.from({ length: 3 }, (_, i) => <ServerCardSkeleton key={i} compact />)}
    </div>
  )
}
