import { useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import type { AppSettings, CatalogSource } from '@shared/types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Field,
  List,
  ListItem,
  Select,
  Skeleton,
  Switch,
  toast
} from '@renderer/components/ui'
import { core, errorMessage, useCoreEvent } from '@renderer/lib/api'
import { formatCompact, formatNumber, formatRelativeTime } from '@renderer/lib/format'
import { useAsync } from '@renderer/lib/hooks'
import { SOURCE_META, SOURCE_ORDER, TTL_CHOICES, ttlLabel, withCurrent } from './meta'

export interface SourcesSectionProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<boolean>
  advanced: boolean
}

/** Catalog sources with on/off switches, tool counts, refresh interval and a "Refresh now" button. */
export function SourcesSection({ settings, update, advanced }: SourcesSectionProps) {
  const stats = useAsync(() => core.catalog.stats(), [])
  const [refreshing, setRefreshing] = useState(false)

  useCoreEvent('catalog', (event) => {
    if (event.phase === 'done' || event.phase === 'error') void stats.reload()
  })

  const refresh = (): void => {
    setRefreshing(true)
    toast.promise(core.catalog.refresh({ force: true }), {
      loading: 'Refreshing the tool catalog…',
      success: (next) => `Up to date — ${formatNumber(next.total)} tools`,
      error: (err: unknown) => `Couldn’t refresh: ${errorMessage(err)}`,
      finally: () => {
        setRefreshing(false)
        void stats.reload()
      }
    })
  }

  const toggle = (source: CatalogSource, on: boolean): void => {
    void update({ sources: { ...settings.sources, [source]: on } })
  }

  const ttlOptions = withCurrent(
    TTL_CHOICES.map((c) => c.hours),
    settings.catalogTtlHours
  ).map((hours) => ({ value: String(hours), label: ttlLabel(hours) }))

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-5">
          <Field
            label="Look for new tools"
            className="min-w-56 flex-1"
            hint="Claude Setup refreshes the catalog in the background when it’s older than this."
          >
            <Select
              value={String(settings.catalogTtlHours)}
              options={ttlOptions}
              onValueChange={(v) => void update({ catalogTtlHours: Number(v) })}
            />
          </Field>
          <div className="flex flex-col items-end gap-1 pb-6">
            <Button leftIcon={RefreshCw} loading={refreshing || stats.data?.refreshing} onClick={refresh}>
              Refresh now
            </Button>
            {stats.data ? (
              <span className="text-xs text-fg-subtle">
                {formatNumber(stats.data.total)} tools · updated {formatRelativeTime(stats.data.lastRefreshed)}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {stats.error && !stats.data ? (
        <ErrorState framed size="sm" title="Couldn’t load the catalog sources" error={stats.error} onRetry={() => void stats.reload()} />
      ) : (
        <List aria-label="Catalog sources">
          {SOURCE_ORDER.map((source) => {
            const meta = SOURCE_META[source]
            const status = stats.data?.sources.find((s) => s.source === source)
            const enabled = settings.sources[source] ?? false
            const missingKey = !!meta.needsKey && !settings[meta.needsKey]
            return (
              <ListItem
                key={source}
                title={
                  <span className="flex items-center gap-2">
                    <span>{meta.label}</span>
                    {missingKey ? (
                      <Badge size="sm" tone="warn" icon={KeyRound}>
                        Needs a key
                      </Badge>
                    ) : null}
                  </span>
                }
                description={meta.description}
                meta={
                  !stats.data ? (
                    <Skeleton className="h-3.5 w-16" />
                  ) : enabled && status?.count ? (
                    <span title={advanced && status.lastFetched ? `Fetched ${formatRelativeTime(status.lastFetched)}` : undefined}>
                      {formatCompact(status.count)} tools
                    </span>
                  ) : enabled ? (
                    '—'
                  ) : (
                    'Off'
                  )
                }
                muted={!enabled}
                actions={<Switch checked={enabled} onCheckedChange={(on) => toggle(source, on)} aria-label={`Use ${meta.label}`} />}
              >
                {status?.error && enabled ? <p className="-mt-1.5 text-[12.5px] leading-5 text-danger-text">{status.error}</p> : null}
              </ListItem>
            )
          })}
        </List>
      )}
    </div>
  )
}
