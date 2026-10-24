/**
 * End-to-end: the real proxy (createProxyApi → node:http on 127.0.0.1) in front of a mock OpenAI upstream,
 * called with fetch exactly like Claude Code calls it.
 */
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProxyApi } from '@shared/api'
import type { ProxyConfig, ProxyLogEntry } from '@shared/types'
import type { CoreContext } from '@core/context'
import { createProxyApi } from '@core/proxy'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { firstTurnVscode, toolResultsWithThinking } from './fixtures'
import { MockUpstream, body, freePort, makeContext, openAiSse, parseSse, sleep, writeInPieces, type UpstreamCall } from './helpers'

const TOKEN = 'cs-test-token-0123456789'
const CLIENT_UA = 'claude-cli/2.1.309 (external, sdk-cli)'
const usage = { prompt_tokens: 5200, completion_tokens: 42, total_tokens: 5242, prompt_tokens_details: { cached_tokens: 4096 } }
const chunkBase = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1761200000, model: 'mock-kimi' }

let sb: Sandbox
let upstream: MockUpstream
let ctx: CoreContext
let api: ProxyApi
let port: number
const extraApis: ProxyApi[] = []

function proxyConfig(patch: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port,
    authToken: TOKEN,
    autoStart: true,
    upstreams: [
      { id: 'mock', name: 'Mock AI', baseUrl: upstream.baseUrl, keyRef: 'proxy:mock', models: ['mock-kimi', 'mock-small'], maxOutputTokens: 16384, reasoning: 'roundtrip' }
    ],
    routes: { 'kimi-k2.5': 'mock/mock-kimi' },
    defaultRoute: 'mock/mock-kimi',
    smallRoute: 'mock/mock-small',
    ...patch
  }
}

function url(path: string, p = port): string {
  return `http://127.0.0.1:${p}${path}`
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': CLIENT_UA,
      'x-claude-code-session-id': 'sess-123',
      'anthropic-version': '2023-06-01',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal
  })
}

const simpleRequest = (patch: Record<string, unknown> = {}) => ({
  model: 'kimi-k2.5',
  max_tokens: 32000,
  messages: [{ role: 'user', content: 'Say hi' }],
  ...patch
})

