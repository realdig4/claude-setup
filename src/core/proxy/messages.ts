/**
 * POST /v1/messages: route → translate → call the upstream → translate back (JSON or SSE).
 *
 * - Errors before the response starts are real HTTP errors (Claude Code needs the status and wording to
 *   retry, back off or compact). Once SSE headers are out, failures become an SSE `error` event.
 * - SSE headers are flushed as soon as the upstream accepts the request, then `message_start`, then a
 *   `ping` every 10 s so Claude Code's idle watchdogs never fire during long silences.
 * - The client disconnecting (Esc in Claude Code) aborts the upstream request.
 * - Upstream rejections of optional fields are fixed and retried (adapt.ts).
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProxyConfig, ProxyUpstream } from '@shared/types'
import { adaptationForError, applyAdaptation, describeAdaptation, type AdaptationMemory } from './adapt'
import { errorBody, mapNetworkError, mapUpstreamError, parseUpstreamError, type ProxyError } from './errors'
import type { UpstreamKeyCache } from './keys'
import { ToolNameMapper } from './names'
import { detectQuirks } from './quirks'
import { resolveRoute } from './router'
import { SseParser, formatSse } from './sse'
import { estimateRequestTokens } from './tokens'
import { parseAnthropicRequest, toOpenAIRequest } from './translate/request'
import { toAnthropicMessage } from './translate/response'
import { StreamTranslator, UpstreamStreamError, messageToEvents } from './translate/stream'
import type { UpstreamClient, UpstreamResponse } from './upstream'
import { isObject, type AnthropicMessageOut, type SseEvent } from './wire'

/** Everything handleMessages() needs from the server (config snapshot for this request + shared services). */
export interface MessagesContext {
  config: ProxyConfig
  client: UpstreamClient
  keys: UpstreamKeyCache
  adaptations: AdaptationMemory
  pingIntervalMs: number
  headersTimeoutMs: number
  idleTimeoutMs: number
  /** User-Agent used when the client sent none (the client's own UA is forwarded unchanged). */
  defaultUserAgent: string
  /** Extra log line tied to this request (does not count as a request). */
  note(level: 'info' | 'warn' | 'error', message: string, fields: LogFields): void
}

/** Log fields of one request: requested model and "Upstream name (upstream model)". */
export interface LogFields {
  model?: string
  upstream?: string
}

/** How a request ended, for the log and the counters. */
export interface RequestOutcome extends LogFields {
  status: number
  level: 'info' | 'warn' | 'error'
  message: string
  /** Set when the request failed (error counter / lastError). */
  error?: string
}

const MAX_ADAPTATIONS = 3
const ERROR_BODY_LIMIT = 1024 * 1024
const JSON_BODY_LIMIT = 64 * 1024 * 1024

function requestId(): string {
  return `req_${randomUUID().replace(/-/g, '')}`
}

/** `<baseUrl>/chat/completions` (kept as-is when the base URL already ends with it; query preserved). */
export function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.trim())
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/chat\/completions$/i.test(path) ? path : `${path}/chat/completions`
  return url
}

/** Send a JSON response (no-op if the response already started). */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    'request-id': requestId(),
    ...headers
  })
  res.end(text)
}

/** Send an Anthropic error envelope. */
export function sendError(res: ServerResponse, error: ProxyError): void {
  sendJson(res, error.status, errorBody(error.type, error.message), error.headers)
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'request-id': requestId()
  })
  res.flushHeaders()
  res.socket?.setNoDelay(true)
}

/** Writes SSE events, honouring backpressure. */
class SseWriter {
  constructor(private readonly res: ServerResponse) {}

  async write(events: SseEvent[]): Promise<void> {
    if (!events.length || this.res.writableEnded || this.res.destroyed) return
    let flowing = true
    for (const e of events) flowing = this.res.write(formatSse(e)) && flowing
    if (!flowing) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.res.off('drain', done)
          this.res.off('close', done)
          resolve()
        }
        this.res.on('drain', done)
        this.res.on('close', done)
      })
    }
  }
}

