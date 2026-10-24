/**
 * Catalog freshness: stats line, "Refresh catalog" with live progress from core 'catalog' events, and an
 * Advanced sheet listing every registry's status.
 */
import { useRef, useState } from 'react'
import { Database, RefreshCw, Settings } from 'lucide-react'
import type { CatalogStats } from '@shared/types'
import { Badge, Button, ProgressBar, Sheet, Skeleton, TBody, TD, TH, THead, TR, Table, toast } from '@renderer/components/ui'
import { core, errorMessage, useCoreEvent } from '@renderer/lib/api'
import { useAsync, useLatest } from '@renderer/lib/hooks'
import { formatNumber, formatRelativeTime, pluralize } from '@renderer/lib/format'
import { useNavigate } from '@renderer/lib/store'
import { SOURCE_LABELS, SOURCE_ORDER } from './lib/catalog'

export interface CatalogRefreshState {
  stats: CatalogStats | undefined
  statsError: string | null
  refreshing: boolean
  /** 0–100 while refreshing (undefined = unknown). */
  pct: number | undefined
  message: string | null
  refresh: () => void
}

/**
 * Catalog stats + refresh. `onUpdated` runs once whenever a refresh finishes (also ones started elsewhere,
 * e.g. at startup or from the command palette), so results can be reloaded.
 */
export function useCatalogRefresh(onUpdated: () => void): CatalogRefreshState {
  const stats = useAsync(() => core.catalog.stats(), [])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const sawDone = useRef(false)
  const onUpdatedRef = useLatest(onUpdated)

  useCoreEvent('catalog', (event) => {
    if (event.phase === 'start') {
      setRunning(true)
      setDone(0)
      setMessage(event.message ?? 'Updating the catalog…')
    } else if (event.phase === 'source') {
      setDone((d) => d + 1)
      const label = event.source && event.source in SOURCE_LABELS ? SOURCE_LABELS[event.source as keyof typeof SOURCE_LABELS] : event.source
      setMessage(`Checked ${label ?? 'a registry'}${event.count ? ` · ${formatNumber(event.count)} tools` : ''}`)
    } else if (event.phase === 'done') {
      sawDone.current = true
      setRunning(false)
      setMessage(null)
      void stats.reload()
      onUpdatedRef.current()
    } else if (event.phase === 'error') {
      setRunning(false)
      setMessage(null)
      void stats.reload()
    }
  })

  const refresh = (): void => {
    if (running || stats.data?.refreshing) return
    setRunning(true)
    setDone(0)
    setMessage('Updating the catalog…')
    sawDone.current = false
    core.catalog
      .refresh({ force: true })
      .then((next) => {
        stats.setData(next)
        toast.success('The catalog is up to date', { description: `${formatNumber(next.total)} tools available.` })
        if (!sawDone.current) onUpdatedRef.current()
      })
      .catch((err: unknown) => {
        toast.error('Couldn’t update the catalog', {
          description: `${errorMessage(err)} You can keep browsing — the tools you see still work.`,
          duration: 8000
        })
      })
      .finally(() => {
        setRunning(false)
        setMessage(null)
      })
  }

  const refreshing = running || !!stats.data?.refreshing
  const enabled = stats.data?.sources.filter((s) => s.enabled).length ?? 0
  const pct = refreshing && enabled > 0 && done > 0 ? Math.min(100, Math.round((done / enabled) * 100)) : undefined
  return { stats: stats.data, statsError: stats.error, refreshing, pct, message: refreshing ? (message ?? 'Updating the catalog…') : null, refresh }
}

/** "Refresh catalog" button. */
export function RefreshCatalogButton({ state }: { state: CatalogRefreshState }) {
  return (
    <Button leftIcon={RefreshCw} loading={state.refreshing} onClick={state.refresh}>
      {state.refreshing ? 'Updating…' : 'Refresh catalog'}
    </Button>
  )
}

