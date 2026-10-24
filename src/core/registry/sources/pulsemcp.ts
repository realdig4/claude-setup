/**
 * PulseMCP sub-registry (optional; partner API key + tenant id). Same API shape as the official
 * registry plus visitor estimates used for popularity.
 *
 * The secret stored under settings.pulsemcpKeyRef may be "<tenantId>:<apiKey>" or JSON
 * {"tenantId": "...", "apiKey": "..."}; a separate secret "<ref>:tenant" can hold the tenant id.
 */
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString, toCount } from '../util'
import { officialMeta, serverJsonEntry } from './common'
import { paginateCursor, type SourceAdapter, type SourceRunContext, type SourceRunResult } from './source'

export const PULSEMCP_API = 'https://api.pulsemcp.com/v0.1/servers'

export interface PulseCredentials {
  apiKey: string
  tenantId?: string
}

/** Decode the stored PulseMCP secret. */
export function parsePulseSecret(secret: string | null, tenantSecret?: string | null): PulseCredentials | null {
  const s = secret?.trim()
  if (!s) return null
  if (s.startsWith('{')) {
    try {
      const o = asRecord(JSON.parse(s))
      const apiKey = asString(o?.apiKey ?? o?.key)
      if (apiKey) return { apiKey, tenantId: asString(o?.tenantId ?? o?.tenant) ?? tenantSecret?.trim() ?? undefined }
    } catch {
      return null
    }
    return null
  }
  const i = s.indexOf(':')
  if (i > 0 && !tenantSecret) return { tenantId: s.slice(0, i).trim(), apiKey: s.slice(i + 1).trim() }
  return { apiKey: s, tenantId: tenantSecret?.trim() || undefined }
}

/** Parse one list item. */
export function parsePulseItem(raw: unknown): SourceEntry | undefined {
  const item = asRecord(raw)
  const server = asRecord(item?.server)
  if (!item || !server) return undefined
  const meta = asRecord(item._meta) ?? {}
  const pulse = asRecord(meta['com.pulsemcp/server']) ?? {}
  const version = asRecord(meta['com.pulsemcp/server-version']) ?? {}
  const status = asString(version.status) ?? officialMeta(item).status
  if (status === 'deleted' || version.isLatest === false) return undefined
  const visitors = toCount(pulse.visitorsEstimateLastFourWeeks) ?? toCount(pulse.visitorsEstimateMostRecentWeek)
  return serverJsonEntry('pulsemcp', server, {
    guard: true,
    official: pulse.isOfficial === true ? true : undefined,
    metrics: visitors ? { visitors } : undefined,
    updatedAt: asString(version.updatedAt) ?? officialMeta(item).updatedAt,
    deprecated: status === 'deprecated' ? true : undefined
  })
}

/** Parse a list page. */
export function parsePulsePage(raw: unknown): { entries: SourceEntry[]; items: number; next?: string } {
  const page = asRecord(raw)
  const items = asArray(page?.servers)
  return {
    entries: items.map(parsePulseItem).filter((e): e is SourceEntry => !!e),
    items: items.length,
    next: asString(asRecord(page?.metadata)?.nextCursor)
  }
}

async function credentials(rc: Pick<SourceRunContext, 'settings' | 'secret'>): Promise<PulseCredentials | null> {
  const ref = rc.settings.pulsemcpKeyRef
  if (!ref) return null
  return parsePulseSecret(await rc.secret(ref), await rc.secret(`${ref}:tenant`))
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const creds = await credentials(rc)
  if (!creds) throw new Error('Add your PulseMCP API key in Settings to use this source.')
  if (!creds.tenantId) throw new Error('PulseMCP needs a tenant id: save the key as "<tenant id>:<api key>".')
  const headers = { 'x-api-key': creds.apiKey, 'x-tenant-id': creds.tenantId }
  const sink = rc.begin('replace')
  let count = 0
  const pages = paginateCursor(async (cursor) => {
    const url = `${PULSEMCP_API}?version=latest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page = parsePulsePage(await rc.http.json(url, headers))
    return { items: page.items ? [page] : [], next: page.next }
  })
  for await (const [page] of pages) {
    await sink.put(page.entries)
    count += page.entries.length
    rc.progress(count, `PulseMCP: ${count.toLocaleString('en-US')} servers…`)
  }
  if (!count) throw new Error('PulseMCP returned no servers.')
  return { message: `${count.toLocaleString('en-US')} servers` }
}

export const pulsemcpSource: SourceAdapter = {
  id: 'pulsemcp',
  label: 'PulseMCP',
  heavy: true,
  minTtlHours: 24 * 7,
  // 200 requests per minute allowed.
  http: { concurrency: 1, minIntervalMs: 350, timeoutMs: 60_000 },
  available: async (rc) => !!(await credentials(rc)),
  run
}
