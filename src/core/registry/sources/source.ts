/** Contract between the refresh orchestrator and each registry source adapter. */
import type { AppSettings, CatalogSource } from '@shared/types'
import type { Logger } from '../../context'
import type { PoliteHttp, PoliteHttpOptions } from '../fetcher'
import type { SourceEntry } from '../types'

/** Persisted per-source bookkeeping (stored in the catalog database / cache). */
export interface SourceState {
  /** Last successful refresh (ISO). */
  lastFetched?: string
  /** Last attempt, successful or not (ISO). */
  lastAttempt?: string
  /** Friendly error of the last failed attempt (cleared on success). */
  error?: string
  /** HTTP ETag of single-file sources (Docker catalog). */
  etag?: string
  /** Official registry: last complete crawl (ISO). */
  lastFullCrawl?: string
  /** Official registry: start time of the last successful sync, used as updated_since. */
  syncSince?: string
}

/** Where a source writes what it fetched. */
export interface SourceSink {
  /** Add or replace entries (by sourceId). */
  put(entries: SourceEntry[]): Promise<void>
  /** Delta mode only: remove entries by sourceId. */
  remove(sourceIds: string[]): Promise<void>
}

export interface SourceRunContext {
  http: PoliteHttp
  state: SourceState
  /** User asked to ignore the TTL. */
  force: boolean
  signal: AbortSignal
  settings: AppSettings
  now(): Date
  /** Read a secret by ref (null when missing). */
  secret(ref: string | undefined): Promise<string | null>
  /** Report progress (`count` = entries so far). */
  progress(count: number, message: string): void
  log: Logger
  /**
   * Choose how entries are written before streaming them:
   *  - 'replace': everything put() replaces the source's previous data when the run succeeds
   *  - 'delta':   put()/remove() update the previous data in place
   *  - 'keep':    nothing changed upstream (e.g. HTTP 304); previous data stays
   */
  begin(mode: 'replace' | 'delta' | 'keep'): SourceSink
}

export interface SourceRunResult {
  /** State fields to persist (merged over the previous state). */
  state?: Partial<SourceState>
  /** Short summary for progress events. */
  message?: string
}

export interface SourceAdapter {
  id: CatalogSource
  /** Human name used in messages. */
  label: string
  /** Heavy crawls run after the quick sources. */
  heavy: boolean
  /** Lower bound for the refresh interval of this source, in hours (the user TTL applies when larger). */
  minTtlHours?: number
  /** HTTP politeness for this source. */
  http: Pick<PoliteHttpOptions, 'concurrency' | 'minIntervalMs' | 'timeoutMs'>
  /** False when the source cannot run (e.g. API key missing). */
  available(rc: Pick<SourceRunContext, 'settings' | 'secret'>): Promise<boolean>
  run(rc: SourceRunContext): Promise<SourceRunResult>
}

/** Iterate a cursor-paginated endpoint, stopping on a missing/repeated cursor or an empty page. */
export async function* paginateCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next?: string | null }>,
  maxPages = 5000
): AsyncGenerator<T[]> {
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchPage(cursor)
    if (items.length) yield items
    if (!next || !items.length || seen.has(next)) return
    seen.add(next)
    cursor = next
  }
}
