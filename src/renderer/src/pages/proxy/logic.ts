/**
 * Pure helpers for the Proxy page: an editable draft of ProxyConfig (routes as rows), validation that mirrors the
 * core's saveConfig rules, upstream presets and log formatting. No React or DOM (unit-tested in Node).
 */
import type { ProviderPreset, ProxyConfig, ProxyLogEntry, ProxyUpstream } from '@shared/types'

export interface RouteRow {
  id: string
  alias: string
  target: string
}

export interface ProxyDraft {
  port: string
  authToken: string
  upstreams: ProxyUpstream[]
  routes: RouteRow[]
  /** '' = none. */
  defaultRoute: string
  /** '' = same as the default route. */
  smallRoute: string
  autoStart: boolean
}

let sequence = 0
/** A new route row with a unique id. */
export function newRouteRow(alias = '', target = ''): RouteRow {
  sequence += 1
  return { id: `route-${sequence}`, alias, target }
}

/** Editable draft from a saved config. */
export function draftFromConfig(config: ProxyConfig): ProxyDraft {
  return {
    port: String(config.port),
    authToken: config.authToken,
    upstreams: structuredClone(config.upstreams),
    routes: Object.entries(config.routes).map(([alias, target]) => newRouteRow(alias, target)),
    defaultRoute: config.defaultRoute ?? '',
    smallRoute: config.smallRoute ?? '',
    autoStart: config.autoStart
  }
}

/** The config to save: the draft applied on top of the saved config (unknown keys are kept). */
export function configFromDraft(draft: ProxyDraft, base: ProxyConfig): ProxyConfig {
  const routes: Record<string, string> = {}
  for (const row of draft.routes) {
    const alias = row.alias.trim()
    if (alias) routes[alias] = row.target.trim()
  }
  const config: ProxyConfig = {
    ...base,
    port: Number(draft.port.trim()),
    authToken: draft.authToken.trim(),
    upstreams: draft.upstreams,
    routes,
    autoStart: draft.autoStart
  }
  if (draft.defaultRoute.trim()) config.defaultRoute = draft.defaultRoute.trim()
  else delete config.defaultRoute
  if (draft.smallRoute.trim()) config.smallRoute = draft.smallRoute.trim()
  else delete config.smallRoute
  return config
}

/** Stable comparison of a draft against the saved config ("unsaved changes"). */
export function isDraftDirty(draft: ProxyDraft, saved: ProxyConfig): boolean {
  return JSON.stringify(configFromDraft(draft, saved)) !== JSON.stringify(configFromDraft(draftFromConfig(saved), saved))
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (mirrors src/core/proxy/config.ts)
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = /^[\x21-\x7e]{8,256}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer'
])

/** "upstream-id/model" → parts (the model may contain more slashes). */
export function parseRouteTarget(value: string): { upstreamId: string; model: string } | null {
  const v = value.trim()
  const slash = v.indexOf('/')
  if (slash <= 0 || slash === v.length - 1) return null
  const upstreamId = v.slice(0, slash).trim()
  const model = v.slice(slash + 1).trim()
  return upstreamId && model ? { upstreamId, model } : null
}

export function portError(text: string): string | undefined {
  const value = text.trim()
  if (!/^\d+$/.test(value)) return 'Use a whole number between 1024 and 65535.'
  const port = Number(value)
  if (port < 1024 || port > 65535) return 'Use a whole number between 1024 and 65535.'
  return undefined
}

export function tokenError(token: string): string | undefined {
  return TOKEN.test(token.trim()) ? undefined : 'Use 8–256 characters without spaces.'
}

export function headerError(name: string, value: string): string | undefined {
  if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return `“${name}” can’t be used as a header name.`
  if (/[\r\n\0]/.test(value)) return 'The value must be a single line.'
  return undefined
}

export function upstreamIdError(id: string): string | undefined {
  const value = id.trim()
  if (!value || value.length > 64 || /[\s/]/.test(value)) return 'Use 1–64 characters without spaces or “/”.'
  return undefined
}

export function baseUrlError(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return undefined
  } catch {
    // fall through
  }
  return 'Enter a full address starting with http:// or https://, for example https://api.openai.com/v1.'
}

