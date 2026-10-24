import { describe, expect, it } from 'vitest'
import { AdaptationMemory, adaptationForError, applyAdaptation, describeAdaptation } from '@core/proxy/adapt'
import {
  contextOverflowMessage,
  isContextOverflow,
  mapNetworkError,
  mapUpstreamError,
  outputCapFromMessage,
  parseUpstreamError,
  retryAfterSeconds
} from '@core/proxy/errors'
import type { OpenAIRequest } from '@core/proxy/wire'

const OPENAI_CONTEXT =
  "This model's maximum context length is 131072 tokens. However, you requested 152000 tokens (120000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion."

function upstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return mapUpstreamError(status, parseUpstreamError(status, text), headers)
}

describe('context-window errors use the wording Claude Code acts on', () => {
  it('OpenAI wording with input below the limit → max_tokens overflow wording (verified retry path)', () => {
    const e = upstream(400, { error: { message: OPENAI_CONTEXT, type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } })
    expect(e).toEqual({
      status: 400,
      type: 'invalid_request_error',
      message: 'input length and `max_tokens` exceed context limit: 120000 + 32000 > 131072, decrease input length or `max_tokens` and try again'
    })
  })

  it('input above the limit → "prompt is too long" (verified compaction path)', () => {
    const msg = "This model's maximum context length is 131072 tokens. However, you requested 170000 tokens (140000 in the messages, 30000 in the completion)."
    expect(contextOverflowMessage(msg)).toBe('prompt is too long: 140000 tokens > 131072 maximum')
    const gemini = upstream(400, [{ error: { code: 400, message: 'The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }])
    expect(gemini.message).toBe('prompt is too long: 1234567 tokens > 1048576 maximum')
    const vllm = upstream(400, {
      object: 'error',
      message:
        "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 32768 tokens and your request has 1000 input tokens (32000 > 32768 - 1000).",
      code: 400
    })
    expect(vllm.message).toBe('input length and `max_tokens` exceed context limit: 1000 + 32000 > 32768, decrease input length or `max_tokens` and try again')
    const openrouter = upstream(400, {
      error: { message: "This endpoint's maximum context length is 131072 tokens. However, you requested about 150000 tokens (118000 of text input, 32000 in the output).", code: 400 }
    })
    expect(openrouter.message).toMatch(/^input length and `max_tokens` exceed context limit: 118000 \+ 32000 > 131072/)
  })

  it('other overflow wordings fall back to the biggest numbers or the raw text', () => {
    expect(upstream(400, { error: { message: 'Please reduce the length of the messages or completion.', code: 'context_length_exceeded' } }).message).toBe(
      'prompt is too long: Please reduce the length of the messages or completion.'
    )
    expect(upstream(413, { error: { message: 'Input is too long for requested model: 300,000 tokens exceed the context window of 200,000.' } })).toEqual({
      status: 400,
      type: 'invalid_request_error',
      message: 'prompt is too long: 300000 tokens > 200000 maximum'
    })
    expect(upstream(400, 'the request exceeds the available context size, try increasing it').message).toMatch(/^prompt is too long: /)
  })

  it('output-cap, rate-limit and unrelated errors are not mistaken for context overflow', () => {
    const groqCap = '`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model'
    expect(isContextOverflow(groqCap)).toBe(false)
    expect(outputCapFromMessage(groqCap)).toBe(8192)
    expect(outputCapFromMessage('max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.')).toBe(16384)
    expect(outputCapFromMessage('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]')).toBe(8192)
    const tpm = 'Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 15000, please reduce your message size and try again.'
    expect(isContextOverflow(tpm)).toBe(false)
    expect(upstream(413, { error: { message: tpm } })).toMatchObject({ status: 413, type: 'request_too_large' })
    expect(isContextOverflow("Invalid 'tools[0].function.description': string too long")).toBe(false)
    expect(upstream(429, { error: { message: 'context window token limit reached for your tier, rate limit' } }).type).toBe('rate_limit_error')
  })
})

describe('status mapping', () => {
  it('maps statuses to Anthropic types; 5xx except 500/504 become 529 overloaded', () => {
    const cases: Array<[number, number, string]> = [
      [400, 400, 'invalid_request_error'],
      [401, 401, 'authentication_error'],
      [402, 402, 'billing_error'],
      [403, 403, 'permission_error'],
      [404, 404, 'not_found_error'],
      [408, 408, 'timeout_error'],
      [413, 413, 'request_too_large'],
      [422, 400, 'invalid_request_error'],
      [429, 429, 'rate_limit_error'],
      [409, 409, 'invalid_request_error'],
      [500, 500, 'api_error'],
      [502, 529, 'overloaded_error'],
      [503, 529, 'overloaded_error'],
      [529, 529, 'overloaded_error'],
      [504, 504, 'timeout_error'],
      [302, 400, 'invalid_request_error']
    ]
    for (const [status, expectedStatus, type] of cases) {
      const e = upstream(status, { error: { message: 'boom' } })
      expect([status, e.status, e.type]).toEqual([status, expectedStatus, type])
    }
    expect(upstream(401, { error: { message: 'Incorrect API key provided: sk-ab***yz' } }).message).toBe('Incorrect API key provided: sk-ab***yz')
    expect(upstream(301, '', { location: 'https://api.example.com/v1/chat/completions' })).toEqual({
      status: 400,
      type: 'invalid_request_error',
      message: 'The provider redirected the request (HTTP 301 to https://api.example.com/v1/chat/completions). Update the base URL in Claude Setup → Proxy.',
      headers: { 'x-should-retry': 'false' }
    })
  })

  it('forwards retry-after only as integer seconds, and x-should-retry unchanged', () => {
    expect(upstream(429, { error: { message: 'slow down' } }, { 'retry-after': '20' }).headers).toEqual({ 'retry-after': '20' })
    expect(upstream(429, { error: { message: 'x' } }, { 'retry-after': '1.2' }).headers).toEqual({ 'retry-after': '2' })
    expect(upstream(429, { error: { message: 'x' } }, { 'retry-after': 'soon' }).headers).toBeUndefined()
    expect(upstream(503, { error: { message: 'x' } }, { 'x-should-retry': 'false' }).headers).toEqual({ 'x-should-retry': 'false' })
    const future = new Date(Date.now() + 30_000).toUTCString()
    expect(Number(retryAfterSeconds(future))).toBeGreaterThanOrEqual(28)
  })

  it('parses OpenAI, Gemini, FastAPI, plain-text, HTML and empty error bodies', () => {
    expect(parseUpstreamError(400, JSON.stringify({ error: { message: 'm', code: 'c', param: 'p', type: 't' } }))).toEqual({ message: 'm', code: 'c', param: 'p', type: 't' })
    expect(parseUpstreamError(400, JSON.stringify([{ error: { code: 400, message: 'gem', status: 'INVALID_ARGUMENT' } }]))).toEqual({
      message: 'gem',
      code: '400',
      param: undefined,
      type: 'INVALID_ARGUMENT'
    })
    expect(parseUpstreamError(422, JSON.stringify({ detail: [{ loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] }))).toEqual({
      message: 'body.stream_options: Extra inputs are not permitted',
      code: undefined,
      param: 'stream_options',
      type: undefined
    })
    expect(parseUpstreamError(401, JSON.stringify({ error: 'Unauthorized' })).message).toBe('Unauthorized')
    expect(parseUpstreamError(401, JSON.stringify({ code: 30014, message: 'Token is invalid.' })).message).toBe('Token is invalid.')
    expect(parseUpstreamError(502, 'Bad gateway').message).toBe('Bad gateway')
    expect(parseUpstreamError(404, '<!DOCTYPE html><html><body>Not Found</body></html>').message).toMatch(/web page instead of an API response/)
    expect(parseUpstreamError(500, '').message).toBe('HTTP 500 with an empty response')
  })
})

describe('network errors', () => {
  it('gives friendly messages and retryable statuses for transient failures', () => {
    const err = (code: string) => Object.assign(new Error(`connect ${code}`), { code })
    expect(mapNetworkError(err('ENOTFOUND'), 'OpenAI', 'api.openai.com')).toMatchObject({ status: 529, type: 'overloaded_error' })
    expect(mapNetworkError(err('ENOTFOUND'), 'OpenAI', 'api.openai.com').message).toMatch(/DNS lookup failed/)
    expect(mapNetworkError(err('ECONNREFUSED'), 'Local', '127.0.0.1:1').message).toMatch(/refused the connection/)
    expect(mapNetworkError(err('UPSTREAM_TIMEOUT'), 'X', 'h')).toMatchObject({ status: 504, type: 'timeout_error' })
    expect(mapNetworkError(err('SELF_SIGNED_CERT_IN_CHAIN'), 'X', 'h')).toMatchObject({ status: 400, headers: { 'x-should-retry': 'false' } })
    expect(mapNetworkError(Object.assign(new Error('fetch failed'), { cause: err('ECONNRESET') }), 'X', 'h').message).toMatch(/interrupted/)
    expect(mapNetworkError(new Error('weird'), 'X', 'h')).toMatchObject({ status: 529, message: 'Could not reach X: weird' })
  })
})

describe('self-healing adaptations', () => {
  const payload = (extra: Partial<OpenAIRequest> = {}): OpenAIRequest => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    stream: true,
    stream_options: { include_usage: true },
    ...extra
  })
  const details = (status: number, body: unknown) => parseUpstreamError(status, JSON.stringify(body))

  it('drops fields the upstream does not know (OpenAI param, Gemini "Unknown name", pydantic extra_forbidden)', () => {
    const gem = details(400, [{ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "stream_options": Cannot find field.' } }])
    const a = adaptationForError(payload(), 400, gem)
    expect(a).toEqual({ kind: 'drop', field: 'stream_options' })
    const p = payload()
    expect(applyAdaptation(p, a!)).toBe(true)
    expect(p.stream_options).toBeUndefined()
    expect(applyAdaptation(p, a!)).toBe(false)

    const par = details(400, { error: { message: 'Invalid JSON payload received. Unknown name "parallel_tool_calls": Cannot find field.' } })
    expect(adaptationForError(payload({ parallel_tool_calls: false }), 400, par)).toEqual({ kind: 'drop', field: 'parallel_tool_calls' })

    const fastapi = details(422, { detail: [{ loc: ['body', 'reasoning_effort'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] })
    expect(adaptationForError(payload({ reasoning_effort: 'high' }), 422, fastapi)).toEqual({ kind: 'drop', field: 'reasoning_effort' })

    const temp = details(400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", param: 'temperature', code: 'unsupported_value' } })
    expect(adaptationForError(payload({ temperature: 0.2 }), 400, temp)).toEqual({ kind: 'drop', field: 'temperature' })
  })

  it('switches between max_tokens and max_completion_tokens, and caps output to the stated limit', () => {
    const openai = details(400, {
      error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens', code: 'unsupported_parameter' }
    })
    const rename = adaptationForError(payload(), 400, openai)
    expect(rename).toEqual({ kind: 'rename-max-tokens', to: 'max_completion_tokens' })
    const p = payload()
    applyAdaptation(p, rename!)
    expect([p.max_tokens, p.max_completion_tokens]).toEqual([undefined, 32000])

    const cap = adaptationForError(p, 400, details(400, { error: { message: 'max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.' } }))
    expect(cap).toEqual({ kind: 'cap-output', value: 16384 })
    applyAdaptation(p, cap!)
    expect(p.max_completion_tokens).toBe(16384)
    expect(describeAdaptation(cap!)).toBe('allows at most 16384 output tokens')
  })

  it('replaces null assistant content when a server insists on strings', () => {
    const p = payload({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'A', arguments: '{}' } }] }] })
    const a = adaptationForError(p, 400, details(400, { error: { message: 'messages.0.content: Input should be a valid string, got null' } }))
    expect(a).toEqual({ kind: 'empty-content' })
    applyAdaptation(p, a!)
    expect(p.messages[0].content).toBe('')
  })

  it('does not adapt unrelated errors or non-400 statuses', () => {
    expect(adaptationForError(payload(), 401, details(401, { error: { message: 'Unknown name "stream_options"' } }))).toBeNull()
    expect(adaptationForError(payload(), 400, details(400, { error: { message: 'Invalid model id' } }))).toBeNull()
    expect(adaptationForError(payload(), 400, details(400, { error: { message: 'Unknown name "foo_bar": Cannot find field.' } }))).toBeNull()
  })

  it('AdaptationMemory remembers fixes per key without duplicates', () => {
    const memory = new AdaptationMemory(2)
    memory.remember('a', { kind: 'drop', field: 'stream_options' })
    memory.remember('a', { kind: 'drop', field: 'stream_options' })
    memory.remember('a', { kind: 'cap-output', value: 10 })
    expect(memory.get('a')).toHaveLength(2)
    memory.remember('b', { kind: 'empty-content' })
    memory.remember('c', { kind: 'empty-content' })
    expect(memory.get('a')).toEqual([])
    memory.clear()
    expect(memory.get('c')).toEqual([])
  })
})
