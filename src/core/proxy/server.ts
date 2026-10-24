/**
 * The proxy's HTTP server. Listens on 127.0.0.1 only.
 *
 *   HEAD *                          → 200 (Claude Code's `HEAD /api/hello` warm-up)
 *   GET  /health  (and /)           → {ok, app:'claude-setup-proxy', version, port, pid, startedAt}  (no auth)
 *   GET  …/v1/models[/id]           → Anthropic-shaped list of routed models
 *   POST …/v1/messages/count_tokens → {input_tokens} estimate
 *   POST …/v1/messages[?beta=true]  → translation (messages.ts)
 *   GET  /_claude-setup/status|logs → counters / log for other Claude Setup processes
 *   anything else                   → 404 Anthropic error
 *
 * Every route except HEAD and /health requires the local access token (`x-api-key` or
 * `Authorization: Bearer`), compared in constant time. The token is never forwarded upstream.
 * Paths are matched with endsWith(), so a doubled `/v1` prefix still works. Bodies are limited to 32 MB.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type { ProxyConfig } from '@shared/types'
import { USER_AGENT } from '../http'
import type { AdaptationMemory } from './adapt'
import type { ProxyConfigSource } from './config-source'
import { errorBody, type AnthropicErrorType } from './errors'
import type { UpstreamKeyCache } from './keys'
import type { ProxyLogBook } from './logbook'
import { handleMessages, sendJson, type LogFields, type RequestOutcome } from './messages'
import { ADMIN_PREFIX, LOOPBACK, PROXY_APP_ID } from './probe'
import { listRoutedModels } from './router'
import { estimateRequestTokens } from './tokens'
import { parseAnthropicRequest } from './translate/request'
import { UpstreamClient } from './upstream'

/** Largest accepted request body (the Anthropic API limit). */
export const MAX_BODY_BYTES = 32 * 1024 * 1024
/** SSE keep-alive ping interval: Claude Code's watchdogs need bytes at least every 10 s. */
export const DEFAULT_PING_INTERVAL_MS = 10_000
/** Matches Claude Code's own API_TIMEOUT_MS default (time to response headers). */
export const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 600_000
/** Longest upstream silence tolerated mid-response (pings keep Claude Code waiting meanwhile). */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 600_000

/** Dependencies of one proxy HTTP server instance. */
export interface ProxyServerOptions {
  version: string
  config: ProxyConfigSource
  keys: UpstreamKeyCache
  logbook: ProxyLogBook
  adaptations: AdaptationMemory
  pingIntervalMs?: number
  upstreamHeadersTimeoutMs?: number
  upstreamIdleTimeoutMs?: number
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (err?: Error): void => {
      if (done) return
      done = true
      if (err) reject(err)
      else resolve(Buffer.concat(chunks))
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        finish(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish())
    req.on('error', (err) => finish(err))
    req.on('close', () => finish(new Error('The client closed the connection while sending the request.')))
  })
}

function decodeRequestBody(raw: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase()
  const opts = { maxOutputLength: MAX_BODY_BYTES }
  if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw, opts)
  if (enc === 'deflate') return inflateSync(raw, opts)
  if (enc === 'br') return brotliDecompressSync(raw, opts)
  return raw
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time token comparison. */
export function tokensMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected))
}

/** One listening proxy (127.0.0.1 only); see the file header for the routes. */
export class ProxyServer {
  private server: http.Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly client = new UpstreamClient()
  private boundPort?: number
  private started?: string

  constructor(private readonly opts: ProxyServerOptions) {}

  get listening(): boolean {
    return this.server?.listening === true
  }

  get port(): number | undefined {
    return this.boundPort
  }

  get startedAt(): string | undefined {
    return this.started
  }

