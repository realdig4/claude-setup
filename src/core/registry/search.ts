/** Query parsing shared by both catalog stores (SQLite FTS5 and the in-memory fallback). */
import type { CatalogPage, CatalogQuery, CatalogSource } from '@shared/types'
import { resolveCategory } from './categories'

/** Words ignored in queries (every server is an "MCP server"). */
const STOP_WORDS = new Set([
  'mcp',
  'server',
  'servers',
  'model',
  'context',
  'protocol',
  'the',
  'a',
  'an',
  'for',
  'and',
  'or',
  'of',
  'to',
  'with',
  'in',
  'on',
  'by',
  'my',
  'integration'
])

export const DEFAULT_LIMIT = 30
export const MAX_LIMIT = 100

/** Normalised search request. */
export interface SearchRequest {
  /** Lowercased raw query (trimmed). */
  raw: string
  /** Meaningful terms (stop words removed); empty → browse mode. */
  terms: string[]
  category?: string
  source?: CatalogSource
  remoteOnly: boolean
  noKeyRequired: boolean
  sort: 'relevance' | 'popular' | 'name' | 'updated'
  offset: number
  limit: number
}

/** Split text into lowercase, accent-free word tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Validate and normalise a CatalogQuery. Unknown categories yield an impossible filter. */
export function normalizeQuery(q: CatalogQuery = {}): SearchRequest {
  const raw = (q.query ?? '').trim().toLowerCase()
  const tokens = tokenize(raw)
  const terms = tokens.filter((t) => !STOP_WORDS.has(t))
  const limitIn = Number.isFinite(q.limit) ? Math.floor(q.limit as number) : DEFAULT_LIMIT
  const offsetIn = Number.isFinite(q.offset) ? Math.floor(q.offset as number) : 0
  const sort = q.sort && ['relevance', 'popular', 'name', 'updated'].includes(q.sort) ? q.sort : 'relevance'
  return {
    raw,
    terms,
    category: q.category ? (resolveCategory(q.category) ?? `__unknown__:${q.category}`) : undefined,
    source: q.source,
    remoteOnly: q.remoteOnly === true,
    noKeyRequired: q.noKeyRequired === true,
    sort: !terms.length && sort === 'relevance' ? 'popular' : sort,
    offset: Math.max(0, offsetIn),
    limit: Math.min(MAX_LIMIT, Math.max(1, limitIn))
  }
}

/** FTS5 MATCH expression for the terms (last term as prefix when ≥ 2 chars). */
export function ftsExpression(terms: string[], mode: 'and' | 'or'): string {
  return terms
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`
      return i === terms.length - 1 && t.length >= 2 ? `${quoted}*` : quoted
    })
    .join(mode === 'and' ? ' AND ' : ' OR ')
}

/** Empty page helper. */
export function emptyPage(req: SearchRequest): CatalogPage {
  return { items: [], total: 0, offset: req.offset, limit: req.limit }
}
