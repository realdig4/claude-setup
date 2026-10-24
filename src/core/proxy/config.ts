/**
 * ProxyConfig validation.
 *  - `validateProxyConfig` (strict, for saveConfig): throws ProxyConfigError with a friendly message.
 *  - `sanitizeProxyConfig` (lenient, for serving): never throws; drops invalid upstreams/routes so a
 *    hand-edited state.json cannot crash the running proxy.
 * Unknown keys are preserved (forward compatibility with newer contract fields).
 */
import { randomBytes } from 'node:crypto'
import type { ProxyConfig, ProxyUpstream } from '@shared/types'
import { parseRouteTarget } from './router'
import { isObject } from './wire'

/** Default port (same as the default state). Avoids CCR 3456/3458, LiteLLM 4000, Ollama 11434, LM Studio 1234. */
export const DEFAULT_PROXY_PORT = 3460
const REASONING_MODES = new Set(['off', 'effort', 'roundtrip', 'both'])
const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Hop-by-hop / framing headers the proxy controls itself. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer'])
const TOKEN = /^[\x21-\x7e]{8,256}$/

/** A configuration problem the user can fix (message is shown as-is). */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyConfigError'
  }
}

/** New random local access token (same format as the default state). */
export function generateProxyToken(): string {
  return `cs-${randomBytes(16).toString('hex')}`
}

/** Whether a token is usable in an HTTP header (printable ASCII, no spaces, 8–256 chars). */
export function isValidProxyToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN.test(token)
}

class Collector {
  constructor(private readonly strict: boolean) {}

  /** Report a problem: throws in strict mode, returns false in lenient mode. */
  fail(message: string): false {
    if (this.strict) throw new ProxyConfigError(message)
    return false
  }
}

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.hash = ''
    return url.toString().replace(/\/+(\?|$)/, '$1')
  } catch {
    return null
  }
}

function normalizeUpstream(raw: unknown, position: number, c: Collector): ProxyUpstream | null {
  if (!isObject(raw)) return c.fail(`Upstream #${position} is not a valid entry.`) || null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  const label = name || `#${position}`
  if (!id || id.length > 64 || /[\s/]/.test(id)) {
    return c.fail(`Upstream ${label} needs an id of 1–64 characters without spaces or "/".`) || null
  }
  const baseUrl = typeof raw.baseUrl === 'string' ? normalizeBaseUrl(raw.baseUrl) : null
  if (!baseUrl) {
    return c.fail(`The base URL of ${label} must start with http:// or https:// (for example https://api.openai.com/v1).`) || null
  }
  const upstream: ProxyUpstream = { ...(raw as Partial<ProxyUpstream>), id, name, baseUrl, models: [] }

  if (raw.models !== undefined && !Array.isArray(raw.models)) c.fail(`The model list of ${label} must be a list of model names.`)
  const models = Array.isArray(raw.models) ? raw.models : []
  upstream.models = [...new Set(models.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean))]

  if (raw.providerId !== undefined && typeof raw.providerId !== 'string') delete upstream.providerId
  if (typeof raw.keyRef === 'string' && raw.keyRef.trim()) upstream.keyRef = raw.keyRef.trim()
  else delete upstream.keyRef

  if (raw.maxOutputTokens === undefined || raw.maxOutputTokens === null) delete upstream.maxOutputTokens
  else if (typeof raw.maxOutputTokens !== 'number' || !Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1) {
    c.fail(`The output token limit of ${label} must be a positive whole number.`)
    delete upstream.maxOutputTokens
  }

  if (raw.reasoning === undefined || raw.reasoning === null) delete upstream.reasoning
  else if (typeof raw.reasoning !== 'string' || !REASONING_MODES.has(raw.reasoning)) {
    c.fail(`The reasoning mode of ${label} must be one of: off, effort, roundtrip, both.`)
    delete upstream.reasoning
  }

  // Proposed contract fields (see translate/request.ts UpstreamExtras); kept when valid.
  const extra = upstream as ProxyUpstream & { maxEffort?: unknown; extraBody?: unknown }
  if (extra.maxEffort === undefined || extra.maxEffort === null) delete extra.maxEffort
  else if (typeof extra.maxEffort !== 'string' || !EFFORT_VALUES.has(extra.maxEffort)) {
    c.fail(`The maximum reasoning effort of ${label} must be one of: ${[...EFFORT_VALUES].join(', ')}.`)
    delete extra.maxEffort
  }
  if (extra.extraBody === undefined || extra.extraBody === null) delete extra.extraBody
  else if (!isObject(extra.extraBody)) {
    c.fail(`The extra request fields of ${label} must be a JSON object.`)
    delete extra.extraBody
  }

  for (const flag of ['useMaxCompletionTokens', 'streamOptions'] as const) {
    if (raw[flag] === undefined || raw[flag] === null) delete upstream[flag]
    else if (typeof raw[flag] !== 'boolean') {
      c.fail(`The "${flag}" setting of ${label} must be true or false.`)
      delete upstream[flag]
    }
  }

  if (raw.extraHeaders === undefined || raw.extraHeaders === null) delete upstream.extraHeaders
  else if (!isObject(raw.extraHeaders)) {
    c.fail(`The extra headers of ${label} must be a list of name/value pairs.`)
    delete upstream.extraHeaders
  } else {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.extraHeaders)) {
      const headerName = key.trim()
      if (!HEADER_NAME.test(headerName) || RESERVED_HEADERS.has(headerName.toLowerCase())) {
        c.fail(`"${key}" cannot be used as an extra header for ${label}.`)
        continue
      }
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
        c.fail(`The value of header "${headerName}" for ${label} must be a single line of text.`)
        continue
      }
      headers[headerName] = value
    }
    upstream.extraHeaders = headers
  }
  return upstream
}

