/**
 * Error handling for the proxy (research_proxy.md §6.5).
 *  - Anthropic error envelopes: `{type:"error", error:{type, message}}`
 *  - upstream HTTP errors → the status/type Claude Code expects (5xx → 529 overloaded so it backs off and retries)
 *  - context-window errors rewritten into the two wordings Claude Code recognizes (verified):
 *      "input length and `max_tokens` exceed context limit: I + C > L, …"  → retries with a smaller max_tokens
 *      "prompt is too long: N tokens > M maximum"                         → compacts the conversation
 *  - network failures → friendly messages
 */
import { isObject } from './wire'

/** Error types of the Anthropic API (the `error.type` field). */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'billing_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'api_error'
  | 'overloaded_error'

/** An error response the proxy sends to Claude Code. */
export interface ProxyError {
  status: number
  type: AnthropicErrorType
  message: string
  headers?: Record<string, string>
}

/** What could be read out of an upstream error body. */
export interface UpstreamErrorDetails {
  message: string
  code?: string
  param?: string
  type?: string
}

/** `{type:"error", error:{type, message}}` */
export interface AnthropicErrorEnvelope {
  type: 'error'
  error: { type: AnthropicErrorType; message: string }
}

/** Anthropic error envelope. */
export function errorBody(type: AnthropicErrorType, message: string): AnthropicErrorEnvelope {
  return { type: 'error', error: { type, message } }
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(text)
}

