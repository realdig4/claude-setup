/**
 * Fallback catalog store used when node:sqlite is unavailable: everything lives in memory and is
 * persisted to cacheDir/catalog-cache.json (entries + merged index + meta), so the next start is instant.
 * Search is a token scan with the same ranking ideas as the SQLite store.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogPage, CatalogSource, CategoryInfo } from '@shared/types'
import type { Logger } from '../context'
import { CATEGORIES, categoryLabel } from './categories'
import { derivedSoftKeys, groupEntries, mergeGroup } from './dedupe'
import { emptyPage, tokenize, type SearchRequest } from './search'
import { Mutex, type CatalogStore, type RebuildOptions, type SourceWriter, type StoredServer } from './store'
import type { SourceEntry } from './types'
import { abortError, errorMessage, yieldToEventLoop } from './util'

const FILE_VERSION = 1

interface PersistedFile {
  version: number
  entries: Partial<Record<CatalogSource, SourceEntry[]>>
  servers?: Array<StoredServer & { aliases: string[] }>
  meta: Record<string, unknown>
  details: Record<string, { fetchedAt: string; data: unknown }>
}

/** Pre-tokenised searchable fields (weights match the SQLite bm25 weights). */
interface IndexedServer {
  stored: StoredServer
  lname: string
  fields: Array<{ words: string[]; weight: number }>
}

const WEIGHTS = { name: 10, slug: 6, description: 3, tags: 2, categories: 1.5, publisher: 3, extra: 1 }

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

function words(text: string): string[] {
  return tokenize(text).map(stem)
}

function indexServer(stored: StoredServer): IndexedServer {
  const s = stored.server
  return {
    stored,
    lname: s.name.toLowerCase(),
    fields: [
      { words: words(s.name), weight: WEIGHTS.name },
      { words: words(s.slug), weight: WEIGHTS.slug },
      { words: words(s.description), weight: WEIGHTS.description },
      { words: words(s.tags.join(' ')), weight: WEIGHTS.tags },
      { words: words(s.categories.map((c) => `${c} ${categoryLabel(c)}`).join(' ')), weight: WEIGHTS.categories },
      { words: words(`${s.publisher ?? ''} ${s.repository?.split('/')[3] ?? ''}`), weight: WEIGHTS.publisher },
      { words: words([...s.install.map((o) => o.package ?? ''), (s.longDescription ?? '').slice(0, 400)].join(' ')), weight: WEIGHTS.extra }
    ]
  }
}

class MemoryWriter implements SourceWriter {
  changed = false
  private done = false
  private readonly staged = new Map<string, SourceEntry>()

  constructor(
    private readonly store: MemoryStore,
    private readonly source: CatalogSource,
    private readonly mode: 'replace' | 'delta'
  ) {}

  put(entries: SourceEntry[]): Promise<void> {
    if (!entries.length) return Promise.resolve()
    this.changed = true
    return this.store.lock.run(() => {
      const target = this.mode === 'replace' ? this.staged : this.store.live(this.source)
      for (const e of entries) target.set(e.sourceId, e)
      if (this.mode === 'delta') this.store.dirty()
    })
  }

  remove(sourceIds: string[]): Promise<void> {
    if (!sourceIds.length) return Promise.resolve()
    if (this.mode !== 'delta') return Promise.reject(new Error('remove() is only allowed in delta mode'))
    this.changed = true
    return this.store.lock.run(() => {
      const live = this.store.live(this.source)
      for (const id of sourceIds) live.delete(id)
      this.store.dirty()
    })
  }

  commit(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    return this.store.lock.run(() => {
      if (this.mode === 'replace') this.store.replaceLive(this.source, this.staged)
      this.store.dirty()
    })
  }

  abort(): Promise<void> {
    this.done = true
    this.staged.clear()
    return Promise.resolve()
  }
}

export class MemoryStore implements CatalogStore {
  readonly kind = 'memory' as const
  readonly lock = new Mutex()
  private readonly entries = new Map<CatalogSource, Map<string, SourceEntry>>()
  private servers: IndexedServer[] = []
  private byId = new Map<string, IndexedServer>()
  private aliases = new Map<string, string>()
  private indexed = false
  private meta: Record<string, unknown> = {}
  private details: Record<string, { fetchedAt: string; data: unknown }> = {}
  private catCache?: CategoryInfo[]
  private saveTimer?: NodeJS.Timeout
  private readonly file: string

  constructor(
    private readonly cacheDir: string,
    private readonly log: Logger
  ) {
    this.file = join(cacheDir, 'catalog-cache.json')
    this.load()
  }

