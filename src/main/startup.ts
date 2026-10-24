/**
 * Background tasks run once the GUI is up: auto-start the translation proxy when the active
 * model profile needs it, and re-point stale self registrations. No Electron imports (testable).
 */
import type { AppState, ModelProfile, ModelStatus, ProviderPreset, ProxyStatus } from '@shared/types'
import type { Core } from '@core/index'
import { refreshStaleRegistrations } from '@core/self/sync'

/**
 * The proxy should start automatically when auto-start is on and the profile Claude Code is
 * using (or the remembered active profile) belongs to an OpenAI-only provider.
 */
export function shouldAutostartProxy(input: {
  state: Pick<AppState, 'activeProfileId' | 'proxy'>
  status: ModelStatus | null
  profiles: ModelProfile[]
  providers: ProviderPreset[]
  proxy: ProxyStatus | null
}): boolean {
  const { state, status, profiles, providers, proxy } = input
  if (!state.proxy?.autoStart) return false
  if (proxy?.running) return false
  if (status && status.mode !== 'custom') return false
  const profileId = status?.profileId ?? state.activeProfileId
  if (!profileId) return false
  const profile = profiles.find((p) => p.id === profileId)
  if (!profile) return false
  return providers.find((p) => p.id === profile.providerId)?.kind === 'openai-proxy'
}

async function settle<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

/** Start the proxy if the active model profile needs it. Returns true when it was started. */
export async function autostartProxy(core: Core): Promise<boolean> {
  const [status, profiles, providers, proxy] = await Promise.all([
    settle(core.models.status()),
    settle(core.models.profiles()),
    settle(core.models.providers()),
    settle(core.proxy.status())
  ])
  const start = shouldAutostartProxy({ state: core.ctx.state.get(), status, profiles: profiles ?? [], providers: providers ?? [], proxy })
  if (!start) return false
  try {
    const st = await core.proxy.start()
    if (st.running) core.ctx.log.info('gui', `Model proxy started automatically on port ${st.port ?? '?'}`)
    else core.ctx.log.warn('gui', `Model proxy did not start: ${st.lastError ?? 'unknown reason'}`)
    return st.running
  } catch (err) {
    core.ctx.log.warn('gui', `Model proxy did not start: ${(err as Error).message}`)
    return false
  }
}

/** Fire-and-forget startup work; every failure is logged, never thrown. */
export async function runStartupTasks(core: Core, opts: { packaged: boolean }): Promise<void> {
  // Keep the MCP catalog fresh in the background (respects the TTL; the first full crawl takes minutes).
  void core.catalog.refresh().catch((err: Error) => core.ctx.log.warn('gui', `Catalog refresh failed: ${err.message}`))
  await autostartProxy(core).catch(() => false)
  if (opts.packaged) {
    await refreshStaleRegistrations(core.ctx, core.servers).catch((err: Error) => core.ctx.log.warn('gui', `Self registration check failed: ${err.message}`))
  }
}
