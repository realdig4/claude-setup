/** Configure and start the translation proxy for an OpenAI-only provider profile. */
import type { ProxyApi } from '@shared/api'
import type { ModelProfile, ProviderPreset, ProxyConfig, ProxyUpstream } from '@shared/types'
import { PROXY_HINTS } from './providers'
import { MODEL_SLOTS } from './profiles'
import { stripContextSuffix, trimSlashes } from './urls'

export interface ProxySetupResult {
  ok: boolean
  /** Friendly explanation when !ok, or a start warning when ok && !started. */
  message?: string
  /** http://127.0.0.1:<port> for ANTHROPIC_BASE_URL. */
  baseUrl?: string
  /** Local access token for ANTHROPIC_AUTH_TOKEN. */
  token?: string
  started: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The proxy config with this profile's upstream, routes and default/background routes merged in. */
export function proxyConfigForProfile(config: ProxyConfig, profile: ModelProfile, preset: ProviderPreset): ProxyConfig {
  const upstreamId = profile.id
  const models = [...new Set(MODEL_SLOTS.map((s) => stripContextSuffix(profile.models[s] || profile.models.main)).filter(Boolean))]
  const existing = config.upstreams.find((u) => u.id.toLowerCase() === upstreamId.toLowerCase())
  const upstream: ProxyUpstream = {
    ...(PROXY_HINTS[preset.id] ?? {}),
    ...(existing ?? {}),
    id: upstreamId,
    name: profile.name,
    providerId: preset.id,
    baseUrl: trimSlashes(profile.baseUrl),
    models
  }
  if (profile.keyRef) upstream.keyRef = profile.keyRef
  else delete upstream.keyRef

  // Replace this profile's earlier routes (its model choices may have changed); keep everyone else's.
  const routes = Object.fromEntries(Object.entries(config.routes).filter(([, target]) => !target.startsWith(`${upstreamId}/`)))
  for (const model of models) routes[model] = `${upstreamId}/${model}`
  return {
    ...config,
    upstreams: [...config.upstreams.filter((u) => u !== existing), upstream],
    routes,
    defaultRoute: `${upstreamId}/${stripContextSuffix(profile.models.main)}`,
    smallRoute: `${upstreamId}/${stripContextSuffix(profile.models.haiku || profile.models.main)}`,
    autoStart: true
  }
}

/** Save the profile into the proxy config and start the proxy. Never throws. */
export async function setupProxyForProfile(proxy: ProxyApi, profile: ModelProfile, preset: ProviderPreset): Promise<ProxySetupResult> {
  let saved: ProxyConfig
  try {
    const current = await proxy.getConfig()
    saved = await proxy.saveConfig(proxyConfigForProfile(current, profile, preset))
  } catch (err) {
    return { ok: false, started: false, message: `Claude Setup couldn't set up its translation proxy for ${preset.name}: ${errorText(err)}` }
  }
  if (!saved.authToken) return { ok: false, started: false, message: 'The translation proxy has no access token. Open Proxy settings and generate one.' }

  let port = saved.port
  let started = false
  let message: string | undefined
  try {
    const status = await proxy.start()
    started = status.running
    if (status.port) port = status.port
    if (!started) message = status.lastError ? `The translation proxy didn't start: ${status.lastError}` : "The translation proxy didn't start."
  } catch (err) {
    message = `The translation proxy didn't start: ${errorText(err)}`
  }
  return { ok: true, started, message, baseUrl: `http://127.0.0.1:${port}`, token: saved.authToken }
}
