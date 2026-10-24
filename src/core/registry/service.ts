/**
 * CatalogService: owns the store, bootstraps the bundled seed, runs refreshes (quick sources first,
 * then heavy crawls), enriches Smithery entries lazily and exposes the CatalogApi.
 * Nothing here blocks search: refreshes write to staging data and the index is swapped atomically.
 */
import type { CatalogApi } from '@shared/api'
import type {
  AppSettings,
  CatalogPage,
  CatalogQuery,
  CatalogServer,
  CatalogSource,
  CatalogSourceStatus,
  CatalogStats,
  CategoryInfo
} from '@shared/types'
import type { CoreContext } from '../context'
import { mergeGroup } from './dedupe'
import { mapLimit, PoliteHttp, type PoliteHttpOptions } from './fetcher'
import { assignOptionIds, optionDedupeKey, serverNeedsKey } from './install'
import { emptyPage, normalizeQuery } from './search'
import { FEATURED_IDS, SEED_SERVERS, seedEntries } from './seed'
import { bundledEntries, loadBundledSeed, type SeedPayload } from './seed-data'
import { NETWORK_SOURCES } from './sources'
import { fetchSmitheryDetail, smitheryBundleUrl, smitheryHostedUrl, type SmitheryDetail } from './sources/smithery'
import type { SourceAdapter, SourceRunContext, SourceSink, SourceState } from './sources/source'
import { openStore, type CatalogStore, type SourceWriter } from './store'
import type { SourceEntry } from './types'
import { errorMessage } from './util'

/** Every catalog source, in stats() order. */
export const ALL_SOURCES: readonly CatalogSource[] = [
  'official',
  'anthropic',
  'github',
  'smithery',
  'docker',
  'cline',
  'awesome',
  'glama',
  'pulsemcp',
  'seed'
]

const KEYED_SOURCES: Partial<Record<CatalogSource, 'glamaKeyRef' | 'pulsemcpKeyRef'>> = { glama: 'glamaKeyRef', pulsemcp: 'pulsemcpKeyRef' }
/** Do not retry a failing source more often than this unless forced. */
const ERROR_RETRY_MS = 15 * 60_000
const DETAIL_TTL_MS = 7 * 24 * 3600_000
const PROGRESS_INTERVAL_MS = 400
/** After a failed Smithery detail lookup, wait this long before trying the same server again. */
const DETAIL_RETRY_MS = 5 * 60_000
const SEED_SCHEMA = 1

const NOOP_SINK: SourceSink = { put: async () => {}, remove: async () => {} }
/** Sources without launch data of their own: Smithery details are worth fetching only for these servers. */
const DISCOVERY_SOURCES: ReadonlySet<CatalogSource> = new Set<CatalogSource>(['smithery', 'cline', 'awesome', 'glama'])

