/**
 * Human-friendly formatting helpers (numbers, dates, sizes, durations, plurals).
 * Pure functions — safe to use anywhere, including tests.
 */

const LOCALE = 'en-US'

const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const decimalFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
const compactFormat = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 })
const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

/** 1234 → "1,234". Non-finite values render as "—". */
export function formatNumber(value: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (opts.decimals !== undefined) {
    return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: opts.decimals, minimumFractionDigits: 0 }).format(value)
  }
  return Number.isInteger(value) ? integerFormat.format(value) : decimalFormat.format(value)
}

/** 950 → "950", 12_345 → "12.3K", 1_200_000 → "1.2M". */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return compactFormat.format(value)
}

/** Context windows: 262144 → "256K", 1_000_000 → "1M", 1048576 → "1M". */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '—'
  const binary = tokens % 1024 === 0
  const base = binary ? 1024 : 1000
  if (tokens >= base * base) return `${trimZero(tokens / (base * base))}M`
  if (tokens >= base) return `${trimZero(tokens / base)}K`
  return String(tokens)
}

/** 0 → "0 B", 1536 → "1.5 KB", 5_242_880 → "5 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${trimZero(value)} ${units[unit]}`
}

/** 85 → "85 ms", 1250 → "1.3 s", 125_000 → "2m 5s", 7_500_000 → "2h 5m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${trimZero(seconds)} s`
  const totalSeconds = Math.round(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    const s = totalSeconds % 60
    return s ? `${minutes}m ${s}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${hours}h ${m}m` : `${hours}h`
}

type DateInput = Date | string | number

function toDate(input: DateInput): Date | null {
  const date = input instanceof Date ? input : new Date(input)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", "Mar 4", "Mar 4, 2024".
 * Future dates read "in 5 min", "tomorrow", …
 */
export function formatRelativeTime(input: DateInput | null | undefined, now: DateInput = Date.now()): string {
  if (input === null || input === undefined) return 'never'
  const date = toDate(input)
  const ref = toDate(now)
  if (!date || !ref) return 'unknown'
  const diffSec = (date.getTime() - ref.getTime()) / 1000
  const abs = Math.abs(diffSec)
  if (abs < 45) return 'just now'
  if (abs < 60 * 60) {
    const minutes = Math.max(1, Math.round(abs / 60))
    return diffSec < 0 ? `${minutes} min ago` : `in ${minutes} min`
  }
  if (abs < 60 * 60 * 24) return relativeFormat.format(Math.round(diffSec / 3600), 'hour')
  const days = Math.round(diffSec / 86400)
  if (Math.abs(days) < 7) return relativeFormat.format(days, 'day')
  const sameYear = date.getFullYear() === ref.getFullYear()
  return date.toLocaleDateString(LOCALE, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Oct 23, 2026, 9:41 PM" (or date only with { time: false }). */
export function formatDateTime(input: DateInput | null | undefined, opts: { time?: boolean } = {}): string {
  if (input === null || input === undefined) return '—'
  const date = toDate(input)
  if (!date) return '—'
  return date.toLocaleString(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(opts.time === false ? {} : { hour: 'numeric', minute: '2-digit' })
  })
}

/**
 * pluralize(1, 'server') → "1 server", pluralize(3, 'server') → "3 servers",
 * pluralize(2, 'entry', 'entries') → "2 entries", pluralize(5, 'app', undefined, false) → "apps".
 */
export function pluralize(count: number, singular: string, plural?: string, includeCount = true): string {
  const word = count === 1 ? singular : (plural ?? defaultPlural(singular))
  return includeCount ? `${formatNumber(count)} ${word}` : word
}

function defaultPlural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

/** Join a list for prose: ["a"] → "a", ["a","b"] → "a and b", ["a","b","c"] → "a, b and c". */
export function joinList(items: readonly string[], conjunction = 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`
}

/** Shorten long paths/ids in the middle: "C:\Users\me\…\claude_desktop_config.json". */
export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text
  if (max < 5) return text.slice(0, max)
  const keep = max - 1
  const head = Math.ceil(keep * 0.45)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** "ghp_1234567890abcd" → "ghp_••••abcd" — for showing that a secret exists without revealing it. */
export function maskSecret(secret: string, visible = 4): string {
  if (!secret) return ''
  if (secret.length <= visible * 2) return '•'.repeat(Math.max(4, secret.length))
  const prefix = /^[a-z]{2,6}[_-]/i.exec(secret)?.[0] ?? ''
  return `${prefix}••••${secret.slice(-visible)}`
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
