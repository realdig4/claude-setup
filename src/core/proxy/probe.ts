/**
 * Local probes: is a port free, is a Claude Setup proxy already listening there (possibly started by
 * another process, e.g. the CLI while the app is open), and read-only admin calls to such a proxy.
 *
 * Port checks bind briefly instead of connecting: on Windows a connection to a closed localhost port
 * takes ~2 s to be refused, while a bind attempt answers immediately.
 */
import http from 'node:http'
import net from 'node:net'
import type { ProxyLogEntry } from '@shared/types'
import { isObject } from './wire'

/** `app` value in /health that identifies a Claude Setup proxy. */
export const PROXY_APP_ID = 'claude-setup-proxy'
/** Path prefix of the read-only admin endpoints (token required). */
export const ADMIN_PREFIX = '/_claude-setup'
/** The only address the proxy binds (never 0.0.0.0: no firewall prompt, no LAN exposure). */
export const LOOPBACK = '127.0.0.1'

/** Body of GET /health. */
export interface HealthInfo {
  ok: true
  app: string
  version?: string
  port?: number
  pid?: number
  startedAt?: string
}

/** What answers on a port: our proxy, another program, or nothing. */
export type ProbeResult = { state: 'ours'; info: HealthInfo } | { state: 'other' } | { state: 'none' }

/** Counters reported by a proxy running in another process. */
export interface ExternalStats {
  requests: number
  errors: number
  lastError?: string
  startedAt?: string
}

/** True when nothing listens on 127.0.0.1:`port` (and we are allowed to bind it). */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: LOOPBACK }, () => server.close(() => resolve(true)))
  })
}

/** First free port after `port` (within 30), for friendly "try this one" suggestions. */
export async function suggestFreePort(port: number): Promise<number | undefined> {
  for (let candidate = port + 1; candidate <= Math.min(65535, port + 30); candidate++) {
    if (await portIsFree(candidate)) return candidate
  }
  return undefined
}

interface LocalResponse {
  status: number
  body: string
}

type LocalResult = LocalResponse | { error: string }

function localRequest(port: number, path: string, token: string | undefined, timeoutMs: number): Promise<LocalResult> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  return new Promise((resolve) => {
    const req = http.request(
      { host: LOOPBACK, port, method: 'GET', path, agent: false, timeout: timeoutMs, headers },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= 4 * 1024 * 1024) chunks.push(chunk)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? 'ERROR' }))
      }
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? 'ERROR' }))
    req.end()
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** What is listening on 127.0.0.1:`port`: our proxy (with its /health info), something else, or nothing. */
export async function probeHealth(port: number, timeoutMs = 2000): Promise<ProbeResult> {
  const res = await localRequest(port, '/health', undefined, timeoutMs)
  if ('error' in res) return res.error === 'ECONNREFUSED' ? { state: 'none' } : { state: 'other' }
  const json = parseJson(res.body)
  const ours = res.status === 200 && isObject(json) && json.ok === true && json.app === PROXY_APP_ID
  return ours ? { state: 'ours', info: json as unknown as HealthInfo } : { state: 'other' }
}

/** Counters of a proxy running in another process (requires its access token). */
export async function fetchExternalStats(port: number, token: string, timeoutMs = 2000): Promise<ExternalStats | null> {
  const res = await localRequest(port, `${ADMIN_PREFIX}/status`, token, timeoutMs)
  if ('error' in res || res.status !== 200) return null
  const json = parseJson(res.body)
  if (!isObject(json) || typeof json.requests !== 'number' || typeof json.errors !== 'number') return null
  return {
    requests: json.requests,
    errors: json.errors,
    lastError: typeof json.lastError === 'string' ? json.lastError : undefined,
    startedAt: typeof json.startedAt === 'string' ? json.startedAt : undefined
  }
}

/** Log entries of a proxy running in another process (requires its access token). */
export async function fetchExternalLogs(port: number, token: string, limit: number, timeoutMs = 2000): Promise<ProxyLogEntry[] | null> {
  const path = `${ADMIN_PREFIX}/logs?limit=${Math.max(1, Math.floor(limit))}`
  const res = await localRequest(port, path, token, timeoutMs)
  if ('error' in res || res.status !== 200) return null
  const json = parseJson(res.body)
  if (!isObject(json) || !Array.isArray(json.entries)) return null
  return json.entries.filter((e): e is ProxyLogEntry => isObject(e) && typeof e.time === 'string' && typeof e.message === 'string')
}
