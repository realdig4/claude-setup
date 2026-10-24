/**
 * Small JSON cache for catalog sources in <cacheDir>/extensions. Each key is one file
 * ({ version, fetchedAt, data }). Fresh data is served from memory; stale data is used
 * when a refresh fails, so one broken source never empties the catalog.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../fs/json'
import { errorMessage } from './util'

/** Catalog sources are refreshed after 12 hours. */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000

/** Cache keys of the catalog sources. */
export const CACHE_KEYS = {
  cli: 'plugins-cli',
  marketplacePrefix: 'mkt-',
  marketplace: (name: string) => `mkt-${name}`,
  aitmpl: 'aitmpl',
  anthropicSkills: 'anthropic-skills',
  skillsShPrefix: 'skillssh-',
  skillsSh: (hash: string) => `skillssh-${hash}`
} as const

interface Envelope<T> {
  version: 1
  fetchedAt: string
  data: T
}

export interface CacheEntry<T> {
  data: T
  fetchedAt: number
}

export interface LoadResult<T> extends CacheEntry<T> {
  /** Served from an expired cache because the refresh failed. */
  stale: boolean
  /** Refresh error (when stale). */
  error?: string
}

/** After a failed refresh, wait this long before trying the same source again. */
const FAILURE_BACKOFF_MS = 2 * 60 * 1000

export class ExtensionsCache {
  private readonly memory = new Map<string, CacheEntry<unknown>>()
  private readonly inflight = new Map<string, Promise<LoadResult<unknown>>>()
  private readonly failures = new Map<string, { at: number; error: string }>()

  constructor(readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, key.replace(/[^A-Za-z0-9._-]/g, '_') + '.json')
  }

  /** Cached value (memory first, then disk), regardless of age. */
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const mem = this.memory.get(key)
    if (mem) return mem as CacheEntry<T>
    const r = await readJson<Envelope<T>>(this.file(key))
    if (!r.data || r.data.version !== 1 || typeof r.data.fetchedAt !== 'string') return null
    const fetchedAt = Date.parse(r.data.fetchedAt)
    if (!Number.isFinite(fetchedAt)) return null
    const entry: CacheEntry<T> = { data: r.data.data, fetchedAt }
    this.memory.set(key, entry)
    return entry
  }

  async set<T>(key: string, data: T): Promise<CacheEntry<T>> {
    const entry: CacheEntry<T> = { data, fetchedAt: Date.now() }
    this.memory.set(key, entry)
    const envelope: Envelope<T> = { version: 1, fetchedAt: new Date(entry.fetchedAt).toISOString(), data }
    await writeJsonAtomic(this.file(key), envelope, { indent: 0 }).catch(() => {})
    return entry
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key)
    this.failures.delete(key)
    await rm(this.file(key), { force: true }).catch(() => {})
  }

  /** Drop every key starting with `prefix` (memory and disk). */
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key)
    for (const key of [...this.failures.keys()]) if (key.startsWith(prefix)) this.failures.delete(key)
    const safe = prefix.replace(/[^A-Za-z0-9._-]/g, '_')
    const names = await readdir(this.dir).catch(() => [] as string[])
    await Promise.all(names.filter((n) => n.startsWith(safe)).map((n) => rm(join(this.dir, n), { force: true }).catch(() => {})))
  }

  /**
   * Fresh cached data or the result of `fetcher`. Concurrent calls share one fetch.
   * When the fetch fails, expired data is returned with `stale: true`; with no cache at all the error is rethrown.
   */
  async load<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, opts: { force?: boolean } = {}): Promise<LoadResult<T>> {
    const cached = await this.get<T>(key)
    if (cached && !opts.force && Date.now() - cached.fetchedAt < ttlMs) return { ...cached, stale: false }
    // A source that just failed is not retried on every call (search-as-you-type would hammer it).
    const failure = this.failures.get(key)
    if (failure && !opts.force && Date.now() - failure.at < FAILURE_BACKOFF_MS) {
      if (cached) return { ...cached, stale: true, error: failure.error }
      throw new Error(failure.error)
    }
    const running = this.inflight.get(key)
    if (running) return running as Promise<LoadResult<T>>
    const job = (async (): Promise<LoadResult<T>> => {
      try {
        const data = await fetcher()
        this.failures.delete(key)
        const entry = await this.set(key, data)
        return { ...entry, stale: false }
      } catch (err) {
        const error = errorMessage(err)
        this.failures.set(key, { at: Date.now(), error })
        if (cached) return { ...cached, stale: true, error }
        throw err
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, job)
    return job
  }

  /** Remove files with the given prefix that are older than `maxAgeMs` (keeps the cache dir tidy). */
  async prune(prefix: string, maxAgeMs: number): Promise<void> {
    const safe = prefix.replace(/[^A-Za-z0-9._-]/g, '_')
    const names = await readdir(this.dir).catch(() => [] as string[])
    const now = Date.now()
    await Promise.all(
      names
        .filter((n) => n.startsWith(safe))
        .map(async (n) => {
          const s = await stat(join(this.dir, n)).catch(() => null)
          if (s && now - s.mtimeMs > maxAgeMs) await rm(join(this.dir, n), { force: true }).catch(() => {})
        })
    )
  }
}