export interface CatalogStatusLineProps {
  state: CatalogRefreshState
  advanced: boolean
}

/** Quiet line under the search box: catalog size and freshness, or live refresh progress. */
export function CatalogStatusLine({ state, advanced }: CatalogStatusLineProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const { stats } = state

  if (state.refreshing) {
    return (
      <div className="flex max-w-xl items-center gap-3" role="status">
        <ProgressBar value={state.pct} label="Updating the catalog" size="sm" className="w-40 shrink-0" />
        <span className="truncate text-[12.5px] text-fg-muted">{state.message}</span>
      </div>
    )
  }
  if (!stats) {
    if (!state.statsError) return <Skeleton className="h-4 w-64" />
    return <span className="text-[12.5px] text-fg-subtle">Catalog details aren’t available right now.</span>
  }

  const active = stats.sources.filter((s) => s.enabled && s.count > 0)
  const failing = stats.sources.filter((s) => s.enabled && s.error)
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-fg-muted">
      <span className="tabular-nums">{pluralize(stats.total, 'tool')}</span>
      {advanced ? (
        <>
          <span aria-hidden="true">from</span>
          <button
            type="button"
            onClick={() => setSourcesOpen(true)}
            className="rounded-sm font-medium text-accent-text underline-offset-[3px] hover:underline"
          >
            {pluralize(active.length, 'registry', 'registries')}
          </button>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span>{stats.lastRefreshed ? `updated ${formatRelativeTime(stats.lastRefreshed)}` : 'not updated yet'}</span>
      {advanced && failing.length ? (
        <Badge size="sm" tone="warn" className="ml-1">
          {pluralize(failing.length, 'registry', 'registries')} had a problem
        </Badge>
      ) : null}
      {advanced ? <SourcesSheet open={sourcesOpen} onOpenChange={setSourcesOpen} stats={stats} /> : null}
    </div>
  )
}

function SourcesSheet({ open, onOpenChange, stats }: { open: boolean; onOpenChange: (open: boolean) => void; stats: CatalogStats }) {
  const navigate = useNavigate()
  const sources = [...stats.sources].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Catalog registries"
      description={`${formatNumber(stats.total)} tools after merging duplicates.`}
      media={<Database className="mt-1 size-5 text-fg-subtle" aria-hidden="true" />}
      footer={
        <Button
          leftIcon={Settings}
          onClick={() => {
            onOpenChange(false)
            navigate('settings')
          }}
        >
          Choose registries in Settings
        </Button>
      }
    >
      <Table>
        <THead>
          <TR>
            <TH>Registry</TH>
            <TH align="right">Tools</TH>
            <TH>Updated</TH>
            <TH>Status</TH>
          </TR>
        </THead>
        <TBody>
          {sources.map((s) => (
            <TR key={s.source}>
              <TD className="font-medium">{SOURCE_LABELS[s.source]}</TD>
              <TD align="right">{s.enabled ? formatNumber(s.count) : '—'}</TD>
              <TD className="text-fg-muted">{s.lastFetched ? formatRelativeTime(s.lastFetched) : '—'}</TD>
              <TD>
                {!s.enabled ? (
                  <Badge size="sm">Off</Badge>
                ) : s.error ? (
                  <Badge size="sm" tone="warn" title={s.error}>
                    Problem
                  </Badge>
                ) : (
                  <Badge size="sm" tone="success" dot>
                    On
                  </Badge>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {sources.some((s) => s.enabled && s.error) ? (
        <ul className="mt-4 space-y-1.5 text-[12.5px] leading-5 text-fg-muted">
          {sources
            .filter((s) => s.enabled && s.error)
            .map((s) => (
              <li key={s.source}>
                <span className="font-medium text-fg">{SOURCE_LABELS[s.source]}:</span> {s.error}
              </li>
            ))}
        </ul>
      ) : null}
    </Sheet>
  )
}
