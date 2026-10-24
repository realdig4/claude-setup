/**
 * Discover: search and browse every public MCP registry, filter by category / key / install needs, open a
 * server's details and add it with the install wizard. Filters live in the route params (Back restores them).
 * Receives params.q (search text) and params.server (catalog id → opens its details) from the command palette.
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowDownWideNarrow, Compass, RefreshCw, SearchX, Wrench } from 'lucide-react'
import type { CatalogQuery, CatalogServer, CatalogSource } from '@shared/types'
import { Button, CardGrid, EmptyState, ErrorState, PageHeader, SearchInput, Select, Spinner } from '@renderer/components/ui'
import { MAIN_CONTENT_ID } from '@renderer/components/layout/AppShell'
import { core } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { formatNumber, pluralize } from '@renderer/lib/format'
import { useAsync } from '@renderer/lib/hooks'
import type { PageProps, RouteParams } from '@renderer/lib/nav'
import { useAppStore, useIsAdvanced } from '@renderer/lib/store'
import { CategoryChips, FilterToggles } from './discover/CatalogFilters'
import { CatalogStatusLine, RefreshCatalogButton, useCatalogRefresh } from './discover/CatalogStatus'
import { useInstalledServers } from './discover/common/servers'
import { InstallWizardHost } from './discover/install/InstallWizard'
import { openCustomWizard, openInstallWizard } from './discover/install/store'
import { SOURCE_ORDER } from './discover/lib/catalog'
import { ServerCard, ServerCardSkeleton } from './discover/ServerCard'
import { ServerDetailSheet } from './discover/ServerDetailSheet'
import { PAGE_SIZE, useCatalogSearch } from './discover/useCatalogSearch'

type Sort = NonNullable<CatalogQuery['sort']>

const SORT_LABELS: Record<Sort, string> = {
  relevance: 'Best match',
  popular: 'Most popular',
  updated: 'Recently updated',
  name: 'Name (A–Z)'
}

function text(value: RouteParams[string]): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function isSort(value: string | undefined): value is Sort {
  return value === 'relevance' || value === 'popular' || value === 'updated' || value === 'name'
}

export default function DiscoverPage({ params }: PageProps) {
  const advanced = useIsAdvanced()
  const setParams = (patch: RouteParams): void => useAppStore.getState().replaceParams(patch)

  const q = text(params.q) ?? ''
  const category = text(params.category)
  const sortParam = text(params.sort)
  const noKey = params.nokey === true
  const remote = params.remote === true
  const sourceParam = text(params.source)
  const source = advanced && sourceParam && (SOURCE_ORDER as readonly string[]).includes(sourceParam) ? (sourceParam as CatalogSource) : undefined
  const serverId = text(params.server) ?? null
  const sort: Sort = isSort(sortParam) && !(sortParam === 'relevance' && !q) ? sortParam : q ? 'relevance' : 'popular'
  const filtered = !!(q || category || noKey || remote || source)

  const search = useCatalogSearch({
    query: q || undefined,
    category,
    sort,
    noKeyRequired: noKey || undefined,
    remoteOnly: remote || undefined,
    source
  })
  const categories = useAsync(() => core.catalog.categories(), [])
  const installed = useInstalledServers()
  const refresh = useCatalogRefresh(() => {
    search.reload()
    void categories.reload()
  })
  const [initialServer, setInitialServer] = useState<CatalogServer | undefined>(undefined)

  const openServer = (server: CatalogServer): void => {
    setInitialServer(server)
    setParams({ server: server.id })
  }

  const clearFilters = (): void =>
    setParams({ q: undefined, category: undefined, nokey: undefined, remote: undefined, source: undefined, sort: undefined })

  return (
    <>
      <PageHeader
        icon={Compass}
        title="Discover"
        subtitle="Find tools that give Claude new abilities — then add them in a click."
        actions={
          <>
            {advanced ? (
              <Button leftIcon={Wrench} onClick={openCustomWizard}>
                Add custom tool
              </Button>
            ) : null}
            <RefreshCatalogButton state={refresh} />
          </>
        }
      >
        <div className="space-y-2.5">
          <SearchInput
            size="lg"
            value={q}
            onValueChange={(value) => setParams({ q: value.trim() ? value : undefined })}
            placeholder="Search tools — try “GitHub”, “files” or “database”"
            aria-label="Search tools"
            shortcut="/"
            loading={search.loading && search.items.length > 0}
          />
          <CatalogStatusLine state={refresh} advanced={advanced} />
        </div>
      </PageHeader>

      <div className="space-y-6">
        <CategoryChips categories={categories.data} category={category} onCategory={(id) => setParams({ category: id })} advanced={advanced} />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line pb-3">
          <p className="text-[13px] text-fg-muted" aria-live="polite">
            {search.error ? (
              'Search isn’t working right now'
            ) : search.loading && !search.items.length ? (
              'Searching…'
            ) : (
              <>
                <span className="font-semibold text-fg tabular-nums">{formatNumber(search.total)}</span>{' '}
                {search.total === 1 ? 'tool' : 'tools'}
                {q ? (
                  <>
                    {' '}
                    for <span className="font-medium text-fg">“{q}”</span>
                  </>
                ) : null}
              </>
            )}
            {filtered ? (
              <Button variant="link" size="sm" className="ml-3" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <FilterToggles
              noKey={noKey}
              onNoKey={(value) => setParams({ nokey: value || undefined })}
              remote={remote}
              onRemote={(value) => setParams({ remote: value || undefined })}
              source={source}
              onSource={(value) => setParams({ source: value })}
              advanced={advanced}
            />
            <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
            <ArrowDownWideNarrow className="size-4 text-fg-subtle" aria-hidden="true" />
            <Select
              size="sm"
              aria-label="Sort by"
              value={sort}
              containerClassName="w-auto"
              onValueChange={(value) => setParams({ sort: isSort(value) ? value : undefined })}
              options={(q ? (['relevance', 'popular', 'updated', 'name'] as Sort[]) : (['popular', 'updated', 'name'] as Sort[])).map((s) => ({
                value: s,
                label: SORT_LABELS[s]
              }))}
            />
          </div>
        </div>

        <Results
          search={search}
          filtered={filtered}
          advanced={advanced}
          refreshing={refresh.refreshing}
          onRefresh={refresh.refresh}
          onClearFilters={clearFilters}
          onOpen={openServer}
          installedFor={installed.find}
        />
      </div>

      <ServerDetailSheet
        serverId={serverId}
        initial={initialServer}
        onClose={() => setParams({ server: undefined })}
        onAdd={openInstallWizard}
        categories={categories.data}
        installedFor={installed.find}
        advanced={advanced}
      />
      <InstallWizardHost />
    </>
  )
}

interface ResultsProps {
  search: ReturnType<typeof useCatalogSearch>
  filtered: boolean
  advanced: boolean
  refreshing: boolean
  onRefresh: () => void
  onClearFilters: () => void
  onOpen: (server: CatalogServer) => void
  installedFor: ReturnType<typeof useInstalledServers>['find']
}

/** The result grid with skeletons, empty / error states and infinite scroll. */
function Results({ search, filtered, advanced, refreshing, onRefresh, onClearFilters, onOpen, installedFor }: ResultsProps) {
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasMore, loadingMore, moreError, loadMore, loading } = search

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || loadingMore || moreError || loading || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { root: document.getElementById(MAIN_CONTENT_ID), rootMargin: '0px 0px 600px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, moreError, loading, loadMore, search.items.length])

  if (search.error) {
    return <ErrorState framed title="Couldn’t search the catalog" error={search.error} onRetry={search.reload} />
  }

  if (search.loading && !search.items.length) {
    return (
      <CardGrid minItemWidth={290} aria-busy="true" aria-label="Loading tools">
        {Array.from({ length: 8 }, (_, i) => (
          <ServerCardSkeleton key={i} />
        ))}
      </CardGrid>
    )
  }

  if (!search.items.length) {
    return filtered ? (
      <EmptyState
        framed
        icon={SearchX}
        title="No tools match"
        description="Try a different word, pick another category, or clear the filters."
        actions={<Button onClick={onClearFilters}>Clear filters</Button>}
      />
    ) : (
      <EmptyState
        framed
        icon={Compass}
        title="The catalog is empty"
        description="Claude Setup couldn’t load any tools yet. Check your internet connection, then refresh the catalog."
        actions={
          <Button variant="primary" leftIcon={RefreshCw} loading={refreshing} onClick={onRefresh}>
            Refresh catalog
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Results</h2>
      <CardGrid
        minItemWidth={290}
        aria-busy={search.loading || undefined}
        className={cn('transition-opacity duration-200', search.loading && 'pointer-events-none opacity-55')}
      >
        {search.items.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            installed={installedFor(server)}
            advanced={advanced}
            onOpen={() => onOpen(server)}
            onAdd={() => openInstallWizard(server)}
          />
        ))}
      </CardGrid>

      <div ref={sentinel} className="flex min-h-12 flex-col items-center justify-center gap-2">
        {moreError ? (
          <div className="flex flex-col items-center gap-2 text-center" role="alert">
            <p className="text-[13px] text-fg-muted">Couldn’t load more tools. {moreError}</p>
            <Button size="sm" onClick={loadMore}>
              Try again
            </Button>
          </div>
        ) : hasMore ? (
          <Button variant="outline" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>
            {loadingMore ? <Spinner size="xs" label={null} /> : null}
            {loadingMore ? 'Loading more…' : `Show more (${formatNumber(search.total - search.items.length)} left)`}
          </Button>
        ) : search.items.length > PAGE_SIZE ? (
          <p className="text-[12.5px] text-fg-subtle">That’s all {pluralize(search.items.length, 'tool')}.</p>
        ) : null}
      </div>
    </div>
  )
}