function normalize(input: unknown, strict: boolean): ProxyConfig {
  const c = new Collector(strict)
  if (!isObject(input)) {
    c.fail('The proxy settings are not valid.')
    input = {}
  }
  const raw = input as Record<string, unknown>

  let port = raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    c.fail('The proxy port must be a whole number between 1024 and 65535.')
    port = DEFAULT_PROXY_PORT
  }

  let authToken = typeof raw.authToken === 'string' ? raw.authToken.trim() : ''
  if (!isValidProxyToken(authToken)) {
    c.fail('The proxy access token must be 8–256 characters long, without spaces.')
    if (!strict && typeof raw.authToken !== 'string') authToken = ''
  }

  if (raw.upstreams !== undefined && !Array.isArray(raw.upstreams)) c.fail('The list of upstream providers is not valid.')
  const entries: unknown[] = Array.isArray(raw.upstreams) ? raw.upstreams : []
  const upstreams: ProxyUpstream[] = []
  const seen = new Set<string>()
  entries.forEach((entry, i) => {
    const upstream = normalizeUpstream(entry, i + 1, c)
    if (!upstream) return
    const key = upstream.id.toLowerCase()
    if (seen.has(key)) {
      c.fail(`Two upstreams use the id "${upstream.id}". Each upstream needs its own id.`)
      return
    }
    seen.add(key)
    upstreams.push(upstream)
  })
  const ids = new Set(upstreams.map((u) => u.id))

  const checkTarget = (value: string, what: string): boolean => {
    const target = parseRouteTarget(value)
    if (!target) return c.fail(`${what} must look like "upstream-id/model-name" (got "${value}").`)
    if (!ids.has(target.upstreamId)) return c.fail(`${what} uses the upstream "${target.upstreamId}", which does not exist.`)
    return true
  }

  if (raw.routes !== undefined && !isObject(raw.routes)) c.fail('The model routes are not valid.')
  const routes: Record<string, string> = {}
  for (const [alias, value] of Object.entries(isObject(raw.routes) ? raw.routes : {})) {
    const name = alias.trim()
    if (!name) {
      c.fail('A model route has an empty model name.')
      continue
    }
    if (typeof value !== 'string') {
      c.fail(`The route for "${name}" must be text like "upstream-id/model-name".`)
      continue
    }
    if (checkTarget(value.trim(), `The route for "${name}"`)) routes[name] = value.trim()
  }

  const optionalRoute = (value: unknown, what: string): string | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') return c.fail(`${what} must be text like "upstream-id/model-name".`) || undefined
    const v = value.trim()
    if (!v) return undefined
    return checkTarget(v, what) ? v : undefined
  }
  const defaultRoute = optionalRoute(raw.defaultRoute, 'The default model')
  const smallRoute = optionalRoute(raw.smallRoute, 'The background (haiku) model')

  if (raw.autoStart !== undefined && typeof raw.autoStart !== 'boolean') c.fail('"Start automatically" must be true or false.')

  const config: ProxyConfig = {
    ...(raw as Partial<ProxyConfig>),
    port: port as number,
    authToken,
    upstreams,
    routes,
    autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : true
  }
  if (defaultRoute) config.defaultRoute = defaultRoute
  else delete config.defaultRoute
  if (smallRoute) config.smallRoute = smallRoute
  else delete config.smallRoute
  return config
}

/** Strict validation for saving. Returns a normalized copy; throws ProxyConfigError. */
export function validateProxyConfig(input: unknown): ProxyConfig {
  return normalize(input, true)
}

/** Lenient normalization for serving requests. Never throws. */
export function sanitizeProxyConfig(input: unknown): ProxyConfig {
  return normalize(input, false)
}