function isEventStream(contentType: string): boolean {
  return contentType.includes('text/event-stream')
}

function upstreamHeaders(
  req: IncomingMessage,
  upstream: ProxyUpstream,
  key: string | null,
  stream: boolean,
  defaultUserAgent: string
): Record<string, string> {
  const ua = req.headers['user-agent']
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'gzip, deflate, br',
    // Forwarded unchanged: some provider plans forbid User-Agent tampering.
    'user-agent': typeof ua === 'string' && ua ? ua : defaultUserAgent
  }
  if (key) headers.authorization = `Bearer ${key}`
  const session = req.headers['x-claude-code-session-id']
  if (typeof session === 'string' && session) headers['x-claude-code-session-id'] = session
  for (const [name, value] of Object.entries(upstream.extraHeaders ?? {})) headers[name.toLowerCase()] = value
  return headers
}

/** HTTP status carried inside a 200 body that is really an error (some gateways do this). */
function embeddedError(json: unknown): { status: number; text: string } | null {
  if (!isObject(json) || Array.isArray(json.choices)) return null
  const successCode = json.code === undefined || json.code === 0 || json.code === 200 || json.code === '0' || json.code === '200'
  if ((json.error === undefined || json.error === null) && successCode) return null
  const err = isObject(json.error) ? json.error : {}
  const code = Number(err.code ?? json.code)
  return { status: Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502, text: JSON.stringify(json) }
}

function streamFailure(err: unknown, label: string): string {
  if (err instanceof UpstreamStreamError) return err.message
  const code = isObject(err) && typeof err.code === 'string' ? err.code : ''
  if (code === 'UPSTREAM_TIMEOUT') return `${label} stopped sending data.`
  if (code === 'ECONNRESET' || (err instanceof Error && /aborted|terminated|socket hang up/i.test(err.message))) {
    return `The connection to ${label} was interrupted during the response.`
  }
  return `The response from ${label} failed: ${err instanceof Error ? err.message : String(err)}`
}

interface Exchange {
  res: ServerResponse
  ctx: MessagesContext
  label: string
  fields: LogFields
  signal: AbortSignal
  translator: () => StreamTranslator
  translateJson: (json: unknown) => AnthropicMessageOut
  summary: string
}

function failed(ex: Pick<Exchange, 'res' | 'fields'>, error: ProxyError, logMessage?: string): RequestOutcome {
  sendError(ex.res, error)
  return {
    ...ex.fields,
    status: error.status,
    level: error.status >= 500 ? 'error' : 'warn',
    message: logMessage ?? error.message,
    error: logMessage ?? error.message
  }
}

function cancelled(fields: LogFields): RequestOutcome {
  return { ...fields, status: 499, level: 'warn', message: 'Cancelled by the client before the response finished.' }
}

type StreamResult = { ok: true } | { ok: false; aborted: true } | { ok: false; aborted: false; message: string }

/** Pump the upstream SSE body through the translator; `emit` receives translated events. */
async function pump(
  response: UpstreamResponse,
  translator: StreamTranslator,
  signal: AbortSignal,
  label: string,
  emit: (events: SseEvent[]) => Promise<void>
): Promise<StreamResult> {
  const parser = new SseParser()
  let sawDone = false
  try {
    // destroyOnReturn: false — leaving the loop at [DONE] must not kill the (reusable) connection; destroy() decides.
    outer: for await (const chunk of response.body.iterator({ destroyOnReturn: false })) {
      if (signal.aborted) break
      for (const item of parser.push(chunk as Buffer)) {
        if (item.kind === 'done') {
          sawDone = true
          break outer
        }
        if (item.kind === 'json') await emit(translator.push(item.value, item.event))
      }
    }
    if (signal.aborted) return { ok: false, aborted: true }
    if (!sawDone) {
      for (const item of parser.end()) {
        if (item.kind === 'done') sawDone = true
        else if (item.kind === 'json' && !sawDone) await emit(translator.push(item.value, item.event))
      }
    }
    await emit(translator.finish(sawDone))
    return { ok: true }
  } catch (err) {
    if (signal.aborted) return { ok: false, aborted: true }
    return { ok: false, aborted: false, message: streamFailure(err, label) }
  }
}

