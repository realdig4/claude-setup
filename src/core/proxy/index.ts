/**
 * ProxyApi: local Anthropic Messages ⇄ OpenAI Chat Completions translation proxy, so Claude Code can use
 * OpenAI-only providers (OpenAI, Gemini, Groq, Cerebras, any OpenAI-compatible server).
 *
 *  - Config lives in `state.proxy` (ProxyConfig); saveConfig validates, persists and restarts on a port change.
 *  - start() is idempotent. When the port already serves a Claude Setup proxy from another process (e.g. the
 *    CLI while the app is open) it reports that one (`external: true`) instead of starting a second server.
 *  - stop() only stops the server of THIS process (Core.dispose() calls it; it must never stop another one).
 *  - logs(): ring buffer of the last 500 entries; every entry is also emitted as a 'proxy' core event.
 */
import type { ProxyApi } from '@shared/api'
import type { ProxyConfig, ProxyLogEntry, ProxyStatus } from '@shared/types'
import type { CoreContext } from '../context'
import { AdaptationMemory } from './adapt'
import { generateProxyToken, isValidProxyToken, validateProxyConfig } from './config'
import { ProxyConfigSource } from './config-source'
import { UpstreamKeyCache } from './keys'
import { LOG_CAPACITY, ProxyLogBook } from './logbook'
import { LOOPBACK, fetchExternalLogs, fetchExternalStats, portIsFree, probeHealth, suggestFreePort, type HealthInfo } from './probe'
import { ProxyServer } from './server'

export { ProxyConfigError, validateProxyConfig, sanitizeProxyConfig, generateProxyToken, DEFAULT_PROXY_PORT } from './config'
export { parseRouteTarget, resolveRoute, listRoutedModels } from './router'
export { PROXY_APP_ID } from './probe'
export { ProxyServer } from './server'

/** Tuning knobs (defaults suit production; tests shorten them). */
export interface ProxyApiOptions {
  /** SSE keep-alive ping interval (default 10 s). */
  pingIntervalMs?: number
  /** Max wait for upstream response headers (default 600 s, like Claude Code's API_TIMEOUT_MS). */
  upstreamHeadersTimeoutMs?: number
  /** Max upstream silence while streaming (default 600 s). */
  upstreamIdleTimeoutMs?: number
  /** How often a running proxy re-checks state.json for changes made by other processes (default 2 s). */
  configCheckIntervalMs?: number
}

/** Whether the app should start the proxy at launch (enabled and at least one upstream configured). */
export function shouldAutoStart(config: ProxyConfig): boolean {
  return config.autoStart !== false && config.upstreams.length > 0
}

/** Base URL Claude Code should use for the proxy (ANTHROPIC_BASE_URL). */
export function proxyBaseUrl(port: number): string {
  return `http://${LOOPBACK}:${port}`
}