/** The verified turn-1 stream: reasoning, text, two fragmented parallel tool calls, usage chunk. */
function referenceChunks(): unknown[] {
  const args0 = JSON.stringify({ file_path: 'C:\\proj\\hello.txt' })
  const send = (choices: unknown[], extra: Record<string, unknown> = {}) => ({ ...chunkBase, choices, ...extra })
  return [
    send([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    send([{ index: 0, delta: { reasoning_content: 'User wants the file. ' }, finish_reason: null }]),
    send([{ index: 0, delta: { reasoning_content: 'I will call Read and Glob.' }, finish_reason: null }]),
    send([{ index: 0, delta: { content: 'Let me check' }, finish_reason: null }]),
    send([{ index: 0, delta: { content: ' the files.' }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'Read', arguments: '' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args0.slice(0, 7) } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args0.slice(7) } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def456', type: 'function', function: { name: 'Glob', arguments: '{"pattern":' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ' "*.txt"}' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    send([], { usage })
  ]
}

function jsonCompletion(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-json',
    object: 'chat.completion',
    created: 1,
    model: 'mock-kimi',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
    ...extra
  }
}

function replyJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function streamReference(res: http.ServerResponse, delayMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  await writeInPieces(res, openAiSse(referenceChunks(), { crlf: true, comment: true }), 13, delayMs)
  res.end()
}

beforeEach(async () => {
  sb = await createSandbox()
  upstream = new MockUpstream()
  await upstream.start()
  ctx = await makeContext(sb.dataDir)
  await ctx.secrets.set('proxy:mock', 'sk-upstream-test')
  port = await freePort()
  api = createProxyApi(ctx, { configCheckIntervalMs: 50 })
  await api.saveConfig(proxyConfig())
  const status = await api.start()
  expect(status).toMatchObject({ running: true, port, url: `http://127.0.0.1:${port}` })
})

afterEach(async () => {
  for (const extra of extraApis.splice(0)) await extra.stop().catch(() => undefined)
  await api.stop()
  await upstream.close()
  await sb.cleanup()
})

describe('proxy server: routes and auth', () => {
  it('serves HEAD and /health without a token, everything else only with the token', async () => {
    const head = await fetch(url('/api/hello'), { method: 'HEAD' })
    expect(head.status).toBe(200)
    const health = await body(fetch(url('/health')))
    expect(health).toMatchObject({ ok: true, app: 'claude-setup-proxy', version: '9.9.9-test', port })

    const anonymous = await fetch(url('/v1/models'))
    expect(anonymous.status).toBe(401)
    expect(await body(anonymous)).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Missing or wrong Claude Setup proxy token. Re-apply the model in Claude Setup so Claude Code gets the current token.'
      }
    })
    expect((await post('/v1/messages', simpleRequest(), { authorization: 'Bearer wrong-token' })).status).toBe(401)
    expect(upstream.calls).toHaveLength(0)

    const viaApiKey = await fetch(url('/v1/models?limit=1000'), { headers: { 'x-api-key': TOKEN } })
    expect(viaApiKey.status).toBe(200)
    const unknown = await fetch(url('/v2/whatever'), { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(unknown.status).toBe(404)
    expect((await body(unknown)).error.type).toBe('not_found_error')
  })

  it('lists routed models in Anthropic shape and estimates count_tokens', async () => {
    const models = await body(fetch(url('/v1/models?limit=1000'), { headers: { authorization: `Bearer ${TOKEN}` } }))
    expect(models.has_more).toBe(false)
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(['kimi-k2.5', 'mock/mock-kimi', 'mock/mock-small'])
    expect(models.data[0]).toMatchObject({ type: 'model', id: 'kimi-k2.5', display_name: 'kimi-k2.5 (Mock AI: mock-kimi)' })
    expect(models.first_id).toBe('kimi-k2.5')
    expect(models.last_id).toBe('mock/mock-small')
    const one = await fetch(url('/v1/models/kimi-k2.5'), { headers: { authorization: `Bearer ${TOKEN}` } })
    expect((await body(one)).id).toBe('kimi-k2.5')

    const count = await post('/v1/messages/count_tokens?beta=true', firstTurnVscode)
    expect(count.status).toBe(200)
    const { input_tokens } = await body(count)
    expect(input_tokens).toBeGreaterThan(500)
    expect(upstream.calls).toHaveLength(0)
  })

  it('rejects oversized and malformed bodies', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(40 * 1024 * 1024) } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.write('{"model":')
    })
    expect(status).toBe(413)
    const bad = await post('/v1/messages', '{not json')
    expect(bad.status).toBe(400)
    expect((await body(bad)).error.message).toBe('The request body is not valid JSON.')
    const noMessages = await post('/v1/messages', { model: 'x' })
    expect(noMessages.status).toBe(400)
  })
})