async function readJsonBody(ex: Exchange, response: UpstreamResponse): Promise<{ json: unknown } | { outcome: RequestOutcome }> {
  let text: string
  try {
    text = await response.text(JSON_BODY_LIMIT)
  } catch (err) {
    if (ex.signal.aborted) return { outcome: cancelled(ex.fields) }
    return { outcome: failed(ex, { status: 529, type: 'overloaded_error', message: streamFailure(err, ex.label) }) }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    if (response.contentType.includes('text/html') || /^\s*</.test(text)) {
      const message =
        `The server for ${ex.label} answered with a web page instead of an API response. ` +
        'Check its base URL in Claude Setup → Proxy (it usually ends in /v1).'
      return { outcome: failed(ex, { status: 400, type: 'invalid_request_error', message, headers: { 'x-should-retry': 'false' } }) }
    }
    const message = `${ex.label} returned a response that could not be read.`
    return { outcome: failed(ex, { status: 529, type: 'overloaded_error', message }) }
  }
  const embedded = embeddedError(json)
  if (embedded) {
    const details = parseUpstreamError(embedded.status, embedded.text)
    return { outcome: failed(ex, mapUpstreamError(embedded.status, details), `${ex.label} reported an error: ${details.message}`) }
  }
  return { json }
}

async function respondJson(ex: Exchange, response: UpstreamResponse): Promise<RequestOutcome> {
  let message: AnthropicMessageOut
  if (isEventStream(response.contentType)) {
    // The upstream streamed although JSON was requested: collect the stream.
    const translator = ex.translator()
    const result = await pump(response, translator, ex.signal, ex.label, async () => {})
    if (!result.ok) {
      if (result.aborted) return cancelled(ex.fields)
      return failed(ex, { status: 529, type: 'overloaded_error', message: result.message })
    }
    message = translator.toMessage()
  } else {
    const body = await readJsonBody(ex, response)
    if ('outcome' in body) return body.outcome
    message = ex.translateJson(body.json)
  }
  sendJson(ex.res, 200, message)
  return { ...ex.fields, status: 200, level: 'info', message: `${ex.summary} · ${message.stop_reason}` }
}

async function respondStream(ex: Exchange, response: UpstreamResponse): Promise<RequestOutcome> {
  if (!isEventStream(response.contentType)) {
    // The upstream answered a streaming request with JSON: replay it as a complete SSE stream.
    const body = await readJsonBody(ex, response)
    if ('outcome' in body) return body.outcome
    const message = ex.translateJson(body.json)
    startSse(ex.res)
    await new SseWriter(ex.res).write(messageToEvents(message))
    ex.res.end()
    return { ...ex.fields, status: 200, level: 'info', message: `${ex.summary} · ${message.stop_reason}` }
  }

  const translator = ex.translator()
  startSse(ex.res)
  const writer = new SseWriter(ex.res)
  await writer.write(translator.start())
  const ping = setInterval(() => void writer.write([{ event: 'ping', data: { type: 'ping' } }]), ex.ctx.pingIntervalMs)
  try {
    const result = await pump(response, translator, ex.signal, ex.label, (events) => writer.write(events))
    if (!result.ok) {
      if (result.aborted) return cancelled(ex.fields)
      // The open block is left open on purpose: Claude Code treats this as a dropped stream and retries.
      await writer.write(translator.error(result.message))
      return { ...ex.fields, status: 200, level: 'error', message: `Stream failed: ${result.message}`, error: result.message }
    }
    const stop = translator.toMessage().stop_reason
    return { ...ex.fields, status: 200, level: 'info', message: `${ex.summary} · ${stop}` }
  } finally {
    clearInterval(ping)
    if (!ex.res.writableEnded) ex.res.end()
  }
}