/** Create the ProxyApi for a core context. */
export function createProxyApi(ctx: CoreContext, options: ProxyApiOptions = {}): ProxyApi {
  const logbook = new ProxyLogBook((entry) => ctx.events.emitEvent('proxy', entry), LOG_CAPACITY)
  const keys = new UpstreamKeyCache(ctx.secrets)
  const adaptations = new AdaptationMemory()
  // One live view of the config for the server AND the API (includes changes saved by other processes).
  const source = new ProxyConfigSource(ctx.state, options.configCheckIntervalMs)
  let server: ProxyServer | null = null
  let starting: Promise<ProxyStatus> | null = null
  /** Why the last start() failed (shown while stopped; cleared by a successful start). */
  let startError: string | undefined

  const currentConfig = (): Promise<ProxyConfig> => source.current()

  const lifecycle = (level: ProxyLogEntry['level'], message: string): void => {
    logbook.add({ level, message })
    if (level === 'error') ctx.log.error('proxy', message)
    else if (level === 'warn') ctx.log.warn('proxy', message)
    else ctx.log.info('proxy', message)
  }

  const counters = (): Pick<ProxyStatus, 'requests' | 'errors' | 'lastError'> => ({
    requests: logbook.requests,
    errors: logbook.errors,
    ...(logbook.lastError ? { lastError: logbook.lastError } : {})
  })

  const localStatus = (instance: ProxyServer): ProxyStatus => ({
    running: true,
    port: instance.port,
    url: proxyBaseUrl(instance.port as number),
    startedAt: instance.startedAt,
    ...counters()
  })

  const stoppedStatus = (port: number): ProxyStatus => {
    const status: ProxyStatus = { running: false, port, ...counters() }
    if (startError) status.lastError = startError
    return status
  }

  const externalStatus = async (port: number, info: HealthInfo, token: string): Promise<ProxyStatus> => {
    const stats = await fetchExternalStats(port, token)
    const status: ProxyStatus = {
      running: true,
      external: true,
      port,
      url: proxyBaseUrl(port),
      startedAt: stats?.startedAt ?? info.startedAt,
      requests: stats?.requests ?? 0,
      errors: stats?.errors ?? 0
    }
    const lastError = stats ? stats.lastError : logbook.lastError
    if (lastError) status.lastError = lastError
    return status
  }

  /** Our proxy running in another process on `port`, if any. */
  const findExternal = async (port: number): Promise<HealthInfo | null> => {
    if (await portIsFree(port)) return null
    const probe = await probeHealth(port)
    return probe.state === 'ours' ? probe.info : null
  }

  /** Make sure a usable access token exists (a hand-edited state could lack one). */
  const ensureToken = async (): Promise<ProxyConfig> => {
    const config = await currentConfig()
    if (isValidProxyToken(config.authToken)) return config
    const authToken = generateProxyToken()
    await ctx.state.update((draft) => {
      draft.proxy = { ...config, authToken }
    })
    lifecycle('warn', 'Created a new proxy access token. Apply your model again so Claude Code uses it.')
    return currentConfig()
  }

  const listenErrorMessage = async (err: NodeJS.ErrnoException, port: number): Promise<string> => {
    const free = await suggestFreePort(port).catch(() => undefined)
    const hint = free ? ` Choose another port in Proxy settings, for example ${free}.` : ' Choose another port in Proxy settings.'
    if (err.code === 'EADDRINUSE') return `Port ${port} is already used by another program.${hint}`
    if (err.code === 'EACCES') {
      return process.platform === 'win32'
        ? `Windows does not allow using port ${port} (it is reserved by the system, often for Hyper-V or WSL).${hint}`
        : `Permission denied for port ${port}.${hint}`
    }
    if (err.code === 'EADDRNOTAVAIL') return `The local address ${LOOPBACK} is not available on this computer.`
    return `The proxy could not start: ${err.message}`
  }

  const doStart = async (): Promise<ProxyStatus> => {
    const config = await ensureToken()
    const port = config.port
    const instance = new ProxyServer({
      version: ctx.options.appVersion,
      config: source,
      keys,
      logbook,
      adaptations,
      pingIntervalMs: options.pingIntervalMs,
      upstreamHeadersTimeoutMs: options.upstreamHeadersTimeoutMs,
      upstreamIdleTimeoutMs: options.upstreamIdleTimeoutMs
    })
    try {
      await instance.listen(port)
    } catch (error) {
      await instance.close().catch(() => {})
      const err = error as NodeJS.ErrnoException
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        const probe = await probeHealth(port)
        if (probe.state === 'ours') {
          lifecycle('info', `A Claude Setup proxy is already running on port ${port} (started from another window or terminal).`)
          return externalStatus(port, probe.info, config.authToken)
        }
      }
      startError = await listenErrorMessage(err, port)
      lifecycle('error', startError)
      return stoppedStatus(port)
    }
    server = instance
    startError = undefined
    lifecycle('info', `Proxy started on ${proxyBaseUrl(port)}`)
    return localStatus(instance)
  }

  const start = async (): Promise<ProxyStatus> => {
    if (server?.listening) return localStatus(server)
    starting ??= doStart().finally(() => {
      starting = null
    })
    return starting
  }

  const stopLocal = async (): Promise<boolean> => {
    if (starting) await starting.catch(() => undefined)
    const instance = server
    server = null
    if (!instance) return false
    await instance.close()
    lifecycle('info', 'Proxy stopped')
    return true
  }

  const status = async (): Promise<ProxyStatus> => {
    if (server?.listening) return localStatus(server)
    const config = await currentConfig()
    const external = await findExternal(config.port)
    if (external) return externalStatus(config.port, external, config.authToken)
    return stoppedStatus(config.port)
  }

  return {
    status,
    start,

    async stop() {
      await stopLocal()
      return status()
    },

    async getConfig() {
      return structuredClone(await currentConfig())
    },

    async saveConfig(input) {
      const config = validateProxyConfig(input)
      await ctx.state.update((draft) => {
        draft.proxy = config
      })
      keys.clear()
      adaptations.clear()
      if (server?.listening && server.port !== config.port) {
        lifecycle('info', `Restarting the proxy on port ${config.port}`)
        await stopLocal()
        await start()
      }
      return structuredClone(config)
    },

    async logs(limit = 200) {
      const max = Math.max(1, Math.min(Math.floor(Number.isFinite(limit) ? limit : 200), LOG_CAPACITY))
      const local = logbook.list(max)
      if (server?.listening) return local
      const config = await currentConfig()
      const external = await findExternal(config.port)
      if (!external) return local
      const remote = (await fetchExternalLogs(config.port, config.authToken, max)) ?? []
      return [...remote, ...local].sort((a, b) => a.time.localeCompare(b.time)).slice(-max)
    }
  }
}
