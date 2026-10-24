/**
 * SQLite catalog store (node:sqlite, built into Node ≥ 22.5 and Electron). Layout:
 *   entries          one row per (source, generation, sourceId): keys + JSON SourceEntry
 *   source_gen       live generation of every source (replace-mode refreshes stage a new generation)
 *   servers_N/fts_N/aliases_N   merged, searchable index of generation N (rebuilt off to the side, then swapped)
 *   meta, details    small key/value data and lazily fetched Smithery details
 * Long jobs yield to the event loop between chunks so the app stays responsive.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type { CatalogPage, CatalogServer, CatalogSource, CategoryInfo } from '@shared/types'
import { CATEGORIES, categoryLabel } from './categories'
import { derivedSoftKeys, groupEntries, mergeGroup } from './dedupe'
import { emptyPage, ftsExpression, type SearchRequest } from './search'
import { Mutex, type CatalogStore, type RebuildOptions, type SourceWriter, type StoredServer } from './store'
import type { MergedServer, SourceEntry } from './types'
import { abortError, yieldToEventLoop } from './util'

const SCHEMA_VERSION = 2
const CHUNK = 400

type SqliteModule = typeof import('node:sqlite')
let sqliteModule: SqliteModule | undefined

/** Load node:sqlite without letting plain Node print its ExperimentalWarning. */
export async function loadSqlite(): Promise<SqliteModule> {
  if (sqliteModule) return sqliteModule
  const original = process.emitWarning
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning?.message
    const opt = rest[0]
    const type = typeof opt === 'string' ? opt : (opt as { type?: string } | undefined)?.type
    if (/sqlite/i.test(message ?? '') && (type === 'ExperimentalWarning' || /experimental/i.test(message ?? ''))) return
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest)
  }
  process.emitWarning = filtered as typeof process.emitWarning
  try {
    sqliteModule = await import('node:sqlite')
  } finally {
    process.emitWarning = original
  }
  return sqliteModule
}

type Row = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0)
}

/** Entry JSON without the columns stored separately. */
function entryData(e: SourceEntry): string {
  const { keys: _k, softKeys: _s, guardName: _g, ...rest } = e
  return JSON.stringify(rest)
}

