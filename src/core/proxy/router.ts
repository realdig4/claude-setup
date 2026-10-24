/**
 * Model routing: which upstream (and which upstream model) serves a requested model name.
 *
 * Order (the requested name is trimmed and a trailing "[1m]" removed):
 *   1. `routes[name]` (exact, then case-insensitive)          → "upstreamId/model"
 *   2. an explicit "upstreamId/model" name for an existing upstream (e.g. `/model openai/gpt-5.1`)
 *   3. a model listed by exactly that name in an upstream's `models`
 *   4. names containing "haiku" (background tasks) → `smallRoute`
 *   5. `defaultRoute`
 * The requested name is echoed back to Claude Code unchanged.
 */
import type { ProxyConfig, ProxyUpstream } from '@shared/types'

/** A parsed "upstreamId/model" route value. */
export interface RouteTarget {
  upstreamId: string
  model: string
}

/** Which rule picked the upstream (for logs and tests). */
export type RouteVia = 'route' | 'explicit' | 'model' | 'small' | 'default'

/** The upstream and model that serve a request, or a friendly explanation. */
export type RouteResolution =
  | { ok: true; upstream: ProxyUpstream; model: string; via: RouteVia; requested: string }
  | { ok: false; message: string }

/** Parse "upstreamId/model" (the model part may itself contain "/"). */
export function parseRouteTarget(value: unknown): RouteTarget | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  const slash = v.indexOf('/')
  if (slash <= 0 || slash === v.length - 1) return null
  const upstreamId = v.slice(0, slash).trim()
  const model = v.slice(slash + 1).trim()
  return upstreamId && model ? { upstreamId, model } : null
}

/** Requested model without the "[1m]" context suffix Claude Code may append. */
export function normalizeModelName(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').trim()
}

/** Resolve a requested model name to an upstream + upstream model. */
export function resolveRoute(config: ProxyConfig, requestedModel: string): RouteResolution {
  const requested = normalizeModelName(requestedModel)
  const byId = new Map(config.upstreams.map((u) => [u.id, u]))
  const fromTarget = (value: string, via: RouteVia): RouteResolution => {
    const target = parseRouteTarget(value)
    const upstream = target ? byId.get(target.upstreamId) : undefined
    if (!target || !upstream) {
      const message = `The proxy route "${value}" points to an upstream that does not exist. Fix it in Claude Setup → Proxy.`
      return { ok: false, message }
    }
    return { ok: true, upstream, model: target.model, via, requested }
  }

  if (requested) {
    if (Object.prototype.hasOwnProperty.call(config.routes, requested)) return fromTarget(config.routes[requested], 'route')
    const lower = requested.toLowerCase()
    const alias = Object.keys(config.routes).find((key) => key.toLowerCase() === lower)
    if (alias) return fromTarget(config.routes[alias], 'route')

    const explicit = parseRouteTarget(requested)
    const explicitUpstream = explicit ? byId.get(explicit.upstreamId) : undefined
    if (explicit && explicitUpstream) {
      return { ok: true, upstream: explicitUpstream, model: explicit.model, via: 'explicit', requested }
    }

    const listing = config.upstreams.find((u) => u.models.includes(requested))
    if (listing) return { ok: true, upstream: listing, model: requested, via: 'model', requested }

    if (lower.includes('haiku') && config.smallRoute) return fromTarget(config.smallRoute, 'small')
  }
  if (config.defaultRoute) return fromTarget(config.defaultRoute, 'default')
  return {
    ok: false,
    message: requested
      ? `No proxy route is set up for the model "${requested}". Open Claude Setup → Proxy and choose a default model.`
      : 'No default model is set up for the proxy. Open Claude Setup → Proxy and choose one.'
  }
}

/** One entry of GET /v1/models. */
export interface RoutedModel {
  /** Name a client can request. */
  id: string
  displayName: string
  upstreamId: string
  model: string
}

/** Every model name the proxy can serve: route aliases first, then "upstreamId/model" for each upstream model. */
export function listRoutedModels(config: ProxyConfig): RoutedModel[] {
  const byId = new Map(config.upstreams.map((u) => [u.id, u]))
  const out: RoutedModel[] = []
  const seen = new Set<string>()
  for (const [alias, value] of Object.entries(config.routes)) {
    const target = parseRouteTarget(value)
    const upstream = target ? byId.get(target.upstreamId) : undefined
    if (!target || !upstream || seen.has(alias)) continue
    seen.add(alias)
    const displayName = `${alias} (${upstream.name || upstream.id}: ${target.model})`
    out.push({ id: alias, displayName, upstreamId: upstream.id, model: target.model })
  }
  for (const upstream of config.upstreams) {
    for (const model of upstream.models) {
      const id = `${upstream.id}/${model}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, displayName: `${model} (${upstream.name || upstream.id})`, upstreamId: upstream.id, model })
    }
  }
  return out
}
