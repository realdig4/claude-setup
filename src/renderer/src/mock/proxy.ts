/** Mock: ProxyApi — the local Anthropic⇄OpenAI translation proxy with live request logs while running. */
import type { ProxyApi } from '@shared/api'
import type { ProxyConfig, ProxyLogEntry, ProxyStatus } from '@shared/types'
import { clone, emit, log, minutesAgo, timing } from './runtime'

let config: ProxyConfig = {
  port: 3460,
  authToken: 'cs-3f9a2c4e8b1d7f60a5e2c9d4b8f1a3e7',
  upstreams: [
    {
      id: 'groq',
      name: 'Groq',
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      keyRef: 'proxy:groq',
      models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'moonshotai/kimi-k2-instruct-0905'],
      maxOutputTokens: 32_768,
      reasoning: 'effort',
      streamOptions: true
    }
  ],
  routes: {
    'claude-sonnet-5-5': 'groq/openai/gpt-oss-120b',
    'claude-opus-5-5': 'groq/openai/gpt-oss-120b',
    'claude-haiku-5-5': 'groq/openai/gpt-oss-20b'
  },
  defaultRoute: 'groq/openai/gpt-oss-120b',
  smallRoute: 'groq/openai/gpt-oss-20b',
  autoStart: true
}

let status: ProxyStatus = { running: false, requests: 0, errors: 0 }

let logs: ProxyLogEntry[] = [
  { time: minutesAgo(48), level: 'info', message: 'Proxy stopped' },
  { time: minutesAgo(52), level: 'info', message: 'POST /v1/messages → groq/openai/gpt-oss-120b', model: 'claude-sonnet-5-5', upstream: 'groq', status: 200, ms: 1840 },
  { time: minutesAgo(53), level: 'warn', message: 'Upstream rate limit — retrying in 2s', model: 'claude-sonnet-5-5', upstream: 'groq', status: 429, ms: 312 },
  { time: minutesAgo(55), level: 'info', message: 'POST /v1/messages → groq/openai/gpt-oss-20b', model: 'claude-haiku-5-5', upstream: 'groq', status: 200, ms: 402 },
  { time: minutesAgo(58), level: 'info', message: 'Proxy started on http://127.0.0.1:3460' }
]

let timer: ReturnType<typeof setTimeout> | null = null

function push(entry: ProxyLogEntry): void {
  logs = [entry, ...logs].slice(0, 300)
  emit('proxy', entry)
}

/** Simulate Claude Code traffic while the proxy runs. */
function scheduleTraffic(): void {
  if (timing.scale === 0) return
  timer = setTimeout(
    () => {
      if (!status.running) return
      const small = Math.random() < 0.35
      const route = small ? (config.smallRoute ?? config.defaultRoute) : config.defaultRoute
      const limited = Math.random() < 0.08
      const entry: ProxyLogEntry = limited
        ? {
            time: new Date().toISOString(),
            level: 'warn',
            message: 'Upstream rate limit — retrying in 2s',
            model: small ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
            upstream: 'groq',
            status: 429,
            ms: 280 + Math.round(Math.random() * 120)
          }
        : {
            time: new Date().toISOString(),
            level: 'info',
            message: `POST /v1/messages → ${route ?? 'default'}`,
            model: small ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
            upstream: 'groq',
            status: 200,
            ms: small ? 300 + Math.round(Math.random() * 400) : 900 + Math.round(Math.random() * 2600)
          }
      status = {
        ...status,
        requests: status.requests + 1,
        errors: status.errors + (limited ? 1 : 0),
        lastError: limited ? 'Groq returned 429 Too Many Requests' : status.lastError
      }
      push(entry)
      scheduleTraffic()
    },
    (3000 + Math.random() * 4000) * timing.scale
  )
}

/** Start the proxy (also used by models.apply for OpenAI-only providers). */
export function startProxy(): ProxyStatus {
  if (!status.running) {
    status = { running: true, port: config.port, url: `http://127.0.0.1:${config.port}`, startedAt: new Date().toISOString(), requests: 0, errors: 0 }
    push({ time: new Date().toISOString(), level: 'info', message: `Proxy started on http://127.0.0.1:${config.port}` })
    log('info', 'proxy', `Listening on 127.0.0.1:${config.port}`)
    scheduleTraffic()
  }
  return clone(status)
}

export const proxyApi: ProxyApi = {
  async status() {
    return clone(status)
  },

  async start() {
    return startProxy()
  },

  async stop() {
    if (timer) clearTimeout(timer)
    timer = null
    if (status.running) {
      status = { running: false, requests: status.requests, errors: status.errors }
      push({ time: new Date().toISOString(), level: 'info', message: 'Proxy stopped' })
    }
    return clone(status)
  },

  async getConfig() {
    return clone(config)
  },

  async saveConfig(next) {
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) {
      throw new Error('The port must be a number between 1024 and 65535.')
    }
    for (const upstream of next.upstreams) {
      if (!/^https?:\/\//.test(upstream.baseUrl)) throw new Error(`“${upstream.name}” needs a base URL starting with http:// or https://.`)
    }
    config = clone(next)
    log('info', 'proxy', 'Configuration saved')
    return clone(config)
  },

  async logs(limit = 100) {
    return clone(logs.slice(0, Math.max(1, limit)))
  }
}