export function maxTokensError(text: string): string | undefined {
  const value = text.trim()
  if (!value) return undefined
  return /^\d+$/.test(value) && Number(value) >= 1 ? undefined : 'Use a positive whole number, or leave it empty.'
}

/** Parse the "extra request fields" JSON: { value } (undefined when empty) or { error } when it isn't a JSON object. */
export function parseExtraBody(text: string): { value?: Record<string, unknown>; error?: string } {
  const value = text.trim()
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed as Record<string, unknown> }
  } catch {
    return { error: 'This isn’t valid JSON. Check quotes and commas.' }
  }
  return { error: 'Use a JSON object, like {"temperature": 0.2}.' }
}

/** Models from a textarea: one per line or comma-separated, trimmed and de-duplicated. */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean))]
}

export interface DraftIssues {
  port?: string
  authToken?: string
  /** Messages per upstream index. */
  upstreams: Record<number, string>
  /** Messages per route row id. */
  routes: Record<string, string>
  defaultRoute?: string
  smallRoute?: string
}

function targetError(value: string, ids: Set<string>, what: string): string | undefined {
  const target = parseRouteTarget(value)
  if (!target) return `${what} must look like “upstream/model”.`
  if (!ids.has(target.upstreamId)) return `${what} uses “${target.upstreamId}”, which isn’t in your upstreams.`
  return undefined
}

/** Every problem in the draft (an empty `upstreams` / `routes` and no other keys = valid). */
export function draftIssues(draft: ProxyDraft): DraftIssues {
  const issues: DraftIssues = { upstreams: {}, routes: {} }
  const port = portError(draft.port)
  if (port) issues.port = port
  const token = tokenError(draft.authToken)
  if (token) issues.authToken = token

  const seen = new Set<string>()
  draft.upstreams.forEach((u, i) => {
    const problem = upstreamIdError(u.id) ?? baseUrlError(u.baseUrl)
    if (problem) issues.upstreams[i] = `${u.name || u.id || `Upstream ${i + 1}`}: ${problem}`
    else if (seen.has(u.id.toLowerCase())) issues.upstreams[i] = `Two upstreams use the id “${u.id}”.`
    seen.add(u.id.toLowerCase())
  })

  const ids = new Set(draft.upstreams.map((u) => u.id))
  const aliases = new Set<string>()
  for (const row of draft.routes) {
    const alias = row.alias.trim()
    if (!alias && !row.target.trim()) continue
    if (!alias) issues.routes[row.id] = 'Type the model name Claude Code asks for.'
    else if (aliases.has(alias)) issues.routes[row.id] = `“${alias}” is listed twice.`
    else {
      const problem = targetError(row.target, ids, 'The destination')
      if (problem) issues.routes[row.id] = problem
    }
    aliases.add(alias)
  }
  if (draft.defaultRoute.trim()) {
    const problem = targetError(draft.defaultRoute, ids, 'The default route')
    if (problem) issues.defaultRoute = problem
  }
  if (draft.smallRoute.trim()) {
    const problem = targetError(draft.smallRoute, ids, 'The background route')
    if (problem) issues.smallRoute = problem
  }
  return issues
}

/** Count of problems in DraftIssues. */
export function issueCount(issues: DraftIssues): number {
  return (
    (issues.port ? 1 : 0) +
    (issues.authToken ? 1 : 0) +
    Object.keys(issues.upstreams).length +
    Object.keys(issues.routes).length +
    (issues.defaultRoute ? 1 : 0) +
    (issues.smallRoute ? 1 : 0)
  )
}

/** Rename an upstream id everywhere it is referenced. */
export function renameUpstream(draft: ProxyDraft, from: string, to: string): ProxyDraft {
  if (from === to) return draft
  const swap = (target: string): string =>
    parseRouteTarget(target)?.upstreamId === from ? `${to}/${target.slice(target.indexOf('/') + 1)}` : target
  return {
    ...draft,
    routes: draft.routes.map((r) => ({ ...r, target: swap(r.target) })),
    defaultRoute: swap(draft.defaultRoute),
    smallRoute: swap(draft.smallRoute)
  }
}

