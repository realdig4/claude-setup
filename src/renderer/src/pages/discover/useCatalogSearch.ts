/**
 * Paged catalog search for the Discover grid: loads the first page when the query changes (keeping the old
 * results visible meanwhile), appends further pages on demand and ignores out-of-order responses.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogQuery, CatalogServer } from '@shared/types'
import { core, errorMessage } from '@renderer/lib/api'
import { useLatest } from '@renderer/lib/hooks'
import { primeCatalog } from './common/servers'

export const PAGE_SIZE = 24

export interface CatalogSearchState {
  items: CatalogServer[]
  total: number
  /** First page in flight (items may still show the previous query's results). */
  loading: boolean
  loadingMore: boolean
  /** The first page failed. */
  error: string | null
  /** Loading another page failed. */
  moreError: string | null
  hasMore: boolean
  /** Results belong to the current query. */
  current: boolean
  loadMore: () => void
  reload: () => void
}

interface State {
  key: string
  items: CatalogServer[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  moreError: string | null
}

const INITIAL: State = { key: '', items: [], total: 0, loading: true, loadingMore: false, error: null, moreError: null }

/** Search the catalog with offset/limit paging. `query` must not contain offset/limit. */
export function useCatalogSearch(query: Omit<CatalogQuery, 'offset' | 'limit'>): CatalogSearchState {
  const key = JSON.stringify(query)
  const [state, setState] = useState<State>(INITIAL)
  const seq = useRef(0)
  const stateRef = useLatest(state)

  const loadFirst = useCallback(async (queryKey: string) => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, loadingMore: false, error: null, moreError: null }))
    try {
      const page = await core.catalog.search({ ...(JSON.parse(queryKey) as CatalogQuery), offset: 0, limit: PAGE_SIZE })
      if (id !== seq.current) return
      primeCatalog(page.items)
      setState({ key: queryKey, items: page.items, total: page.total, loading: false, loadingMore: false, error: null, moreError: null })
    } catch (err) {
      if (id !== seq.current) return
      setState({ key: queryKey, items: [], total: 0, loading: false, loadingMore: false, error: errorMessage(err), moreError: null })
    }
  }, [])

  useEffect(() => {
    void loadFirst(key)
  }, [key, loadFirst])

  const loadMore = useCallback(() => {
    const s = stateRef.current
    if (s.loading || s.loadingMore || s.error || s.items.length >= s.total) return
    const id = seq.current
    const offset = s.items.length
    setState((prev) => ({ ...prev, loadingMore: true, moreError: null }))
    core.catalog
      .search({ ...(JSON.parse(s.key) as CatalogQuery), offset, limit: PAGE_SIZE })
      .then((page) => {
        if (id !== seq.current) return
        primeCatalog(page.items)
        setState((prev) => {
          const seen = new Set(prev.items.map((i) => i.id))
          const added = page.items.filter((i) => !seen.has(i.id))
          // A page with nothing new means the end (protects against a shifting total).
          const total = added.length ? page.total : prev.items.length
          return { ...prev, items: [...prev.items, ...added], total, loadingMore: false }
        })
      })
      .catch((err: unknown) => {
        if (id !== seq.current) return
        setState((prev) => ({ ...prev, loadingMore: false, moreError: errorMessage(err) }))
      })
  }, [stateRef])

  const reload = useCallback(() => {
    void loadFirst(key)
  }, [key, loadFirst])

  return {
    items: state.items,
    total: state.total,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    moreError: state.moreError,
    hasMore: state.items.length < state.total,
    current: state.key === key && !state.loading,
    loadMore,
    reload
  }
}
