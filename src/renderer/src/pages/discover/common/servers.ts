/**
 * Shared data for installed servers and catalog lookups, used by Home, Discover and My Tools.
 * One app-wide store (one request at a time, every view sees the same list); any change made through these
 * pages calls bumpServers(), and the core's 'state' event keeps it fresh when something else changes a config.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { CatalogServer, InstalledServer } from '@shared/types'
import { core, errorMessage } from '@renderer/lib/api'
import { refreshTargets } from '@renderer/lib/hooks'

interface InstalledStore {
  data: InstalledServer[] | undefined
  error: string | null
  loading: boolean
}

const useInstalledStore = create<InstalledStore>()(() => ({ data: undefined, error: null, loading: false }))

let inflight: Promise<InstalledServer[] | undefined> | null = null
let queued = false
let listening = false

/** Load the list (requests made while one is running are merged into one more run afterwards). */
function loadInstalled(): Promise<InstalledServer[] | undefined> {
  if (inflight) {
    queued = true
    return inflight
  }
  useInstalledStore.setState({ loading: true })
  const request = core.servers
    .list()
    .then((data) => {
      useInstalledStore.setState({ data, error: null })
      return data
    })
    .catch((err: unknown) => {
      useInstalledStore.setState({ error: errorMessage(err) })
      return undefined
    })
    .finally(() => {
      useInstalledStore.setState({ loading: false })
      inflight = null
      if (queued) {
        queued = false
        void loadInstalled()
      }
    })
  inflight = request
  return request
}

/** Follow the core's 'state' events once for the whole app (another app or Claude itself may change configs). */
function ensureListening(): void {
  if (listening || typeof window === 'undefined' || !window.api) return
  listening = true
  window.api.onEvent((event) => {
    if (event.name === 'state' && event.payload.key === 'servers') void loadInstalled()
  })
}

/** Tell every installed-servers view (and the app list) that something changed. */
export function bumpServers(): void {
  void loadInstalled()
  void refreshTargets()
}

export interface InstalledServersState {
  /** Last loaded list (kept while reloading). */
  data: InstalledServer[] | undefined
  error: string | null
  loading: boolean
  reload: () => Promise<InstalledServer[] | undefined>
  /** Optimistic local change (shared by every view). */
  setData: (next: (prev: InstalledServer[] | undefined) => InstalledServer[] | undefined) => void
  /** Installed entries for a catalog server (by catalog id, or by name for tools added outside Claude Setup). */
  find: (server: Pick<CatalogServer, 'id' | 'slug'>) => InstalledServer[]
}

/** Every installed server across apps. Refreshes when a view mounts (showing the last list meanwhile). */
export function useInstalledServers(): InstalledServersState {
  const data = useInstalledStore((s) => s.data)
  const error = useInstalledStore((s) => s.error)
  const loading = useInstalledStore((s) => s.loading)
  useEffect(() => {
    ensureListening()
    void loadInstalled()
  }, [])
  const setData = useCallback((next: (prev: InstalledServer[] | undefined) => InstalledServer[] | undefined) => {
    useInstalledStore.setState((s) => ({ data: next(s.data) }))
  }, [])
  const find = useMemo(() => {
    const byCatalog = new Map<string, InstalledServer[]>()
    const byName = new Map<string, InstalledServer[]>()
    for (const server of data ?? []) {
      if (server.catalogId) byCatalog.set(server.catalogId, [...(byCatalog.get(server.catalogId) ?? []), server])
      else byName.set(server.name.toLowerCase(), [...(byName.get(server.name.toLowerCase()) ?? []), server])
    }
    return (server: Pick<CatalogServer, 'id' | 'slug'>): InstalledServer[] =>
      byCatalog.get(server.id) ?? byName.get(server.slug.toLowerCase()) ?? []
  }, [data])
  // Before the first answer there is nothing to show yet: report that as loading (avoids an empty-state flash).
  return { data, error, loading: loading || (data === undefined && error === null), reload: loadInstalled, setData, find }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog lookups (icons and names for installed tools)
// ─────────────────────────────────────────────────────────────────────────────

const catalogCache = new Map<string, CatalogServer | null>()
const catalogInflight = new Map<string, Promise<CatalogServer | null>>()

function fetchCatalogServer(id: string): Promise<CatalogServer | null> {
  const cached = catalogCache.get(id)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = catalogInflight.get(id)
  if (pending) return pending
  const request = core.catalog
    .get(id)
    .catch(() => null)
    .then((server) => {
      catalogCache.set(id, server)
      catalogInflight.delete(id)
      return server
    })
  catalogInflight.set(id, request)
  return request
}

/** Remember servers we already have (e.g. from a search) so lookups are instant. */
export function primeCatalog(servers: readonly CatalogServer[]): void {
  for (const server of servers) catalogCache.set(server.id, server)
}

/** Catalog entries for the given ids (missing / unknown ids map to null once looked up). */
export function useCatalogServers(ids: readonly string[]): Map<string, CatalogServer | null> {
  const key = [...new Set(ids)].sort().join('\n')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const missing = key ? key.split('\n').filter((id) => !catalogCache.has(id)) : []
    if (!missing.length) return
    let alive = true
    void Promise.all(missing.map(fetchCatalogServer)).then(() => {
      if (alive) setTick((t) => t + 1)
    })
    return () => {
      alive = false
    }
  }, [key])
  return useMemo(() => {
    const out = new Map<string, CatalogServer | null>()
    for (const id of key ? key.split('\n') : []) {
      const hit = catalogCache.get(id)
      if (hit !== undefined) out.set(id, hit)
    }
    return out
    // `tick` re-reads the cache after lookups finish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
}