/** Remove an upstream and every route that points to it. */
export function removeUpstream(draft: ProxyDraft, id: string): ProxyDraft {
  const uses = (target: string): boolean => parseRouteTarget(target)?.upstreamId === id
  return {
    ...draft,
    upstreams: draft.upstreams.filter((u) => u.id !== id),
    routes: draft.routes.filter((r) => !uses(r.target)),
    defaultRoute: uses(draft.defaultRoute) ? '' : draft.defaultRoute,
    smallRoute: uses(draft.smallRoute) ? '' : draft.smallRoute
  }
}

/** How many routes (incl. default/background) point to an upstream. */
export function routesUsing(draft: ProxyDraft, id: string): number {
  const uses = (target: string): boolean => parseRouteTarget(target)?.upstreamId === id
  return draft.routes.filter((r) => uses(r.target)).length + (uses(draft.defaultRoute) ? 1 : 0) + (uses(draft.smallRoute) ? 1 : 0)
}

/** "upstream/model" choices for route selects (labels name the upstream when there are several). */
export function routeChoices(upstreams: readonly ProxyUpstream[]): Array<{ value: string; label: string; group: string }> {
  const several = upstreams.length > 1
  return upstreams.flatMap((u) =>
    u.models.map((m) => ({ value: `${u.id}/${m}`, label: several ? `${u.name || u.id}: ${m}` : m, group: u.name || u.id }))
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream presets
// ─────────────────────────────────────────────────────────────────────────────

/** Known-good translation settings per OpenAI-style provider (same values the core uses for model setups). */
export const UPSTREAM_HINTS: Record<string, Partial<ProxyUpstream>> = {
  openai: { useMaxCompletionTokens: true, reasoning: 'effort', streamOptions: true, maxOutputTokens: 128000 },
  gemini: { reasoning: 'effort', streamOptions: true, maxOutputTokens: 65536 },
  groq: { reasoning: 'off', streamOptions: true, maxOutputTokens: 32768 },
  cerebras: { reasoning: 'off', streamOptions: true, maxOutputTokens: 32768 },
  'openai-compatible': { reasoning: 'off' }
}

/** A lower-case id from a name ("Groq Cloud" → "groq-cloud"), unique among `taken`. */
export function slugId(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'upstream'
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  if (!lower.has(base)) return base
  for (let i = 2; i < 1000; i++) if (!lower.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now()}`
}

/** A new upstream pre-filled from an OpenAI-style provider preset. */
export function upstreamFromPreset(preset: ProviderPreset, taken: readonly string[]): ProxyUpstream {
  const id = slugId(preset.id, taken)
  return {
    ...(UPSTREAM_HINTS[preset.id] ?? {}),
    id,
    name: preset.name,
    providerId: preset.id,
    baseUrl: preset.regions[0]?.baseUrl ?? '',
    models: [...new Set(preset.models.map((m) => m.id.replace(/\[1m\]$/i, '')))]
  }
}

/** Secret reference for an upstream's key (keeps an existing one, e.g. a model setup's). */
export function upstreamKeyRef(upstream: Pick<ProxyUpstream, 'id' | 'keyRef'>): string {
  return upstream.keyRef || `proxy:${upstream.id}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────────────────────────────────────

/** "21:41:07" in local time. */
export function logTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export type LogFilter = 'all' | 'warn' | 'error'

/** Entries matching a level filter ("warn" includes errors). */
export function filterLogs(entries: readonly ProxyLogEntry[], filter: LogFilter): ProxyLogEntry[] {
  if (filter === 'all') return [...entries]
  if (filter === 'warn') return entries.filter((e) => e.level !== 'info')
  return entries.filter((e) => e.level === 'error')
}

/** Badge tone for an HTTP status. */
export function statusTone(status: number | undefined): 'success' | 'warn' | 'danger' | 'neutral' {
  if (!status) return 'neutral'
  if (status < 300) return 'success'
  if (status === 429 || status < 500) return 'warn'
  return 'danger'
}

/** Common Claude Code model names, offered as route suggestions. */
export const CLAUDE_ALIASES: readonly string[] = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