  /** Start listening on 127.0.0.1:`port` (0 = any free port). Rejects with the listen error (e.g. EADDRINUSE). */
  listen(port: number): Promise<void> {
    if (this.server) return Promise.reject(new Error('The proxy server is already running.'))
    const server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
    // Longer than clients' idle-socket reuse window, so a reused keep-alive socket is never closed under them.
    server.keepAliveTimeout = 60_000
    server.headersTimeout = 65_000
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        server.on('error', (err) => this.opts.logbook.add({ level: 'error', message: `Proxy server error: ${err.message}` }))
        this.server = server
        this.boundPort = (server.address() as AddressInfo).port
        this.started = new Date().toISOString()
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ port, host: LOOPBACK })
    })
  }

  /** Stop listening and drop every connection (in-flight upstream requests are aborted). */
  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
        for (const socket of this.sockets) socket.destroy()
      })
    }
    this.sockets.clear()
    this.client.close()
  }

  private health(): Record<string, unknown> {
    return { ok: true, app: PROXY_APP_ID, version: this.opts.version, port: this.boundPort, pid: process.pid, startedAt: this.started }
  }

  private authorized(req: IncomingMessage, config: ProxyConfig): boolean {
    const expected = config.authToken
    if (!expected) return false
    const candidates: string[] = []
    const apiKey = req.headers['x-api-key']
    if (typeof apiKey === 'string' && apiKey.trim()) candidates.push(apiKey.trim())
    const auth = req.headers.authorization
    const bearer = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null
    if (bearer) candidates.push(bearer[1].trim())
    return candidates.some((c) => tokensMatch(c, expected))
  }

  private record(outcome: RequestOutcome, startedAt: number): void {
    this.opts.logbook.count(outcome.error)
    this.opts.logbook.add({
      level: outcome.level,
      message: outcome.message,
      model: outcome.model,
      upstream: outcome.upstream,
      status: outcome.status,
      ms: Date.now() - startedAt
    })
  }

  /** Send a client error and record it (counts as a failed request). */
  private reject(
    res: ServerResponse,
    status: number,
    type: AnthropicErrorType,
    message: string,
    logMessage: string,
    startedAt: number
  ): void {
    sendJson(res, status, errorBody(type, message))
    this.record({ status, level: 'warn', message: logMessage, error: message }, startedAt)
  }

  /** Read and parse a JSON body; on failure the error response is sent and undefined returned. */
  private async readJson(
    req: IncomingMessage,
    res: ServerResponse,
    what: string,
    startedAt: number
  ): Promise<{ body: unknown } | undefined> {
    let raw: Buffer
    try {
      raw = decodeRequestBody(await readBody(req, MAX_BODY_BYTES), req.headers['content-encoding'])
    } catch (err) {
      if (err instanceof BodyTooLargeError || (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        res.setHeader('connection', 'close')
        const message = 'The request is larger than the 32 MB limit.'
        this.reject(res, 413, 'request_too_large', message, `${what}: request over 32 MB`, startedAt)
      } else if (!res.headersSent && !req.destroyed) {
        this.reject(res, 400, 'invalid_request_error', 'The request body could not be read.', `${what}: unreadable body`, startedAt)
      }
      return undefined
    }
    try {
      const text = raw.toString('utf8')
      return { body: text.trim() ? JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) : {} }
    } catch {
      const message = 'The request body is not valid JSON.'
      this.reject(res, 400, 'invalid_request_error', message, `${what}: body is not valid JSON`, startedAt)
      return undefined
    }
  }

  private modelEntries(config: ProxyConfig): Array<Record<string, unknown>> {
    const created = this.started ?? new Date().toISOString()
    return listRoutedModels(config).map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: created }))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const method = (req.method ?? 'GET').toUpperCase()
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      url = new URL('http://127.0.0.1/')
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      if (method === 'GET' && (path === '/health' || path === '/')) {
        sendJson(res, 200, this.health())
        return
      }
      const config = await this.opts.config.current()
      if (!this.authorized(req, config)) {
        const message =
          'Missing or wrong Claude Setup proxy token. Re-apply the model in Claude Setup so Claude Code gets the current token.'
        this.reject(res, 401, 'authentication_error', message, `Rejected ${method} ${path}: missing or wrong proxy token`, startedAt)
        return
      }

      if (method === 'GET' && path === `${ADMIN_PREFIX}/status`) {
        const { requests, errors, lastError } = this.opts.logbook
        sendJson(res, 200, { requests, errors, lastError, startedAt: this.started, port: this.boundPort })
        return
      }
      if (method === 'GET' && path === `${ADMIN_PREFIX}/logs`) {
        sendJson(res, 200, { entries: this.opts.logbook.list(Number(url.searchParams.get('limit') ?? 200)) })
        return
      }

      if (method === 'GET' && path.endsWith('/v1/models')) {
        const data = this.modelEntries(config)
        sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null })
        this.record({ status: 200, level: 'info', message: `Listed ${data.length} models` }, startedAt)
        return
      }
      const single = method === 'GET' ? /\/v1\/models\/([^/]+)$/.exec(path) : null
      if (single) {
        let id = single[1]
        try {
          id = decodeURIComponent(id)
        } catch {
          // keep the raw segment for malformed escapes
        }
        const entry = this.modelEntries(config).find((m) => m.id === id)
        if (entry) sendJson(res, 200, entry)
        else sendJson(res, 404, errorBody('not_found_error', `model: ${id}`))
        const status = entry ? 200 : 404
        this.record({ status, level: entry ? 'info' : 'warn', message: `Looked up model ${id}`, model: id }, startedAt)
        return
      }

      if (method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
        const read = await this.readJson(req, res, 'count_tokens', startedAt)
        if (!read) return
        const parsed = parseAnthropicRequest(read.body)
        if (!parsed.ok) {
          this.reject(res, 400, 'invalid_request_error', parsed.message, `count_tokens: ${parsed.message}`, startedAt)
          return
        }
        const tokens = estimateRequestTokens(parsed.request)
        sendJson(res, 200, { input_tokens: tokens })
        const model = parsed.request.model || undefined
        this.record({ status: 200, level: 'info', message: `Estimated ${tokens} input tokens`, model }, startedAt)
        return
      }

      if (method === 'POST' && path.endsWith('/v1/messages')) {
        const read = await this.readJson(req, res, 'messages', startedAt)
        if (!read) return
        const outcome = await handleMessages(req, res, read.body, {
          config,
          client: this.client,
          keys: this.opts.keys,
          adaptations: this.opts.adaptations,
          pingIntervalMs: this.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
          headersTimeoutMs: this.opts.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS,
          idleTimeoutMs: this.opts.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
          defaultUserAgent: USER_AGENT,
          note: (level, message, fields: LogFields) => this.opts.logbook.add({ level, message, ...fields })
        })
        this.record(outcome, startedAt)
        return
      }

      sendJson(res, 404, errorBody('not_found_error', `Not found: ${method} ${path}`))
      this.record({ status: 404, level: 'warn', message: `No route for ${method} ${path}` }, startedAt)
    } catch (err) {
      const message = `Claude Setup proxy error: ${(err as Error).message}`
      if (!res.headersSent) sendJson(res, 500, errorBody('api_error', message))
      else if (!res.writableEnded) res.end()
      this.record({ status: 500, level: 'error', message, error: message }, startedAt)
    }
  }
}