/** Read the error message/code/param out of any error body (OpenAI, Gemini array, FastAPI `detail`, plain text, HTML). */
export function parseUpstreamError(status: number, text: string): UpstreamErrorDetails {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (Array.isArray(json)) json = json[0]
  if (isObject(json)) {
    const err = isObject(json.error) ? json.error : json
    let message = str(err.message) ?? (typeof json.error === 'string' ? json.error : undefined) ?? str(json.message) ?? str(err.msg)
    let param = str(err.param)
    const detail = json.detail
    if (!message && typeof detail === 'string') message = detail
    if (!message && Array.isArray(detail)) {
      const first = detail.find(isObject)
      if (first) {
        const loc = Array.isArray(first.loc) ? first.loc.map(String) : []
        message = `${loc.join('.')}: ${str(first.msg) ?? 'invalid value'}`
        if (loc[0] === 'body' && loc.length >= 2) param = loc[1]
      }
    }
    if (message) return { message, code: str(err.code), param, type: str(err.type) ?? str(err.status) }
  }
  const body = text.trim()
  if (!body) return { message: `HTTP ${status} with an empty response` }
  if (looksLikeHtml(body)) {
    return { message: `HTTP ${status}: the server returned a web page instead of an API response (check the base URL)` }
  }
  return { message: body.length > 500 ? `${body.slice(0, 500)}…` : body }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-window and output-cap errors
// ─────────────────────────────────────────────────────────────────────────────

function toInt(value: string): number {
  return Number(value.replace(/[,_\s]/g, ''))
}

function firstNumber(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const m = pattern.exec(message)
    if (m) {
      const n = toInt(m[1])
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

const AT_MOST = '(?:less than or equal to|at most|<=|no (?:more|greater) than)'
const OUTPUT_CAP_PATTERNS = [
  /supports at most (\d[\d,]*) completion tokens/i,
  new RegExp(`max_(?:completion_)?tokens[\`'"]?\\s+(?:must|should) be ${AT_MOST}\\s*[\`'"]?(\\d[\\d,]*)`, 'i'),
  /valid range of [`'"]?max_(?:completion_)?tokens[`'"]? is \[\s*\d+\s*,\s*(\d[\d,]*)\s*\]/i,
  /max(?:imum)? (?:number of )?output tokens(?: allowed)?(?: for this model)? (?:is|of) (\d[\d,]*)/i
]

/** The upstream's stated max output tokens, when an error says the requested max_tokens is above it. */
export function outputCapFromMessage(message: string): number | undefined {
  const n = firstNumber(message, OUTPUT_CAP_PATTERNS)
  return n !== undefined && n >= 1 ? n : undefined
}

const CONTEXT_PATTERNS = [
  /maximum context length/i,
  /context[ _-]?(?:length|window|size)/i,
  /prompt is too long/i,
  /input (?:is )?too long/i,
  /too many (?:input |prompt )?tokens/i,
  /input token count/i,
  /exceed\w* (?:the )?(?:\w+'?s? ){0,3}(?:context|token limit|maximum (?:number of )?tokens|max(?:imum)? tokens)/i,
  /reduce the length of (?:the |your )?(?:messages|prompt|input)/i,
  /\btoken limit\b/i
]
const RATE_LIMIT_WORDING = /per (?:minute|min|hour|day)\b|\b(?:TPM|RPM|TPD|RPD)\b|rate.?limit/i

/** Whether an upstream error means "the conversation no longer fits the model's context window". */
export function isContextOverflow(message: string, code?: string): boolean {
  if (code === 'context_length_exceeded') return true
  if (RATE_LIMIT_WORDING.test(message) || outputCapFromMessage(message) !== undefined) return false
  return CONTEXT_PATTERNS.some((p) => p.test(message))
}

/** Rewrite a context-overflow message into the wording Claude Code acts on. */
export function contextOverflowMessage(message: string): string {
  const limit = firstNumber(message, [
    /maximum context length is (\d[\d,]*)/i,
    /context (?:length|window|size) (?:of|is) (\d[\d,]*)/i,
    /maximum number of tokens allowed \((\d[\d,]*)\)/i
  ])
  const input = firstNumber(message, [
    /(\d[\d,]*) (?:tokens )?in the messages/i,
    /(\d[\d,]*) (?:tokens )?of (?:text )?input/i,
    /request has (\d[\d,]*) input tokens/i,
    /input token count (?:\(|of |is )?(\d[\d,]*)/i,
    /(\d[\d,]*) (?:tokens )?in the prompt/i
  ])
  const output = firstNumber(message, [
    /(\d[\d,]*) (?:tokens )?in the (?:completion|output)/i,
    /max_(?:completion_)?tokens[`'"]? (?:is )?too large: (\d[\d,]*)/i
  ])
  if (limit !== undefined && input !== undefined && output !== undefined && input < limit) {
    const overflow = `${input} + ${output} > ${limit}`
    return `input length and \`max_tokens\` exceed context limit: ${overflow}, decrease input length or \`max_tokens\` and try again`
  }
  if (limit !== undefined && input !== undefined && input >= limit) return `prompt is too long: ${input} tokens > ${limit} maximum`
  const numbers = (message.match(/\d[\d,]{3,}/g) ?? []).map(toInt).filter(Number.isFinite).sort((a, b) => b - a)
  if (numbers.length >= 2 && numbers[0] !== numbers[1]) return `prompt is too long: ${numbers[0]} tokens > ${numbers[1]} maximum`
  return `prompt is too long: ${message}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Status mapping
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TYPES: Record<number, AnthropicErrorType> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  408: 'timeout_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  504: 'timeout_error'
}

/** Integer seconds for `retry-after` (HTTP dates and fractional values are converted; anything else dropped). */
export function retryAfterSeconds(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d+$/.test(v)) return v
  if (/^\d+\.\d+$/.test(v)) return String(Math.ceil(Number(v)))
  const date = Date.parse(v)
  if (!Number.isNaN(date)) return String(Math.max(0, Math.ceil((date - Date.now()) / 1000)))
  return undefined
}

/** Map an upstream HTTP error onto the Anthropic error Claude Code should see. */
export function mapUpstreamError(status: number, details: UpstreamErrorDetails, headers: Record<string, string> = {}): ProxyError {
  const message = details.message
  if (status >= 300 && status < 400) {
    // Redirects are not followed (a POST must not silently change target); the base URL needs fixing.
    const location = headers.location ? ` to ${headers.location}` : ''
    return {
      status: 400,
      type: 'invalid_request_error',
      message: `The provider redirected the request (HTTP ${status}${location}). Update the base URL in Claude Setup → Proxy.`,
      headers: { 'x-should-retry': 'false' }
    }
  }
  let result: ProxyError
  if (status < 500 && status !== 429 && isContextOverflow(message, details.code)) {
    result = { status: 400, type: 'invalid_request_error', message: contextOverflowMessage(message) }
  } else if (status === 500) result = { status: 500, type: 'api_error', message }
  else if (status > 500 && status !== 504) result = { status: 529, type: 'overloaded_error', message }
  else if (status === 422) result = { status: 400, type: 'invalid_request_error', message }
  else if (STATUS_TYPES[status]) result = { status, type: STATUS_TYPES[status], message }
  else if (status >= 400 && status < 500) result = { status, type: 'invalid_request_error', message }
  else result = { status: 500, type: 'api_error', message: `Unexpected HTTP ${status} from the provider: ${message}` }

  const out: Record<string, string> = {}
  const retryAfter = retryAfterSeconds(headers['retry-after'])
  if (retryAfter !== undefined) out['retry-after'] = retryAfter
  if (headers['x-should-retry']) out['x-should-retry'] = headers['x-should-retry']
  if (Object.keys(out).length) result.headers = out
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Network errors
// ─────────────────────────────────────────────────────────────────────────────

function errorCode(err: unknown): string | undefined {
  if (!isObject(err)) return undefined
  if (typeof err.code === 'string') return err.code
  return errorCode(err.cause)
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL|EPROTO$|HOSTNAME_MISMATCH)/

/** Friendly Anthropic error for a failure to reach the upstream at all. */
export function mapNetworkError(err: unknown, label: string, host: string): ProxyError {
  const code = errorCode(err) ?? ''
  const detail = err instanceof Error ? err.message : String(err)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const message = `Could not find ${host} (DNS lookup failed). Check your internet connection and the base URL of ${label}.`
    return { status: 529, type: 'overloaded_error', message }
  }
  if (code === 'ECONNREFUSED') {
    const message = `${host} refused the connection. Check that ${label} is reachable and its base URL is correct.`
    return { status: 529, type: 'overloaded_error', message }
  }
  if (code === 'UPSTREAM_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { status: 504, type: 'timeout_error', message: `${label} did not respond in time. ${detail}` }
  }
  if (TLS_CODES.test(code)) {
    const hint = 'If a corporate proxy or antivirus inspects HTTPS, set NODE_EXTRA_CA_CERTS to its certificate.'
    return {
      status: 400,
      type: 'invalid_request_error',
      message: `The secure connection to ${host} failed (${code}). ${hint}`,
      headers: { 'x-should-retry': 'false' }
    }
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return { status: 529, type: 'overloaded_error', message: `The connection to ${label} was interrupted. ${detail}` }
  }
  return { status: 529, type: 'overloaded_error', message: `Could not reach ${label}: ${detail}` }
}