describe('proxy server: translation end to end', () => {
  it('streams a tool-calling turn: verified event order, fragments buffered, usage from the upstream', async () => {
    upstream.handler = (_call, res) => streamReference(res, 1)
    const res = await post('/v1/messages?beta=true', firstTurnVscode)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = parseSse(await res.text())
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[0].data.message.model).toBe('kimi-k2.5')
    expect(events[0].data.message.usage.input_tokens).toBeGreaterThan(0)
    expect(events[10].data.content_block).toEqual({ type: 'tool_use', id: 'call_abc123', name: 'Read', input: {} })
    expect(JSON.parse(events[11].data.delta.partial_json)).toEqual({ file_path: 'C:\\proj\\hello.txt' })
    expect(JSON.parse(events[14].data.delta.partial_json)).toEqual({ pattern: '*.txt' })
    expect(events[16].data).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 1104, output_tokens: 42, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 }
    })

    const call = upstream.calls[0]
    expect(call.method).toBe('POST')
    expect(call.url).toBe('/v1/chat/completions')
    expect(call.headers.authorization).toBe('Bearer sk-upstream-test')
    expect(call.headers['user-agent']).toBe(CLIENT_UA)
    expect(call.headers['x-claude-code-session-id']).toBe('sess-123')
    expect(call.headers['x-api-key']).toBeUndefined()
    expect(JSON.stringify(call.headers)).not.toContain(TOKEN)
    expect(JSON.stringify(call.body)).not.toContain(TOKEN)
    expect(call.body).toMatchObject({ model: 'mock-kimi', max_tokens: 16384, stream: true, stream_options: { include_usage: true } })
    expect(JSON.stringify(call.body)).not.toContain('cache_control')
    expect(call.body.messages[0].role).toBe('system')
  })

  it('round-trips reasoning_content and tool results on the next turn (non-streaming)', async () => {
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('All done: file says hello.'))
    const res = await post('/v1/messages', { ...toolResultsWithThinking, stream: false })
    expect(res.status).toBe(200)
    const message = await body(res)
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'kimi-k2.5',
      content: [{ type: 'text', text: 'All done: file says hello.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    })
    const sent = upstream.calls[0].body
    expect(sent.stream).toBeUndefined()
    const assistant = sent.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistant.reasoning_content).toBe('I should read the file first.')
    expect(sent.messages.filter((m: { role: string }) => m.role === 'tool')).toHaveLength(2)
  })

  it('routes haiku/background requests to the small model and explicit names to their upstream', async () => {
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('ok'))
    await post('/v1/messages', simpleRequest({ model: 'claude-haiku-4-5-20251001' }))
    await post('/v1/messages', simpleRequest({ model: 'mock/some-other-model' }))
    await post('/v1/messages', simpleRequest({ model: 'anything-else[1m]' }))
    expect(upstream.calls.map((c) => c.body.model)).toEqual(['mock-small', 'some-other-model', 'mock-kimi'])
  })

  it('replays a JSON upstream answer as SSE, and collects an SSE answer into JSON', async () => {
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('from json'))
    const streamed = parseSse(await (await post('/v1/messages', simpleRequest({ stream: true }))).text())
    expect(streamed.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(streamed[2].data.delta).toEqual({ type: 'text_delta', text: 'from json' })

    upstream.handler = (_call, res) => streamReference(res)
    const collected = await body(post('/v1/messages', simpleRequest({ stream: false })))
    expect(collected.content.map((b: { type: string }) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use'])
    expect(collected.stop_reason).toBe('tool_use')
    expect(collected.usage).toMatchObject({ input_tokens: 1104, cache_read_input_tokens: 4096 })
  })

  it('reuses the upstream connection across requests (keep-alive), also after [DONE]', async () => {
    let n = 0
    upstream.handler = (_call, res) => {
      n++
      if (n % 2) return streamReference(res)
      replyJson(res, 200, jsonCompletion('ok'))
    }
    for (let i = 0; i < 4; i++) {
      const res = await post('/v1/messages', simpleRequest({ stream: i % 2 === 0 }))
      expect(res.status).toBe(200)
      await res.text()
      await sleep(20)
    }
    expect(upstream.calls).toHaveLength(4)
    expect(upstream.connections).toBe(1)
  })

  it('sends pings while the upstream is quiet', async () => {
    await api.stop()
    const pinging = createProxyApi(ctx, { pingIntervalMs: 20 })
    extraApis.push(pinging)
    await pinging.start()
    upstream.handler = async (_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(openAiSse([{ choices: [{ delta: { content: 'thinking hard' } }] }], { done: false }))
      await sleep(250)
      res.end(openAiSse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    }
    const events = parseSse(await (await post('/v1/messages', simpleRequest({ stream: true }))).text())
    const pings = events.filter((e) => e.event === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(3)
    expect(pings[0].data).toEqual({ type: 'ping' })
    expect(events.at(-1)?.event).toBe('message_stop')
  })
})

describe('proxy server: failures', () => {
  it('maps upstream context errors to the wording Claude Code recognizes', async () => {
    upstream.handler = (_call, res) =>
      replyJson(res, 400, {
        error: {
          message:
            "This model's maximum context length is 131072 tokens. However, you requested 152000 tokens (120000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.",
          type: 'invalid_request_error',
          param: 'messages',
          code: 'context_length_exceeded'
        }
      })
    const res = await post('/v1/messages', simpleRequest({ stream: true }))
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await body(res)).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'input length and `max_tokens` exceed context limit: 120000 + 32000 > 131072, decrease input length or `max_tokens` and try again'
      }
    })
  })

  it('turns 5xx into 529 overloaded and forwards integer retry-after on 429', async () => {
    upstream.handler = (_call, res) => replyJson(res, 503, { error: { message: 'Service Unavailable' } })
    const overloaded = await post('/v1/messages', simpleRequest())
    expect(overloaded.status).toBe(529)
    expect((await body(overloaded)).error).toEqual({ type: 'overloaded_error', message: 'Service Unavailable' })

    upstream.handler = (_call, res) => replyJson(res, 429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '7', 'x-should-retry': 'true' })
    const limited = await post('/v1/messages', simpleRequest())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('7')
    expect(limited.headers.get('x-should-retry')).toBe('true')
    expect((await body(limited)).error.type).toBe('rate_limit_error')
  })

  it('a dropped upstream stream becomes an SSE error event with the open block left open', async () => {
    upstream.handler = async (_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(openAiSse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial answer that will be cut' } }] }], { done: false }))
      await sleep(50)
      res.socket?.destroy()
    }
    const events = parseSse(await (await post('/v1/messages', simpleRequest({ stream: true }))).text())
    expect(events.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error'])
    expect(events[3].data).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'The connection to Mock AI was interrupted during the response.' } })
    const status = await api.status()
    expect(status.errors).toBeGreaterThanOrEqual(1)
    expect(status.lastError).toMatch(/interrupted/)
  })

  it('a mid-stream error chunk becomes an SSE error event', async () => {
    upstream.handler = (_call, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(openAiSse([{ choices: [{ delta: { content: 'hi' } }] }, { error: { message: 'Upstream exploded', type: 'server_error' } }]))
    }
    const events = parseSse(await (await post('/v1/messages', simpleRequest({ stream: true }))).text())
    expect(events.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Upstream exploded' } } })
    expect(events.some((e) => e.event === 'message_stop')).toBe(false)
  })

  it('retries without a field the upstream rejects, and remembers it for later requests', async () => {
    upstream.handler = (call, res) => {
      if (call.body.stream_options) return replyJson(res, 400, [{ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "stream_options": Cannot find field.' } }])
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(openAiSse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
    }
    const first = parseSse(await (await post('/v1/messages', simpleRequest({ stream: true }))).text())
    expect(first.at(-1)?.event).toBe('message_stop')
    expect(upstream.calls.map((c) => Boolean(c.body.stream_options))).toEqual([true, false])
    await post('/v1/messages', simpleRequest({ stream: true })).then((r) => r.text())
    expect(upstream.calls.map((c) => Boolean(c.body.stream_options))).toEqual([true, false, false])
    const logs = await api.logs()
    expect(logs.some((e) => e.level === 'warn' && /does not accept "stream_options"/.test(e.message))).toBe(true)
  })

  it('explains missing routes and missing keys, and reports unreachable upstreams', async () => {
    await api.saveConfig(proxyConfig({ defaultRoute: undefined, smallRoute: undefined }))
    const noRoute = await post('/v1/messages', simpleRequest({ model: 'claude-sonnet-5-5' }))
    expect(noRoute.status).toBe(404)
    expect((await body(noRoute)).error.message).toBe('No proxy route is set up for the model "claude-sonnet-5-5". Open Claude Setup → Proxy and choose a default model.')

    await ctx.secrets.delete('proxy:mock')
    const noKey = await post('/v1/messages', simpleRequest())
    expect(noKey.status).toBe(401)
    expect((await body(noKey)).error.message).toBe('No API key is saved for Mock AI. Add it in Claude Setup → Proxy.')

    await ctx.secrets.set('proxy:mock', 'sk-upstream-test')
    const closedPort = await freePort()
    await api.saveConfig(proxyConfig({ upstreams: [{ ...proxyConfig().upstreams[0], baseUrl: `http://127.0.0.1:${closedPort}/v1` }] }))
    const unreachable = await post('/v1/messages', simpleRequest())
    expect(unreachable.status).toBe(529)
    expect((await body(unreachable)).error.message).toBe(`127.0.0.1:${closedPort} refused the connection. Check that Mock AI is reachable and its base URL is correct.`)
  })

  it('a web page instead of an API answer is reported as a base-URL problem', async () => {
    upstream.handler = (_call, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body>Welcome</body></html>')
    }
    const res = await post('/v1/messages', simpleRequest())
    expect(res.status).toBe(400)
    expect((await body(res)).error.message).toMatch(/answered with a web page instead of an API response/)
  })

  it('cancelling the client request aborts the upstream request', async () => {
    let upstreamCall: UpstreamCall | undefined
    upstream.handler = async (call, res) => {
      upstreamCall = call
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(openAiSse([{ choices: [{ delta: { content: 'starting…' } }] }], { done: false }))
      await sleep(10_000)
      if (!res.destroyed) res.end()
    }
    const controller = new AbortController()
    const res = await post('/v1/messages', simpleRequest({ stream: true }), {}, controller.signal)
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => undefined)
    await Promise.race([
      upstreamCall!.closed,
      sleep(3000).then(() => {
        throw new Error('upstream request was not aborted')
      })
    ])
    await sleep(50)
    const logs = await api.logs()
    expect(logs.some((e) => e.status === 499)).toBe(true)
  })
})

describe('proxy lifecycle', () => {
  it('logs every request with model, upstream, status and duration, and emits proxy events', async () => {
    const events: ProxyLogEntry[] = []
    const off = ctx.events.on('proxy', (entry) => events.push(entry))
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('ok'))
    await post('/v1/messages', simpleRequest())
    off()
    const entry = (await api.logs(10)).at(-1)!
    expect(entry).toMatchObject({ level: 'info', model: 'kimi-k2.5', upstream: 'Mock AI (mock-kimi)', status: 200 })
    expect(typeof entry.ms).toBe('number')
    expect(entry.message).toBe('non-stream → Mock AI (mock-kimi) · end_turn')
    expect(events.at(-1)).toEqual(entry)
    const status = await api.status()
    expect(status).toMatchObject({ running: true, requests: 1, errors: 0 })
    expect(status.startedAt).toBeTruthy()
  })

  it('start() is idempotent and stop() frees the port', async () => {
    const again = await Promise.all([api.start(), api.start()])
    expect(again.every((s) => s.running && s.port === port && !s.external)).toBe(true)
    const stopped = await api.stop()
    expect(stopped).toMatchObject({ running: false, port })
    await expect(fetch(url('/health'))).rejects.toThrow()
    expect((await api.start()).running).toBe(true)
  })

  it('detects a proxy already running in another process instead of starting a second one', async () => {
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('ok'))
    await post('/v1/messages', simpleRequest())
    const otherCtx = await makeContext(sb.dataDir)
    const other = createProxyApi(otherCtx)
    extraApis.push(other)
    const status = await other.start()
    expect(status).toMatchObject({ running: true, external: true, port, url: `http://127.0.0.1:${port}`, requests: 1, errors: 0 })
    expect((await other.status()).external).toBe(true)
    const remoteLogs = await other.logs()
    expect(remoteLogs.some((e) => e.model === 'kimi-k2.5' && e.status === 200)).toBe(true)
    // Stopping from the other process must not stop this one.
    const afterStop = await other.stop()
    expect(afterStop.external).toBe(true)
    expect((await fetch(url('/health'))).status).toBe(200)
  })

  it('picks up config saved by another process without a restart', async () => {
    upstream.handler = (_call, res) => replyJson(res, 200, jsonCompletion('ok'))
    const otherCtx = await makeContext(sb.dataDir)
    const other = createProxyApi(otherCtx)
    extraApis.push(other)
    await other.saveConfig(proxyConfig({ routes: { 'kimi-k2.5': 'mock/mock-kimi', 'brand-new': 'mock/mock-new' } }))
    await sleep(150)
    const res = await post('/v1/messages', simpleRequest({ model: 'brand-new' }))
    expect(res.status).toBe(200)
    expect(upstream.calls.at(-1)?.body.model).toBe('mock-new')
    // The API of this process sees the same fresh configuration (so the app never re-saves a stale copy).
    expect((await api.getConfig()).routes['brand-new']).toBe('mock/mock-new')
  })

  it('reports a friendly error when another program owns the port', async () => {
    await api.stop()
    const foreign = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', () => resolve()))
    try {
      const status = await api.start()
      expect(status.running).toBe(false)
      expect(status.external).toBeUndefined()
      expect(status.lastError).toMatch(new RegExp(`^Port ${port} is already used by another program\\. Choose another port in Proxy settings`))
      expect((await api.status()).running).toBe(false)
    } finally {
      foreign.closeAllConnections()
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
    // Once the port is free again, a start succeeds and the old start error is gone.
    const again = await api.start()
    expect(again.running).toBe(true)
    expect(again.lastError).toBeUndefined()
  })

  it('saveConfig validates, persists, and restarts on a port change', async () => {
    await expect(api.saveConfig({ ...proxyConfig(), port: 80 })).rejects.toThrow('The proxy port must be a whole number between 1024 and 65535.')
    await expect(api.saveConfig({ ...proxyConfig(), routes: { x: 'ghost/model' } })).rejects.toThrow(/does not exist/)
    const newPort = await freePort()
    const saved = await api.saveConfig(proxyConfig({ port: newPort }))
    expect(saved.port).toBe(newPort)
    expect(ctx.state.get().proxy.port).toBe(newPort)
    const status = await api.status()
    expect(status).toMatchObject({ running: true, port: newPort })
    expect((await fetch(url('/health', newPort))).status).toBe(200)
    await expect(fetch(url('/health'))).rejects.toThrow()
    expect((await api.getConfig()).port).toBe(newPort)
  })

  it('creates an access token when the stored one is unusable', async () => {
    await api.stop()
    await ctx.state.update((draft) => {
      draft.proxy = { ...draft.proxy, authToken: '' }
    })
    const status = await api.start()
    expect(status.running).toBe(true)
    const token = (await api.getConfig()).authToken
    expect(token).toMatch(/^cs-[0-9a-f]{32}$/)
    const res = await fetch(url('/v1/models'), { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })
})