export interface CatalogServiceOptions {
  /** Override HTTP politeness for every source (tests). */
  http?: Partial<PoliteHttpOptions>
  now?: () => Date
  /** Use the JSON-backed store even when node:sqlite works (tests). */
  forceMemoryStore?: boolean
  /** Replace the network sources (tests). */
  sources?: readonly SourceAdapter[]
  /** Bundled seed override; null disables it (tests). */
  seed?: SeedPayload | null
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Small stable hash (FNV-1a) used to detect curated-seed changes between app versions. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Replace list-derived Smithery options with the detailed ones (idempotent). */
export function applySmitheryDetail(server: CatalogServer, qualifiedName: string, detail: SmitheryDetail): CatalogServer {
  const listUrls = new Set([smitheryHostedUrl(qualifiedName), smitheryBundleUrl(qualifiedName)])
  const detailKeys = new Set(detail.options.map(optionDedupeKey))
  let install = [
    ...server.install.filter((o) => !listUrls.has(o.url ?? '') && !listUrls.has(o.package ?? '') && !detailKeys.has(optionDedupeKey(o))),
    ...detail.options
  ]
  if (install.some((o) => o.kind !== 'manual')) install = install.filter((o) => o.kind !== 'manual')
  return { ...server, install: assignOptionIds(install) }
}

export class CatalogService {
  readonly api: CatalogApi
  private store?: CatalogStore
  private readyPromise?: Promise<CatalogStore>
  private refreshing?: Promise<CatalogStats>
  private rebuilding?: Promise<void>
  private rebuildAgain = false
  private readonly controller = new AbortController()
  private closed = false
  private curated?: SourceEntry[]
  private readonly detailFailures = new Map<string, number>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly ctx: CoreContext,
    private readonly opts: CatalogServiceOptions = {}
  ) {
    this.api = {
      search: (q) => this.search(q),
      get: (id) => this.get(id),
      categories: () => this.categories(),
      featured: () => this.featured(),
      stats: () => this.stats(),
      refresh: (o) => this.refresh(o)
    }
    // Sources switched on/off in Settings → start re-merging right away (search keeps the old index meanwhile).
    this.unsubscribe = ctx.events.on('state', (e) => {
      if (e.key === 'settings' && this.store && !this.closed) this.checkSettings(this.store)
    })
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  private settings(): AppSettings {
    return this.ctx.state.get().settings
  }

  private emit(payload: { phase: 'start' | 'source' | 'done' | 'error'; source?: string; count?: number; message?: string }): void {
    this.ctx.events.emitEvent('catalog', payload)
  }

  private async secret(ref: string | undefined): Promise<string | null> {
    if (!ref) return null
    try {
      return await this.ctx.secrets.get(ref)
    } catch {
      return null
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private ready(): Promise<CatalogStore> {
    this.readyPromise ??= this.init().catch((err) => {
      this.readyPromise = undefined
      throw err
    })
    return this.readyPromise
  }

  private async init(): Promise<CatalogStore> {
    if (this.closed) throw new Error('The catalog has been closed.')
    const store = await openStore(this.ctx.cacheDir, this.ctx.log, { forceMemory: this.opts.forceMemoryStore })
    if (this.closed) {
      store.close()
      throw new Error('The catalog has been closed.')
    }
    this.store = store
    try {
      await this.bootstrapSeed(store)
      if (!store.hasIndex() || store.getMeta<string>('enabledSig') !== this.enabledSignature()) await this.rebuild(store)
    } catch (err) {
      this.store = undefined
      store.close()
      throw err
    }
    return store
  }

  /** Load the curated + bundled seed when this app version ships a different one. */
  private async bootstrapSeed(store: CatalogStore): Promise<void> {
    const payload = this.opts.seed === undefined ? await loadBundledSeed() : this.opts.seed
    const version = `${SEED_SCHEMA}|${payload?.generatedAt ?? 'none'}|${hash(JSON.stringify(SEED_SERVERS))}`
    if (store.getMeta<string>('seedVersion') === version) return
    const curated = store.openSource('seed', 'replace')
    await curated.put(this.curatedEntries())
    await curated.commit()
    if (payload) {
      for (const [source, entries] of Object.entries(bundledEntries(payload)) as Array<[CatalogSource, SourceEntry[]]>) {
        if (store.getMeta<SourceState>(`state:${source}`)?.lastFetched) continue
        const w = store.openSource(source, 'replace')
        await w.put(entries)
        await w.commit()
      }
    }
    store.setMeta('seedVersion', version)
    store.setMeta('seedLoadedAt', payload?.generatedAt ?? this.now().toISOString())
    store.setMeta('enabledSig', undefined)
  }

  private curatedEntries(): SourceEntry[] {
    this.curated ??= seedEntries()
    return this.curated
  }

  /** Cheap signature of the settings that affect which sources are merged. */
  private enabledSignature(): string {
    const s = this.settings()
    return JSON.stringify([ALL_SOURCES.map((src) => s.sources?.[src] !== false), !!s.glamaKeyRef, !!s.pulsemcpKeyRef])
  }

  /** Sources switched on in settings (keyed sources also need their secret). */
  private async enabledSources(): Promise<Set<CatalogSource>> {
    const s = this.settings()
    const out = new Set<CatalogSource>()
    for (const source of ALL_SOURCES) {
      if (s.sources?.[source] === false) continue
      const keyRef = KEYED_SOURCES[source]
      if (keyRef) {
        const ref = s[keyRef]
        if (!ref || !(await this.secret(ref))) continue
      }
      out.add(source)
    }
    return out
  }

  /** Rebuild the merged index; concurrent requests coalesce into one extra pass. */
  private rebuild(store: CatalogStore): Promise<void> {
    if (this.rebuilding) {
      this.rebuildAgain = true
      return this.rebuilding
    }
    this.rebuilding = (async () => {
      do {
        this.rebuildAgain = false
        const signature = this.enabledSignature()
        const enabled = await this.enabledSources()
        const count = await store.rebuild({ enabled, featured: new Set(FEATURED_IDS), signal: this.controller.signal })
        store.setMeta('enabledSig', signature)
        this.ctx.log.debug('catalog', `Catalog index ready: ${count} servers`)
      } while (this.rebuildAgain && !this.closed)
    })().finally(() => {
      this.rebuilding = undefined
    })
    return this.rebuilding
  }

  /** Settings changed (sources switched on/off) → re-merge in the background. */
  private checkSettings(store: CatalogStore): void {
    if (this.rebuilding || store.getMeta<string>('enabledSig') === this.enabledSignature()) return
    this.rebuild(store).catch((err) => {
      if (!isAbort(err)) this.ctx.log.warn('catalog', `Could not update the catalog index: ${errorMessage(err)}`)
    })
  }

  /** Stop background work and close the database. */
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe()
    this.controller.abort()
    await Promise.allSettled([this.refreshing, this.rebuilding, this.readyPromise].filter(Boolean))
    this.store?.close()
    this.store = undefined
  }

  // ── API ──────────────────────────────────────────────────────────────────

  async search(query: CatalogQuery = {}): Promise<CatalogPage> {
    const req = normalizeQuery(query)
    let store: CatalogStore
    try {
      store = await this.ready()
    } catch (err) {
      this.ctx.log.error('catalog', `Catalog unavailable: ${errorMessage(err)}`)
      return emptyPage(req)
    }
    this.checkSettings(store)
    return store.search(req)
  }

  private curatedServer(id: string): CatalogServer | null {
    const entry = this.curatedEntries().find((e) => e.sourceId === id)
    return entry ? mergeGroup([entry], { featured: new Set(FEATURED_IDS) }).server : null
  }

  async get(id: string): Promise<CatalogServer | null> {
    if (typeof id !== 'string' || !id.trim()) return null
    let store: CatalogStore
    try {
      store = await this.ready()
    } catch {
      return this.curatedServer(id)
    }
    this.checkSettings(store)
    const hit = store.get(id.trim())
    if (!hit) return this.curatedServer(id.trim())
    const qn = hit.refs.smithery
    // Servers known to a registry with real install data already have better options than Smithery's.
    if (!qn || !hit.server.sources.every((s) => DISCOVERY_SOURCES.has(s))) return hit.server
    const detail = await this.smitheryDetail(store, qn)
    if (!detail) return hit.server
    const enriched = applySmitheryDetail(hit.server, qn, detail)
    const smitheryOnly = hit.server.sources.every((s) => s === 'smithery')
    store.updateServer(hit.server.id, {
      server: enriched,
      remote: enriched.install.some((o) => o.kind === 'remote'),
      needsKey: serverNeedsKey(enriched.install),
      hidden: smitheryOnly && !detail.installable
    })
    return enriched
  }

  private async smitheryDetail(store: CatalogStore, qualifiedName: string): Promise<SmitheryDetail | undefined> {
    const key = `smithery:${qualifiedName}`
    const cached = store.getDetail(key)
    const fresh = cached && this.now().getTime() - Date.parse(cached.fetchedAt) < DETAIL_TTL_MS
    if (fresh) return cached.data as SmitheryDetail
    const failedAt = this.detailFailures.get(qualifiedName)
    if (failedAt && Date.now() - failedAt < DETAIL_RETRY_MS) return cached?.data as SmitheryDetail | undefined
    try {
      const http = new PoliteHttp({
        concurrency: 2,
        minIntervalMs: 0,
        retries: 1,
        timeoutMs: 15_000,
        ...this.opts.http,
        signal: this.controller.signal
      })
      const apiKey = await this.secret(this.settings().smitheryKeyRef)
      const detail = await fetchSmitheryDetail(qualifiedName, (url, headers) => http.json(url, headers), apiKey)
      store.setDetail(key, detail)
      this.detailFailures.delete(qualifiedName)
      return detail
    } catch (err) {
      if (!isAbort(err)) this.detailFailures.set(qualifiedName, Date.now())
      this.ctx.log.debug('catalog', `Smithery details for ${qualifiedName} unavailable: ${errorMessage(err)}`)
      return cached?.data as SmitheryDetail | undefined
    }
  }

  async categories(): Promise<CategoryInfo[]> {
    try {
      const store = await this.ready()
      this.checkSettings(store)
      return store.categories()
    } catch {
      return []
    }
  }

  async featured(): Promise<CatalogServer[]> {
    let store: CatalogStore | undefined
    try {
      store = await this.ready()
    } catch {
      store = undefined
    }
    const out: CatalogServer[] = []
    for (const id of FEATURED_IDS) {
      const server = store?.get(id)?.server ?? this.curatedServer(id)
      if (server) out.push(server)
    }
    return out
  }

  async stats(): Promise<CatalogStats> {
    let store: CatalogStore | undefined
    try {
      store = await this.ready()
    } catch {
      store = undefined
    }
    const counts = store?.counts() ?? {}
    const enabled = await this.enabledSources()
    const sources: CatalogSourceStatus[] = ALL_SOURCES.map((source) => {
      const st = store?.getMeta<SourceState>(`state:${source}`) ?? {}
      const status: CatalogSourceStatus = { source, enabled: enabled.has(source), count: counts[source] ?? 0 }
      const lastFetched = source === 'seed' ? store?.getMeta<string>('seedLoadedAt') : st.lastFetched
      if (lastFetched) status.lastFetched = lastFetched
      if (st.error) status.error = st.error
      return status
    })
    const stats: CatalogStats = { total: store?.total() ?? 0, sources, refreshing: !!this.refreshing }
    const last = store?.getMeta<string>('lastRefreshed')
    if (last) stats.lastRefreshed = last
    return stats
  }

  refresh(opts: { force?: boolean } = {}): Promise<CatalogStats> {
    if (this.closed) return this.stats()
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(opts.force === true)
        .catch((err) => {
          if (!isAbort(err)) this.ctx.log.error('catalog', `Catalog refresh failed: ${errorMessage(err)}`)
        })
        .then(() => {
          this.refreshing = undefined
          return this.stats()
        })
    }
    return this.refreshing
  }

  // ── refresh ──────────────────────────────────────────────────────────────

  private isStale(store: CatalogStore, adapter: SourceAdapter, now: Date): boolean {
    const st = store.getMeta<SourceState>(`state:${adapter.id}`) ?? {}
    const ttlHours = Math.max(Number(this.settings().catalogTtlHours) || 0, adapter.minTtlHours ?? 0)
    if (st.error && st.lastAttempt && now.getTime() - Date.parse(st.lastAttempt) < ERROR_RETRY_MS) return false
    if (!st.lastFetched) return true
    return now.getTime() - Date.parse(st.lastFetched) >= ttlHours * 3600_000
  }

  private async doRefresh(force: boolean): Promise<void> {
    let store: CatalogStore
    try {
      store = await this.ready()
    } catch (err) {
      const message = `The catalog could not be opened: ${errorMessage(err)}`
      this.emit({ phase: 'error', message })
      return
    }
    const enabled = await this.enabledSources()
    const adapters = (this.opts.sources ?? NETWORK_SOURCES).filter((a) => enabled.has(a.id))
    const now = this.now()
    const due = adapters.filter((a) => force || this.isStale(store, a, now))
    if (!due.length) {
      this.emit({ phase: 'start', message: 'Checking the catalog…' })
      this.emit({ phase: 'done', count: store.total(), message: 'The catalog is up to date.' })
      return
    }
    this.emit({ phase: 'start', message: `Updating ${due.length} catalog source${due.length > 1 ? 's' : ''}…` })
    let failures = 0
    const runAll = async (list: SourceAdapter[]): Promise<boolean> => {
      let changed = false
      await mapLimit(list, 4, async (a) => {
        if (this.closed) return
        const r = await this.runSource(store, a, force)
        if (!r.ok) failures++
        changed ||= r.changed
      })
      return changed
    }
    try {
      if (await runAll(due.filter((a) => !a.heavy))) await this.rebuild(store)
      const heavy = due.filter((a) => a.heavy)
      if (heavy.length && !this.closed && (await runAll(heavy))) await this.rebuild(store)
    } catch (err) {
      if (!isAbort(err)) {
        const message = `Updating the catalog failed: ${errorMessage(err)}`
        this.ctx.log.warn('catalog', message)
        this.emit({ phase: 'error', message })
      }
      return
    }
    if (this.closed) return
    store.setMeta('lastRefreshed', this.now().toISOString())
    const total = store.total()
    this.emit({
      phase: 'done',
      count: total,
      message: failures
        ? `Catalog updated (${failures} source${failures > 1 ? 's' : ''} could not be reached): ${total.toLocaleString('en-US')} servers.`
        : `Catalog updated: ${total.toLocaleString('en-US')} servers.`
    })
  }

  private async runSource(store: CatalogStore, adapter: SourceAdapter, force: boolean): Promise<{ ok: boolean; changed: boolean }> {
    const state = store.getMeta<SourceState>(`state:${adapter.id}`) ?? {}
    const startedAt = this.now().toISOString()
    let writer: SourceWriter | undefined
    let mode: 'replace' | 'delta' | 'keep' | undefined
    const staged = new Set<string>()
    let lastProgress = 0
    const rc: SourceRunContext = {
      http: new PoliteHttp({ ...adapter.http, ...this.opts.http, signal: this.controller.signal }),
      state,
      force,
      signal: this.controller.signal,
      settings: this.settings(),
      now: () => this.now(),
      secret: (ref) => this.secret(ref),
      log: this.ctx.log,
      progress: (count, message) => {
        const t = Date.now()
        if (t - lastProgress < PROGRESS_INTERVAL_MS) return
        lastProgress = t
        this.emit({ phase: 'source', source: adapter.id, count, message })
      },
      begin: (m) => {
        if (mode) throw new Error(`${adapter.label}: begin() called twice`)
        mode = m
        if (m === 'keep') return NOOP_SINK
        const w = store.openSource(adapter.id, m)
        writer = w
        return {
          put: (entries) => {
            for (const e of entries) staged.add(e.sourceId)
            return w.put(entries)
          },
          remove: (ids) => w.remove(ids)
        }
      }
    }
    this.emit({ phase: 'source', source: adapter.id, message: `Updating ${adapter.label}…` })
    try {
      const result = await adapter.run(rc)
      if (mode === 'replace') {
        // Never replace a good list with an empty or truncated one (format change, partial outage…).
        const previous = store.counts()[adapter.id] ?? 0
        if (!staged.size) throw new Error('No servers were returned.')
        if (previous >= 50 && staged.size < previous * 0.2) {
          throw new Error(`Only ${staged.size} servers were returned (previously ${previous}).`)
        }
      }
      if (writer) await writer.commit()
      const finishedAt = this.now().toISOString()
      const next: SourceState = { ...state, ...(result.state ?? {}), lastFetched: finishedAt, lastAttempt: startedAt }
      delete next.error
      store.setMeta(`state:${adapter.id}`, next)
      this.emit({
        phase: 'source',
        source: adapter.id,
        count: store.counts()[adapter.id] ?? 0,
        message: `${adapter.label}: ${result.message ?? 'updated'}`
      })
      return { ok: true, changed: mode !== 'keep' && !!(writer as SourceWriter | undefined)?.changed }
    } catch (err) {
      const partialDelta = mode === 'delta' && !!(writer as SourceWriter | undefined)?.changed
      await (writer as SourceWriter | undefined)?.abort().catch(() => {})
      if (isAbort(err) || this.closed) return { ok: false, changed: false }
      const reason = errorMessage(err).trim().replace(/[.!\s]*$/, '.')
      const message = `${adapter.label} could not be updated: ${reason} The previous data is kept.`
      store.setMeta(`state:${adapter.id}`, { ...state, lastAttempt: startedAt, error: message })
      this.ctx.log.warn('catalog', message)
      this.emit({ phase: 'error', source: adapter.id, message })
      return { ok: false, changed: partialDelta }
    }
  }
}

/** Create the catalog service (use .api for the CatalogApi). */
export function createCatalogService(ctx: CoreContext, opts?: CatalogServiceOptions): CatalogService {
  return new CatalogService(ctx, opts)
}