  private load(): void {
    let parsed: PersistedFile
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedFile
    } catch {
      return
    }
    if (parsed?.version !== FILE_VERSION) return
    for (const [source, list] of Object.entries(parsed.entries ?? {})) {
      this.entries.set(source as CatalogSource, new Map((list ?? []).map((e) => [e.sourceId, e])))
    }
    this.meta = parsed.meta ?? {}
    this.details = parsed.details ?? {}
    if (parsed.servers) {
      this.setIndex(parsed.servers.map(({ aliases, ...stored }) => ({ stored, aliases })))
    }
  }

  private setIndex(list: Array<{ stored: StoredServer; aliases: string[] }>): void {
    this.servers = list.map((x) => indexServer(x.stored))
    this.byId = new Map(this.servers.map((s) => [s.stored.server.id, s]))
    this.aliases = new Map()
    for (const x of list) for (const a of x.aliases) if (!this.aliases.has(a)) this.aliases.set(a, x.stored.server.id)
    this.indexed = true
    this.catCache = undefined
  }

  /** @internal live entries of a source (created on demand). */
  live(source: CatalogSource): Map<string, SourceEntry> {
    let m = this.entries.get(source)
    if (!m) this.entries.set(source, (m = new Map()))
    return m
  }

  /** @internal */
  replaceLive(source: CatalogSource, staged: Map<string, SourceEntry>): void {
    this.entries.set(source, new Map(staged))
  }

  /** @internal schedule a save. */
  dirty(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 2000)
    this.saveTimer.unref?.()
  }

  private save(): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const byTarget = new Map<string, string[]>()
      for (const [alias, id] of this.aliases) {
        let list = byTarget.get(id)
        if (!list) byTarget.set(id, (list = []))
        list.push(alias)
      }
      const data: PersistedFile = {
        version: FILE_VERSION,
        entries: Object.fromEntries([...this.entries].map(([k, v]) => [k, [...v.values()]])),
        servers: this.indexed ? this.servers.map((s) => ({ ...s.stored, aliases: byTarget.get(s.stored.server.id) ?? [] })) : undefined,
        meta: this.meta,
        details: this.details
      }
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, this.file)
    } catch (err) {
      this.log.warn('catalog', `Could not save the catalog cache: ${errorMessage(err)}`)
    }
  }

  counts(): Partial<Record<CatalogSource, number>> {
    const out: Partial<Record<CatalogSource, number>> = {}
    for (const [source, m] of this.entries) if (m.size) out[source] = m.size
    return out
  }

  openSource(source: CatalogSource, mode: 'replace' | 'delta'): SourceWriter {
    return new MemoryWriter(this, source, mode)
  }

  rebuild(opts: RebuildOptions): Promise<number> {
    return this.lock.run(async () => {
      const all: SourceEntry[] = []
      for (const [source, m] of this.entries) if (opts.enabled.has(source)) all.push(...m.values())
      const groups = groupEntries(
        all.map((e) => ({ source: e.source, guardName: e.guardName, keys: e.keys, softKeys: [...(e.softKeys ?? []), ...derivedSoftKeys(e)] }))
      )
      const buckets = new Map<number, SourceEntry[]>()
      all.forEach((e, i) => {
        let list = buckets.get(groups[i])
        if (!list) buckets.set(groups[i], (list = []))
        list.push(e)
      })
      const out: Array<{ stored: StoredServer; aliases: string[] }> = []
      const used = new Set<string>()
      let n = 0
      for (const members of buckets.values()) {
        if (opts.signal?.aborted) throw abortError()
        const merged = mergeGroup(members, { featured: opts.featured })
        let id = merged.server.id
        if (used.has(id)) {
          let k = 2
          while (used.has(`${id}#${k}`)) k++
          merged.aliases.push(id)
          id = `${id}#${k}`
          merged.server.id = id
        }
        used.add(id)
        const stored: StoredServer = { server: merged.server, refs: merged.refs, remote: merged.remote, needsKey: merged.needsKey, hidden: false }
        out.push({ stored, aliases: merged.aliases })
        if (++n % 2000 === 0) await yieldToEventLoop()
      }
      this.setIndex(out)
      this.dirty()
      return out.length
    })
  }

  hasIndex(): boolean {
    return this.indexed
  }

  private matches(s: IndexedServer, req: SearchRequest): boolean {
    const st = s.stored
    if (st.hidden) return false
    if (req.category && !st.server.categories.includes(req.category)) return false
    if (req.source && !st.server.sources.includes(req.source)) return false
    if (req.remoteOnly && !st.remote) return false
    if (req.noKeyRequired && st.needsKey) return false
    return true
  }

  private termScore(s: IndexedServer, term: string, prefix: boolean): number {
    let best = 0
    for (const f of s.fields) {
      for (const w of f.words) {
        const q = w === term ? 1 : prefix && w.startsWith(term) ? 0.7 : 0
        if (q * f.weight > best) best = q * f.weight
      }
    }
    return best
  }

  private sortList(list: Array<{ s: IndexedServer; score: number }>, req: SearchRequest): void {
    const byName = (a: IndexedServer, b: IndexedServer) => a.lname.localeCompare(b.lname)
    const pop = (x: IndexedServer) => x.stored.server.popularity ?? 0
    list.sort((a, b) => {
      switch (req.sort) {
        case 'name':
          return byName(a.s, b.s) || pop(b.s) - pop(a.s)
        case 'updated': {
          const ua = a.s.stored.server.updatedAt ?? ''
          const ub = b.s.stored.server.updatedAt ?? ''
          if (!ua !== !ub) return ua ? -1 : 1
          return ub.localeCompare(ua) || pop(b.s) - pop(a.s)
        }
        case 'popular':
          return pop(b.s) - pop(a.s) || byName(a.s, b.s)
        default:
          return b.score - a.score || pop(b.s) - pop(a.s)
      }
    })
  }

  search(req: SearchRequest): CatalogPage {
    if (!this.indexed) return emptyPage(req)
    const candidates = this.servers.filter((s) => this.matches(s, req))
    let scored: Array<{ s: IndexedServer; score: number }>
    if (!req.terms.length) {
      scored = candidates.map((s) => ({ s, score: 0 }))
    } else {
      const terms = req.terms.map(stem)
      const phrase = req.terms.join(' ')
      const slugPhrase = req.terms.join('-')
      const score = (s: IndexedServer, mode: 'and' | 'or'): number => {
        let total = 0
        let hits = 0
        terms.forEach((t, i) => {
          const v = this.termScore(s, t, i === terms.length - 1 && t.length >= 2)
          if (v > 0) hits++
          total += v
        })
        if (mode === 'and' ? hits < terms.length : hits === 0) return 0
        const st = s.stored.server
        const pop = st.popularity ?? 0
        const bonus = s.lname === phrase || st.slug === slugPhrase ? 25 : s.lname.startsWith(phrase) ? 8 : 0
        return total * (1 + pop / 20) + bonus * (1 + pop / 50) + (st.verified ? 2 : 0) + (st.official ? 2 : 0)
      }
      scored = candidates.map((s) => ({ s, score: score(s, 'and') })).filter((x) => x.score > 0)
      if (!scored.length && terms.length > 1) scored = candidates.map((s) => ({ s, score: score(s, 'or') })).filter((x) => x.score > 0)
    }
    this.sortList(scored, req)
    return {
      items: scored.slice(req.offset, req.offset + req.limit).map((x) => x.s.stored.server),
      total: scored.length,
      offset: req.offset,
      limit: req.limit
    }
  }

  get(id: string): StoredServer | null {
    if (!id) return null
    const hit = this.byId.get(id) ?? this.byId.get(this.aliases.get(id) ?? '')
    if (hit) return hit.stored
    const lower = id.toLowerCase()
    for (const s of this.servers) if (s.stored.server.id.toLowerCase() === lower) return s.stored
    return null
  }

  updateServer(id: string, value: Omit<StoredServer, 'refs'>): void {
    const hit = this.byId.get(id)
    if (!hit) return
    const updated = indexServer({ ...value, refs: hit.stored.refs })
    const i = this.servers.indexOf(hit)
    if (i >= 0) this.servers[i] = updated
    this.byId.set(id, updated)
    this.catCache = undefined
    this.dirty()
  }

  categories(): CategoryInfo[] {
    if (!this.catCache) {
      const counts = new Map<string, number>()
      for (const s of this.servers) {
        if (s.stored.hidden) continue
        for (const c of s.stored.server.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
      }
      this.catCache = CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => ({
        id: c.id,
        label: c.label,
        count: counts.get(c.id) ?? 0
      }))
    }
    return this.catCache
  }

  total(): number {
    return this.servers.filter((s) => !s.stored.hidden).length
  }

  getMeta<T>(key: string): T | undefined {
    return this.meta[key] as T | undefined
  }

  setMeta(key: string, value: unknown): void {
    if (value === undefined) delete this.meta[key]
    else this.meta[key] = value
    this.dirty()
  }

  getDetail(key: string): { fetchedAt: string; data: unknown } | undefined {
    return this.details[key]
  }

  setDetail(key: string, data: unknown): void {
    this.details[key] = { fetchedAt: new Date().toISOString(), data }
    this.dirty()
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      this.save()
    }
  }
}

/** Create the memory store (loads cacheDir/catalog-cache.json when present). */
export function openMemoryStore(cacheDir: string, log: Logger): MemoryStore {
  return new MemoryStore(cacheDir, log)
}
