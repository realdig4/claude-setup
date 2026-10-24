/** Small text / collection helpers shared by the registry parsers. Pure functions, no I/O. */

/** Words that carry no meaning in a server name ("Brave Search MCP Server" → "Brave Search"). */
const NAME_NOISE = new Set(['mcp', 'server', 'servers', 'srv'])

/** Brand / acronym casing used when we have to build a display name from a package or repo slug. */
const CASING: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  apis: 'APIs',
  aws: 'AWS',
  gcp: 'GCP',
  sql: 'SQL',
  pdf: 'PDF',
  ui: 'UI',
  url: 'URL',
  json: 'JSON',
  yaml: 'YAML',
  csv: 'CSV',
  html: 'HTML',
  css: 'CSS',
  http: 'HTTP',
  sdk: 'SDK',
  cli: 'CLI',
  db: 'DB',
  llm: 'LLM',
  llms: 'LLMs',
  rag: 'RAG',
  seo: 'SEO',
  crm: 'CRM',
  erp: 'ERP',
  ocr: 'OCR',
  tts: 'TTS',
  rss: 'RSS',
  ios: 'iOS',
  macos: 'macOS',
  k8s: 'K8s',
  npm: 'npm',
  mcp: 'MCP',
  github: 'GitHub',
  gitlab: 'GitLab',
  openai: 'OpenAI',
  openapi: 'OpenAPI',
  graphql: 'GraphQL',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  whatsapp: 'WhatsApp',
  chatgpt: 'ChatGPT',
  hubspot: 'HubSpot',
  paypal: 'PayPal',
  postgresql: 'PostgreSQL',
  postgres: 'Postgres',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  devtools: 'DevTools',
  devops: 'DevOps',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  bigquery: 'BigQuery',
  clickhouse: 'ClickHouse',
  dynamodb: 'DynamoDB',
  elasticsearch: 'Elasticsearch',
  vscode: 'VS Code',
  jira: 'Jira',
  figma: 'Figma',
  x: 'X'
}

/** Collapse whitespace and trim. Returns '' for non-strings. */
export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Turn a markdown snippet into plain text: drops images, badges, HTML tags and code fences,
 * keeps link labels.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Shorten to `max` characters on a word boundary, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.4 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…'
}

/** Plain, single-line description limited to `max` characters. */
export function plainDescription(value: unknown, max = 300): string {
  const text = cleanText(typeof value === 'string' ? stripMarkdown(value) : '')
  return truncate(text, max)
}

/** First meaningful paragraph of a README as plain text (badges, headings and code removed). */
export function readmeExcerpt(readme: unknown, max = 500): string | undefined {
  if (typeof readme !== 'string' || !readme.trim()) return undefined
  const paragraphs = readme
    .replace(/```[\s\S]*?```/g, '\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^(\[!\[|!\[|<img|<p\s+align|<div|<a\s|\||-{3,}|>\s*\[!)/i.test(p))
  for (const p of paragraphs) {
    const text = cleanText(stripMarkdown(p))
    if (text.length >= 40) return truncate(text, max)
  }
  return undefined
}

/** Lowercase dashed identifier limited to [a-z0-9-]. */
export function kebab(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Suggested config key for a server ([A-Za-z0-9_-], ≤ 64 chars, lowercase with dashes).
 * Noise words such as "mcp" and "server" are dropped unless nothing else remains.
 */
export function slugify(name: string, fallback = 'server'): string {
  const tokens = kebab(name).split('-').filter(Boolean)
  let useful = tokens.filter((t) => !NAME_NOISE.has(t))
  while (useful.length > 1 && (useful[0] === 'the' || useful[0] === 'for' || useful[0] === 'a')) useful = useful.slice(1)
  const chosen = useful.length ? useful : tokens
  let slug = chosen.join('-').slice(0, 64).replace(/-+$/, '')
  if (!slug) slug = kebab(fallback).slice(0, 64) || 'server'
  return slug
}

/** Title-case a slug-like word using known brand casing. */
function titleWord(word: string): string {
  const lower = word.toLowerCase()
  if (CASING[lower]) return CASING[lower]
  if (/^v?\d/.test(word)) return word
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Friendly display name from a package / repo / registry slug:
 * "brave-search-mcp-server" → "Brave Search", "@upstash/context7-mcp" → "Context7".
 */
export function prettifyName(raw: string): string {
  const last = raw.split('/').filter(Boolean).pop() ?? raw
  const base = last.replace(/^@/, '').replace(/\.(git|py|js|ts)$/i, '')
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean)
  const useful = words.filter((w) => !NAME_NOISE.has(w.toLowerCase()))
  const chosen = useful.length ? useful : words
  const name = chosen.map(titleWord).join(' ').trim()
  return name || raw
}

/** True for http(s) URLs. */
export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value)
}

/** Heuristic: URL that very likely points at an image (icons from some sources are web pages). */
export function isImageUrl(value: unknown): value is string {
  if (!isHttpUrl(value)) return false
  if (/\.(png|jpe?g|gif|svg|webp|ico|avif)(\?|#|$)/i.test(value)) return true
  return /(avatars\.githubusercontent\.com|\/icon|\/logo|favicon|\/thumbnail|googleusercontent\.com|gravatar|\/avatar)/i.test(value)
}

/** De-duplicate while keeping the first occurrence order. */
export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)]
}

/** Finite non-negative number or undefined. */
export function toCount(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** ISO timestamp or undefined (accepts Date-parsable strings). */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** Latest of several ISO dates. */
export function latestDate(...dates: Array<string | undefined>): string | undefined {
  let best: string | undefined
  let bestT = -Infinity
  for (const d of dates) {
    if (!d) continue
    const t = Date.parse(d)
    if (Number.isFinite(t) && t > bestT) {
      bestT = t
      best = d
    }
  }
  return best
}

/** log-scaled 0..100: value `max` (or more) maps to 100. */
export function logScale(value: number | undefined, max: number): number {
  if (!value || value <= 0) return 0
  return Math.min(100, (Math.log10(value + 1) / Math.log10(max + 1)) * 100)
}

/** Narrow unknown → plain object. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Narrow unknown → array (empty when not an array). */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Non-empty trimmed string or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Compare two version strings loosely (semver-ish, tolerates "v" prefixes, dates and pre-releases).
 * Returns >0 when a is newer than b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/i, '').split(/[-+]/, 2)
    return { parts: main.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : NaN)), pre: pre ?? '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0
    const y = pb.parts[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const c = String(pa.parts[i] ?? '').localeCompare(String(pb.parts[i] ?? ''))
      if (c) return c
      continue
    }
    if (x !== y) return x - y
  }
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true })
}

/** Yield to the event loop (keeps the Electron main process responsive during long jobs). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Promise that resolves after `ms`, rejecting early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Standard AbortError instance. */
export function abortError(): Error {
  const err = new Error('The operation was cancelled')
  err.name = 'AbortError'
  return err
}

/** Error message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
