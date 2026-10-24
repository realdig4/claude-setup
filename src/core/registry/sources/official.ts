/**
 * Official MCP Registry (registry.modelcontextprotocol.io, CC0). Full crawl of the latest versions on
 * first run (≈490 pages of 100), then incremental syncs with `updated_since` (deleted entries removed,
 * deprecated ones flagged). A full re-crawl happens every 30 days to correct drift.
 */
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString } from '../util'
import { officialMeta, serverJsonEntry } from './common'
import { paginateCursor, type SourceAdapter, type SourceRunContext, type SourceRunResult } from './source'

export const OFFICIAL_API = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const FULL_RECRAWL_DAYS = 30
/** Overlap subtracted from the last sync time to avoid missing updates at the boundary. */
const SYNC_OVERLAP_MS = 10 * 60 * 1000

export interface OfficialItemResult {
  entry?: SourceEntry
  /** Name of a deleted server (remove it). */
  deleted?: string
  /** Item is not the latest version (ignore). */
  stale?: boolean
}

/** Parse one item of a /v0.1/servers page. */
export function parseOfficialItem(raw: unknown): OfficialItemResult {
  const item = asRecord(raw)
  const server = asRecord(item?.server)
  if (!item || !server) return {}
  const name = asString(server.name)
  if (!name) return {}
  const meta = officialMeta(item)
  if (meta.status === 'deleted') return { deleted: name }
  if (meta.isLatest === false) return { stale: true }
  const entry = serverJsonEntry('official', server, {
    guard: true,
    updatedAt: meta.updatedAt ?? meta.publishedAt,
    deprecated: meta.status === 'deprecated' ? (meta.statusMessage ?? true) : undefined
  })
  return entry ? { entry } : {}
}

/** Parse a whole page: entries + deleted names + next cursor. */
export function parseOfficialPage(raw: unknown): { entries: SourceEntry[]; deleted: string[]; items: number; next?: string } {
  const page = asRecord(raw)
  const items = asArray(page?.servers)
  const entries: SourceEntry[] = []
  const deleted: string[] = []
  for (const it of items) {
    const r = parseOfficialItem(it)
    if (r.entry) entries.push(r.entry)
    else if (r.deleted) deleted.push(r.deleted)
  }
  return { entries, deleted, items: items.length, next: asString(asRecord(page?.metadata)?.nextCursor) }
}

function needsFullCrawl(rc: SourceRunContext): boolean {
  const st = rc.state
  if (!st.lastFullCrawl || !st.syncSince) return true
  const age = rc.now().getTime() - Date.parse(st.lastFullCrawl)
  return !Number.isFinite(age) || age > FULL_RECRAWL_DAYS * 24 * 3600 * 1000
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const startedAt = rc.now().toISOString()
  if (needsFullCrawl(rc)) {
    const sink = rc.begin('replace')
    let count = 0
    const pages = paginateCursor(async (cursor) => {
      const url = `${OFFICIAL_API}?version=latest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = parseOfficialPage(await rc.http.json(url))
      return { items: page.items ? [page] : [], next: page.next }
    })
    for await (const [page] of pages) {
      await sink.put(page.entries)
      count += page.entries.length
      rc.progress(count, `Official registry: ${count.toLocaleString('en-US')} servers so far…`)
    }
    return { state: { lastFullCrawl: startedAt, syncSince: startedAt }, message: `${count.toLocaleString('en-US')} servers` }
  }

  const since = new Date(Date.parse(rc.state.syncSince!) - SYNC_OVERLAP_MS).toISOString()
  const sink = rc.begin('delta')
  let updated = 0
  let removed = 0
  const pages = paginateCursor(async (cursor) => {
    const next = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const url = `${OFFICIAL_API}?updated_since=${encodeURIComponent(since)}&limit=100${next}`
    const page = parseOfficialPage(await rc.http.json(url))
    return { items: page.items ? [page] : [], next: page.next }
  })
  for await (const [page] of pages) {
    if (page.deleted.length) await sink.remove(page.deleted)
    if (page.entries.length) await sink.put(page.entries)
    updated += page.entries.length
    removed += page.deleted.length
    rc.progress(updated, `Official registry: ${updated} updated…`)
  }
  return { state: { syncSince: startedAt }, message: `${updated} updated, ${removed} removed` }
}

export const officialSource: SourceAdapter = {
  id: 'official',
  label: 'Official MCP Registry',
  heavy: true,
  http: { concurrency: 1, minIntervalMs: 120, timeoutMs: 60_000 },
  available: async () => true,
  run
}