function ftsColumns(m: MergedServer): string[] {
  const s = m.server
  const extra = [
    ...s.install.map((o) => o.package ?? '').filter((p) => p && !/^https?:/.test(p)),
    ...s.install.map((o) => (o.url && /^https?:/.test(o.url) ? o.url.replace(/^https?:\/\//, '').split(/[/?#]/)[0] : '')),
    (s.longDescription ?? '').slice(0, 400)
  ]
  return [
    s.name,
    s.slug.replace(/[-_]+/g, ' '),
    s.description,
    s.tags.join(' '),
    s.categories.map((c) => `${c.replace(/-/g, ' ')} ${categoryLabel(c)}`).join(' '),
    [s.publisher ?? '', s.repository?.split('/')[3] ?? ''].join(' '),
    extra.filter(Boolean).join(' ')
  ]
}

class SqliteWriter implements SourceWriter {
  changed = false
  private done = false

  constructor(
    private readonly store: SqliteStore,
    private readonly source: CatalogSource,
    private readonly mode: 'replace' | 'delta',
    private readonly gen: number
  ) {}

  put(entries: SourceEntry[]): Promise<void> {
    if (!entries.length) return Promise.resolve()
    this.changed = true
    return this.store.lock.run(() => this.store.insertEntries(this.source, this.gen, entries))
  }

  remove(sourceIds: string[]): Promise<void> {
    if (!sourceIds.length) return Promise.resolve()
    if (this.mode !== 'delta') return Promise.reject(new Error('remove() is only allowed in delta mode'))
    this.changed = true
    return this.store.lock.run(() => this.store.deleteEntries(this.source, this.gen, sourceIds))
  }

  commit(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    return this.store.lock.run(() => this.store.commitSource(this.source, this.mode, this.gen))
  }

  abort(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    if (this.mode === 'delta') return Promise.resolve()
    return this.store.lock.run(() => this.store.discardGeneration(this.source, this.gen))
  }
}

export class SqliteStore implements CatalogStore {
  readonly kind = 'sqlite' as const
  readonly lock = new Mutex()
  private gen = 0
  private readonly stmtCache = new Map<string, StatementSync>()
  private catCache?: CategoryInfo[]
  private countCache?: Partial<Record<CatalogSource, number>>
  private totalCache?: number

  constructor(private readonly db: DatabaseSync) {
    this.initSchema()
    this.gen = this.getMeta<number>('activeGen') ?? 0
    if (this.gen && !this.tableExists(`servers_${this.gen}`)) this.gen = 0
    this.dropOrphanIndexes()
    // Staged rows of a refresh that never finished (app closed mid-crawl) are not live: drop them.
    this.db.exec('DELETE FROM entries WHERE NOT EXISTS (SELECT 1 FROM source_gen g WHERE g.source = entries.source AND g.gen = entries.gen)')
  }

  // ── schema ────────────────────────────────────────────────────────────────

  private initSchema(): void {
    const version = num(this.db.prepare('PRAGMA user_version').get()?.user_version)
    if (version !== SCHEMA_VERSION) {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      for (const t of tables) {
        const name = str(t.name)
        if (/^fts_\d+_(data|idx|docsize|config|content)$/.test(name)) continue
        this.db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`)
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source_gen (source TEXT PRIMARY KEY, gen INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS entries (
        source TEXT NOT NULL,
        gen INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        guard TEXT,
        keys TEXT NOT NULL,
        soft TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (source, gen, source_id)
      );
      CREATE TABLE IF NOT EXISTS details (key TEXT PRIMARY KEY, fetched TEXT NOT NULL, data TEXT NOT NULL) WITHOUT ROWID;
    `)
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  }

  private dropOrphanIndexes(): void {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    for (const r of rows) {
      const m = /^(servers|docs|fts|aliases)_(\d+)$/.exec(str(r.name))
      if (m && Number(m[2]) !== this.gen) this.db.exec(`DROP TABLE IF EXISTS ${m[0]}`)
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      throw err
    }
  }

  // ── meta / details ───────────────────────────────────────────────────────

  getMeta<T>(key: string): T | undefined {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key)
    if (!row) return undefined
    try {
      return JSON.parse(str(row.value)) as T
    } catch {
      return undefined
    }
  }

  setMeta(key: string, value: unknown): void {
    if (value === undefined) this.stmt('DELETE FROM meta WHERE key = ?').run(key)
    else {
      this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    }
  }

  getDetail(key: string): { fetchedAt: string; data: unknown } | undefined {
    const row = this.stmt('SELECT fetched, data FROM details WHERE key = ?').get(key)
    if (!row) return undefined
    try {
      return { fetchedAt: str(row.fetched), data: JSON.parse(str(row.data)) }
    } catch {
      return undefined
    }
  }

  setDetail(key: string, data: unknown): void {
    this.stmt(
      'INSERT INTO details (key, fetched, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched = excluded.fetched, data = excluded.data'
    ).run(
      key,
      new Date().toISOString(),
      JSON.stringify(data)
    )
  }

  // ── entries ──────────────────────────────────────────────────────────────

  private liveGen(source: CatalogSource): number | undefined {
    const row = this.stmt('SELECT gen FROM source_gen WHERE source = ?').get(source)
    return row ? num(row.gen) : undefined
  }

  openSource(source: CatalogSource, mode: 'replace' | 'delta'): SourceWriter {
    if (mode === 'delta') {
      let gen = this.liveGen(source)
      if (gen === undefined) {
        gen = 1
        this.stmt('INSERT INTO source_gen (source, gen) VALUES (?, ?)').run(source, gen)
      }
      return new SqliteWriter(this, source, mode, gen)
    }
    const row = this.stmt('SELECT MAX(gen) AS g FROM entries WHERE source = ?').get(source)
    const gen = Math.max(num(row?.g), this.liveGen(source) ?? 0) + 1
    return new SqliteWriter(this, source, mode, gen)
  }

  /** @internal */
  async insertEntries(source: CatalogSource, gen: number, entries: SourceEntry[]): Promise<void> {
    const ins = this.stmt('INSERT OR REPLACE INTO entries (source, gen, source_id, guard, keys, soft, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let i = 0; i < entries.length; i += 1000) {
      const slice = entries.slice(i, i + 1000)
      this.tx(() => {
        for (const e of slice) {
          const soft = [...new Set([...(e.softKeys ?? []), ...derivedSoftKeys(e)])]
          ins.run(source, gen, e.sourceId, e.guardName ?? null, JSON.stringify(e.keys), JSON.stringify(soft), entryData(e))
        }
      })
      if (i + 1000 < entries.length) await yieldToEventLoop()
    }
    this.countCache = undefined
  }

  /** @internal */
  async deleteEntries(source: CatalogSource, gen: number, sourceIds: string[]): Promise<void> {
    const del = this.stmt('DELETE FROM entries WHERE source = ? AND gen = ? AND source_id = ?')
    this.tx(() => {
      for (const id of sourceIds) del.run(source, gen, id)
    })
    this.countCache = undefined
  }

  /** @internal */
  async commitSource(source: CatalogSource, mode: 'replace' | 'delta', gen: number): Promise<void> {
    if (mode === 'replace') {
      this.tx(() => {
        this.stmt('DELETE FROM entries WHERE source = ? AND gen <> ?').run(source, gen)
        this.stmt('INSERT INTO source_gen (source, gen) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET gen = excluded.gen').run(source, gen)
      })
    }
    this.countCache = undefined
  }

  /** @internal */
  async discardGeneration(source: CatalogSource, gen: number): Promise<void> {
    if (this.liveGen(source) === gen) return
    this.stmt('DELETE FROM entries WHERE source = ? AND gen = ?').run(source, gen)
    this.countCache = undefined
  }

  counts(): Partial<Record<CatalogSource, number>> {
    if (!this.countCache) {
      const rows = this.stmt(
        'SELECT e.source AS source, COUNT(*) AS n FROM entries e JOIN source_gen g ON g.source = e.source AND g.gen = e.gen GROUP BY e.source'
      ).all()
      const out: Partial<Record<CatalogSource, number>> = {}
      for (const r of rows) out[str(r.source) as CatalogSource] = num(r.n)
      this.countCache = out
    }
    return this.countCache
  }

  // ── rebuild ──────────────────────────────────────────────────────────────

  rebuild(opts: RebuildOptions): Promise<number> {
    return this.lock.run(() => this.rebuildInner(opts))
  }

  private dropIndexTables(n: number): void {
    for (const t of ['servers', 'docs', 'fts', 'aliases']) this.db.exec(`DROP TABLE IF EXISTS ${t}_${n}`)
  }

  private async rebuildInner(opts: RebuildOptions): Promise<number> {
    const next = Math.max(this.gen, this.getMeta<number>('maxGen') ?? 0) + 1
    this.setMeta('maxGen', next)
    const S = `servers_${next}`
    const D = `docs_${next}`
    const F = `fts_${next}`
    const A = `aliases_${next}`
    this.dropIndexTables(next)
    // Narrow table for filtering / sorting (fast scans); the JSON documents live in docs_N.
    this.db.exec(`
      CREATE TABLE ${S} (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        lname TEXT NOT NULL,
        slug TEXT NOT NULL,
        popularity REAL NOT NULL,
        verified INTEGER NOT NULL,
        official INTEGER NOT NULL,
        remote INTEGER NOT NULL,
        needs_key INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        cats TEXT NOT NULL,
        srcs TEXT NOT NULL,
        updated TEXT
      );
      CREATE TABLE ${D} (rowid INTEGER PRIMARY KEY, refs TEXT NOT NULL, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE ${F} USING fts5(name, slug, description, tags, categories, publisher, extra,
        content = '', tokenize = 'porter unicode61 remove_diacritics 2', prefix = '2 3');
      CREATE TABLE ${A} (alias TEXT PRIMARY KEY, id TEXT NOT NULL) WITHOUT ROWID;
    `)
    try {
      const enabled = [...opts.enabled]
      const rows = enabled.length
        ? this.db
            .prepare(
              `SELECT e.rowid AS rid, e.source AS source, e.guard AS guard, e.keys AS keys, e.soft AS soft FROM entries e
               JOIN source_gen g ON g.source = e.source AND g.gen = e.gen
               WHERE e.source IN (${enabled.map(() => '?').join(',')})`
            )
            .all(...enabled)
        : []
      const rowids = new Float64Array(rows.length)
      const inputs = rows.map((r, i) => {
        rowids[i] = num(r.rid)
        return {
          source: str(r.source),
          guardName: r.guard ? str(r.guard) : undefined,
          keys: JSON.parse(str(r.keys)) as string[],
          softKeys: JSON.parse(str(r.soft)) as string[]
        }
      })
      await yieldToEventLoop()
      const groups = groupEntries(inputs)
      const order = Array.from({ length: rows.length }, (_, i) => i).sort((a, b) => groups[a] - groups[b])
      const insServer = this.db.prepare(
        `INSERT INTO ${S} (rowid, id, lname, slug, popularity, verified, official, remote, needs_key, hidden, cats, srcs, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      const insDoc = this.db.prepare(`INSERT INTO ${D} (rowid, refs, data) VALUES (?, ?, ?)`)
      const insFts = this.db.prepare(
        `INSERT INTO ${F} (rowid, name, slug, description, tags, categories, publisher, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insAlias = this.db.prepare(`INSERT OR IGNORE INTO ${A} (alias, id) VALUES (?, ?)`)
      const usedIds = new Set<string>()
      let rowNum = 0
      for (let i = 0; i < order.length; ) {
        if (opts.signal?.aborted) throw abortError()
        let j = Math.min(order.length, i + CHUNK)
        while (j < order.length && groups[order[j]] === groups[order[j - 1]]) j++
        const ids = order.slice(i, j).map((k) => rowids[k])
        const data = new Map<number, Row>()
        for (let p = 0; p < ids.length; p += 500) {
          const part = ids.slice(p, p + 500)
          const sql = `SELECT rowid AS rid, data FROM entries WHERE rowid IN (${part.map(() => '?').join(',')})`
          const got = this.db.prepare(sql).all(...part)
          for (const g of got) data.set(num(g.rid), g)
        }
        this.tx(() => {
          let k = i
          while (k < j) {
            const grp = groups[order[k]]
            const members: SourceEntry[] = []
            while (k < j && groups[order[k]] === grp) {
              const idx = order[k]
              const row = data.get(rowids[idx])
              if (row) {
                const parsed = JSON.parse(str(row.data)) as SourceEntry
                parsed.keys = inputs[idx].keys
                parsed.softKeys = inputs[idx].softKeys
                if (inputs[idx].guardName) parsed.guardName = inputs[idx].guardName
                members.push(parsed)
              }
              k++
            }
            if (!members.length) continue
            const merged = mergeGroup(members, { featured: opts.featured })
            let id = merged.server.id
            if (usedIds.has(id)) {
              let n = 2
              while (usedIds.has(`${id}#${n}`)) n++
              merged.aliases.push(id)
              id = `${id}#${n}`
              merged.server.id = id
            }
            usedIds.add(id)
            rowNum++
            const s = merged.server
            insServer.run(
              rowNum,
              id,
              s.name.toLowerCase(),
              s.slug,
              s.popularity ?? 0,
              s.verified ? 1 : 0,
              s.official ? 1 : 0,
              merged.remote ? 1 : 0,
              merged.needsKey ? 1 : 0,
              ` ${s.categories.join(' ')} `,
              ` ${s.sources.join(' ')} `,
              s.updatedAt ?? null
            )
            insDoc.run(rowNum, JSON.stringify(merged.refs), JSON.stringify(s))
            insFts.run(rowNum, ...ftsColumns(merged))
            for (const alias of merged.aliases) insAlias.run(alias, id)
          }
        })
        i = j
        await yieldToEventLoop()
      }
      this.db.exec(`
        CREATE INDEX ${S}_pop ON ${S} (popularity DESC);
        CREATE INDEX ${S}_name ON ${S} (lname);
        CREATE INDEX ${S}_updated ON ${S} (updated);
        CREATE INDEX ${S}_id_nocase ON ${S} (id COLLATE NOCASE);
      `)
      const old = this.gen
      this.tx(() => {
        this.setMeta('activeGen', next)
        if (old) this.dropIndexTables(old)
      })
      this.gen = next
      this.stmtCache.clear()
      this.catCache = undefined
      this.totalCache = undefined
      return rowNum
    } catch (err) {
      this.dropIndexTables(next)
      throw err
    }
  }

  hasIndex(): boolean {
    return this.gen > 0
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private filters(req: SearchRequest): { sql: string; params: SQLInputValue[] } {
    const parts = ['s.hidden = 0']
    const params: SQLInputValue[] = []
    if (req.category) {
      parts.push('s.cats LIKE ?')
      params.push(`% ${req.category} %`)
    }
    if (req.source) {
      parts.push('s.srcs LIKE ?')
      params.push(`% ${req.source} %`)
    }
    if (req.remoteOnly) parts.push('s.remote = 1')
    if (req.noKeyRequired) parts.push('s.needs_key = 0')
    return { sql: parts.join(' AND '), params }
  }

  private order(req: SearchRequest, withRank: boolean): string {
    switch (req.sort) {
      case 'name':
        return 's.lname ASC, s.popularity DESC'
      case 'updated':
        return 's.updated IS NULL ASC, s.updated DESC, s.popularity DESC'
      case 'popular':
        return 's.popularity DESC, s.lname ASC'
      default:
        return withRank ? 'score DESC, s.popularity DESC' : 's.popularity DESC, s.lname ASC'
    }
  }

  /** Load the JSON documents of a page, keeping the rowid order. */
  private docs(rowids: number[]): CatalogServer[] {
    if (!rowids.length) return []
    const sql = `SELECT rowid AS rid, data FROM docs_${this.gen} WHERE rowid IN (${rowids.map(() => '?').join(',')})`
    const rows = this.db.prepare(sql).all(...rowids)
    const byId = new Map(rows.map((r) => [num(r.rid), str(r.data)]))
    return rowids
      .map((id) => byId.get(id))
      .filter((d): d is string => !!d)
      .map((d) => JSON.parse(d) as CatalogServer)
  }

  search(req: SearchRequest): CatalogPage {
    if (!this.gen) return emptyPage(req)
    const S = `servers_${this.gen}`
    const F = `fts_${this.gen}`
    const f = this.filters(req)
    if (!req.terms.length) {
      const unfiltered = f.params.length === 0 && !req.remoteOnly && !req.noKeyRequired
      const total = unfiltered ? this.total() : num(this.stmt(`SELECT COUNT(*) AS n FROM ${S} s WHERE ${f.sql}`).get(...f.params)?.n)
      const ids = this.stmt(`SELECT s.rowid AS rid FROM ${S} s WHERE ${f.sql} ORDER BY ${this.order(req, false)} LIMIT ? OFFSET ?`)
        .all(...f.params, req.limit, req.offset)
        .map((r) => num(r.rid))
      return { items: this.docs(ids), total, offset: req.offset, limit: req.limit }
    }
    const phrase = req.terms.join(' ')
    const prefix = `${phrase.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    for (const mode of ['and', 'or'] as const) {
      if (mode === 'or' && req.terms.length < 2) break
      const match = ftsExpression(req.terms, mode)
      const countSql = `SELECT COUNT(*) AS n FROM ${F} f JOIN ${S} s ON s.rowid = f.rowid WHERE ${F} MATCH ? AND ${f.sql}`
      const total = num(this.stmt(countSql).get(match, ...f.params)?.n)
      if (!total) continue
      // Relevance blended with popularity: popular / curated servers win close calls; exact names get a bonus.
      const ids = this.stmt(
        `SELECT s.rowid AS rid,
           (-bm25(${F}, 10.0, 6.0, 3.0, 2.0, 1.5, 3.0, 1.0)) * (1.0 + s.popularity / 20.0)
           + (CASE WHEN s.lname = ? OR s.slug = ? THEN 25.0 WHEN s.lname LIKE ? ESCAPE '\\' THEN 8.0 ELSE 0.0 END) * (1.0 + s.popularity / 50.0)
           + s.verified * 2.0 + s.official * 2.0 AS score
         FROM ${F} f JOIN ${S} s ON s.rowid = f.rowid
         WHERE ${F} MATCH ? AND ${f.sql}
         ORDER BY ${this.order(req, true)} LIMIT ? OFFSET ?`
      )
        .all(phrase, phrase.replace(/\s+/g, '-'), prefix, match, ...f.params, req.limit, req.offset)
        .map((r) => num(r.rid))
      return { items: this.docs(ids), total, offset: req.offset, limit: req.limit }
    }
    return emptyPage(req)
  }

  get(id: string): StoredServer | null {
    if (!this.gen || !id) return null
    const S = `servers_${this.gen}`
    const sel = `SELECT s.rowid AS rid, s.remote AS remote, s.needs_key AS needs_key, s.hidden AS hidden, d.refs AS refs, d.data AS data
      FROM ${S} s JOIN docs_${this.gen} d ON d.rowid = s.rowid`
    let row = this.stmt(`${sel} WHERE s.id = ?`).get(id)
    if (!row) {
      const alias = this.stmt(`SELECT id FROM aliases_${this.gen} WHERE alias = ?`).get(id)
      if (alias) row = this.stmt(`${sel} WHERE s.id = ?`).get(str(alias.id))
    }
    if (!row) row = this.stmt(`${sel} WHERE s.id = ? COLLATE NOCASE`).get(id)
    if (!row) return null
    return {
      server: JSON.parse(str(row.data)) as CatalogServer,
      refs: JSON.parse(str(row.refs) || '{}') as StoredServer['refs'],
      remote: num(row.remote) === 1,
      needsKey: num(row.needs_key) === 1,
      hidden: num(row.hidden) === 1
    }
  }

  updateServer(id: string, value: Omit<StoredServer, 'refs'>): void {
    if (!this.gen) return
    const row = this.stmt(`SELECT rowid AS rid FROM servers_${this.gen} WHERE id = ?`).get(id)
    if (!row) return
    const rid = num(row.rid)
    this.tx(() => {
      this.stmt(`UPDATE servers_${this.gen} SET remote = ?, needs_key = ?, hidden = ? WHERE rowid = ?`).run(
        value.remote ? 1 : 0,
        value.needsKey ? 1 : 0,
        value.hidden ? 1 : 0,
        rid
      )
      this.stmt(`UPDATE docs_${this.gen} SET data = ? WHERE rowid = ?`).run(JSON.stringify(value.server), rid)
    })
    this.catCache = undefined
    this.totalCache = undefined
  }

  categories(): CategoryInfo[] {
    if (!this.gen) return []
    if (!this.catCache) {
      const counts = new Map<string, number>()
      for (const r of this.stmt(`SELECT cats FROM servers_${this.gen} WHERE hidden = 0`).all()) {
        for (const c of str(r.cats).trim().split(' ')) if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
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
    if (!this.gen) return 0
    this.totalCache ??= num(this.stmt(`SELECT COUNT(*) AS n FROM servers_${this.gen} WHERE hidden = 0`).get()?.n)
    return this.totalCache
  }

  close(): void {
    this.stmtCache.clear()
    try {
      if (this.db.isOpen) this.db.close()
    } catch {
      // already closed
    }
  }
}

/** Open (or create) cacheDir/catalog.db. A corrupt database file is deleted and recreated once. */
export async function openSqliteStore(cacheDir: string): Promise<SqliteStore> {
  const { DatabaseSync } = await loadSqlite()
  await mkdir(cacheDir, { recursive: true })
  const file = join(cacheDir, 'catalog.db')
  const open = () => {
    const db = new DatabaseSync(file, { timeout: 5000 })
    try {
      return new SqliteStore(db)
    } catch (err) {
      try {
        db.close()
      } catch {
        // ignore
      }
      throw err
    }
  }
  try {
    return open()
  } catch {
    await Promise.all(['', '-wal', '-shm'].map((s) => rm(file + s, { force: true }).catch(() => {})))
    return open()
  }
}