/** Handle one Messages API request whose JSON body has been read. Never throws for expected failures. */
export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  raw: unknown,
  ctx: MessagesContext
): Promise<RequestOutcome> {
  const parsed = parseAnthropicRequest(raw)
  if (!parsed.ok) return failed({ res, fields: {} }, { status: 400, type: 'invalid_request_error', message: parsed.message })
  const request = parsed.request
  const route = resolveRoute(ctx.config, request.model)
  if (!route.ok) {
    return failed({ res, fields: { model: request.model } }, { status: 404, type: 'not_found_error', message: route.message })
  }

  const upstream = route.upstream
  const label = upstream.name || upstream.id
  const fields: LogFields = { model: request.model, upstream: `${label} (${route.model})` }
  const key = await ctx.keys.lookup(upstream)
  if (!key.ok) return failed({ res, fields }, { status: 401, type: 'authentication_error', message: key.message })

  let url: URL
  try {
    url = chatCompletionsUrl(upstream.baseUrl)
  } catch {
    const message = `The base URL of ${label} is not valid. Fix it in Claude Setup → Proxy.`
    return failed({ res, fields }, { status: 400, type: 'invalid_request_error', message })
  }

  const quirks = detectQuirks(upstream)
  const names = new ToolNameMapper()
  const { payload, historyToolIds } = toOpenAIRequest(request, { upstream, model: route.model, names, quirks })
  const memoryKey = `${upstream.id}\n${route.model}`
  for (const adaptation of ctx.adaptations.get(memoryKey)) applyAdaptation(payload, adaptation)
  const inputEstimate = estimateRequestTokens(request)
  const headers = upstreamHeaders(req, upstream, key.key, request.stream, ctx.defaultUserAgent)

  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  // The client may already be gone (it hung up while the body was read or the key was looked up).
  if (req.socket.destroyed) abort.abort()
  const onWarning = (message: string): void => ctx.note('warn', message, fields)
  const shared = { names, inputEstimate, reservedIds: historyToolIds, onWarning }
  const ex: Exchange = {
    res,
    ctx,
    label,
    fields,
    signal: abort.signal,
    summary: `${request.stream ? 'stream' : 'non-stream'} → ${label} (${route.model})`,
    translator: () => new StreamTranslator({ model: request.model, ...shared }),
    translateJson: (json) => toAnthropicMessage(json, { requestedModel: request.model, ...shared })
  }

  let response: UpstreamResponse
  for (let attempt = 0; ; attempt++) {
    try {
      response = await ctx.client.send({
        url,
        headers,
        body: JSON.stringify(payload),
        signal: abort.signal,
        headersTimeoutMs: ctx.headersTimeoutMs,
        idleTimeoutMs: ctx.idleTimeoutMs
      })
    } catch (err) {
      if (abort.signal.aborted) return cancelled(fields)
      return failed(ex, mapNetworkError(err, label, url.host))
    }
    if (response.status >= 200 && response.status < 300) break
    const text = await response.text(ERROR_BODY_LIMIT).catch(() => '')
    if (abort.signal.aborted) return cancelled(fields)
    const details = parseUpstreamError(response.status, text)
    const adaptation = attempt < MAX_ADAPTATIONS ? adaptationForError(payload, response.status, details) : null
    if (adaptation && applyAdaptation(payload, adaptation)) {
      ctx.adaptations.remember(memoryKey, adaptation)
      ctx.note('warn', `${label} ${describeAdaptation(adaptation)}; adjusted the request and retried.`, fields)
      continue
    }
    if (response.status === 401 || response.status === 403) ctx.keys.invalidate(upstream)
    const logMessage = `${label} returned HTTP ${response.status}: ${details.message}`
    return failed(ex, mapUpstreamError(response.status, details, response.headers), logMessage)
  }

  try {
    return request.stream ? await respondStream(ex, response) : await respondJson(ex, response)
  } finally {
    response.destroy()
  }
}
