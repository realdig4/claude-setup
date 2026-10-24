/**
 * Catalog storage. Two implementations share this interface:
 *  - SqliteStore (node:sqlite + FTS5, cacheDir/catalog.db) — the normal case
 *  - MemoryStore (in-memory index persisted as cacheDir/catalog-cache.json) — fallback when node:sqlite
 *    is unavailable or the database cannot be opened
 */
import type { CatalogPage, CatalogServer, CatalogSource, CategoryInfo } from '@shared/types'
import type { Logger } from '../context'
import type { SearchRequest } from './search'
import type { MergedServer, SourceEntry } from './types'

/** Writes of one source refresh. Every method is serialized with rebuilds by the store. */
export interface SourceWriter {
  put(entries: SourceEntry[]): Promise<void>
  remove(sourceIds: string[]): Promise<void>
  /** Make the written data live (replace mode drops the previous data). */
  commit(): Promise<void>
  /** Discard staged data (replace mode); delta writes already applied stay. */
  abort(): Promise<void>
  /** True once at least one put/remove happened. */
  readonly changed: boolean
}

export interface RebuildOptions {
  /** Only entries of these sources are merged. */
  enabled: ReadonlySet<CatalogSource>
  featured: ReadonlySet<string>
  signal?: AbortSignal
}

/** A merged server as stored. */
export interface StoredServer {
  server: CatalogServer
  refs: MergedServer['refs']
  remote: boolean
  needsKey: boolean
  hidden: boolean
}

export interface CatalogStore {
  readonly kind: 'sqlite' | 'memory'
  /** Entry counts per source (live data only). */
  counts(): Partial<Record<CatalogSource, number>>
  openSource(source: CatalogSource, mode: 'replace' | 'delta'): SourceWriter
  /** Re-merge all live entries of the enabled sources and swap the searchable index. Returns server count. */
  rebuild(opts: RebuildOptions): Promise<number>
  /** True when a merged index exists. */
  hasIndex(): boolean
  search(req: SearchRequest): CatalogPage
  /** By id or alias (ids of earlier merges / source ids). */
  get(id: string): StoredServer | null
  /** Replace a stored server after lazy enrichment. */
  updateServer(id: string, value: Omit<StoredServer, 'refs'>): void
  categories(): CategoryInfo[]
  total(): number
  getMeta<T>(key: string): T | undefined
  setMeta(key: string, value: unknown): void
  getDetail(key: string): { fetchedAt: string; data: unknown } | undefined
  setDetail(key: string, data: unknown): void
  close(): void
}

/** Serializes async critical sections (store writes vs. rebuilds). */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Open the best available store: SQLite in `cacheDir/catalog.db`, else the JSON-backed memory store.
 */
export async function openStore(cacheDir: string, log: Logger, opts: { forceMemory?: boolean } = {}): Promise<CatalogStore> {
  if (!opts.forceMemory) {
    try {
      const { openSqliteStore } = await import('./sqlite-store')
      return await openSqliteStore(cacheDir)
    } catch (err) {
      log.warn('catalog', `Fast catalog database unavailable (${(err as Error).message}); using the simple cache instead.`)
    }
  }
  const { openMemoryStore } = await import('./memory-store')
  return openMemoryStore(cacheDir, log)
}
