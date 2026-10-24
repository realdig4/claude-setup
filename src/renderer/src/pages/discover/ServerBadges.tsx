/** Status badges for a catalog server (official, online, needs a key, registry sources in Advanced mode). */
import { BadgeCheck, Cloud, KeyRound, ShieldCheck } from 'lucide-react'
import type { CatalogServer } from '@shared/types'
import { Badge, type BadgeSize } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { SOURCE_LABELS, hasRemoteOption, serverNeedsKey } from './lib/catalog'

export interface ServerBadgesProps {
  server: CatalogServer
  advanced: boolean
  size?: BadgeSize
  /** Also list the registries the server was found in (Advanced). */
  showSources?: boolean
  className?: string
}

/** A compact row of badges describing a server. */
export function ServerBadges({ server, advanced, size = 'sm', showSources = advanced, className }: ServerBadgesProps) {
  const remote = hasRemoteOption(server)
  const needsKey = serverNeedsKey(server)
  const sources = server.sources.filter((s) => s !== 'seed')
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {server.official ? (
        <Badge size={size} tone="accent" icon={BadgeCheck}>
          Official
        </Badge>
      ) : server.verified ? (
        <Badge size={size} tone="info" icon={ShieldCheck}>
          Verified
        </Badge>
      ) : null}
      {remote ? (
        <Badge size={size} tone="neutral" icon={Cloud}>
          {advanced ? 'Remote' : 'No install'}
        </Badge>
      ) : null}
      {needsKey ? (
        <Badge size={size} tone="warn" icon={KeyRound}>
          {advanced ? 'Needs key' : 'Needs a key'}
        </Badge>
      ) : null}
      {showSources
        ? sources.map((source) => (
            <Badge key={source} size={size} variant="outline" tone="neutral">
              {SOURCE_LABELS[source]}
            </Badge>
          ))
        : null}
    </div>
  )
}
