import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConnection } from '@core/models/connection'
import { saveProfile } from '@core/models/profiles'
import { withSandbox } from '../helpers/sandbox'
import { makeContext } from './helpers'

type Call = [string, RequestInit | undefined]

function stubFetch(...responses: Array<Response | Error>) {
  const queue = [...responses]
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof Error) throw next
    return next.clone()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (body: string, status: number, type = 'text/plain') => new Response(body, { status, headers: { 'content-type': type } })
const headers = (c: Call) => (c[1]?.headers ?? {}) as Record<string, string>
const body = (c: Call) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>

afterEach(() => {
  vi.unstubAllGlobals()
})

async function run(input: Parameters<typeof testConnection>[1], ...responses: Array<Response | Error>) {
  return withSandbox(async (sb) => {
    const { ctx, logs } = await makeContext(sb)
    const fetch = stubFetch(...responses)
    const result = await testConnection(ctx, input)
    return { result, calls: fetch.mock.calls as Call[], logs }
  })
}

describe('testConnection', () => {
  it('reports ok with a sample and sends a minimal Anthropic request', async () => {
    const { result, calls, logs } = await run(
      { providerId: 'moonshot', apiKey: 'sk-secret', model: 'kimi-k3[1m]' },
      json({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'pong' }] })
    )
    expect(result).toMatchObject({ ok: true, verdict: 'ok', status: 200, sample: 'pong' })
    expect(calls[0][0]).toBe('https://api.moonshot.ai/anthropic/v1/messages')
    expect(calls[0][1]?.method).toBe('POST')
    expect(headers(calls[0]).authorization).toBe('Bearer sk-secret')
    expect(headers(calls[0])['anthropic-version']).toBe('2023-06-01')
    expect(body(calls[0])).toEqual({ model: 'kimi-k3', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    expect(JSON.stringify(logs)).not.toContain('sk-secret')
  })

  it('retries with x-api-key after a 401', async () => {
    const { result, calls } = await run(
      { providerId: 'deepseek', apiKey: 'k', model: 'deepseek-flash' },
      json({ error: { message: 'Authentication Fails' } }, 401),
      json({ type: 'message', content: [{ type: 'text', text: 'hi' }] })
    )
    expect(result.verdict).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(headers(calls[1])['x-api-key']).toBe('k')
    expect(headers(calls[1]).authorization).toBeUndefined()
  })

  it('maps a rejected key to bad-key with a provider hint', async () => {
    const { result, calls } = await run({ providerId: 'moonshot', apiKey: 'k' }, json({ error: { message: 'Invalid Authentication' } }, 401))
    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, verdict: 'bad-key', status: 401 })
    expect(result.message).toMatch(/platform\.kimi\.ai/)
  })

  it('maps Kimi Code keys to x-api-key first', async () => {
    const { calls } = await run({ providerId: 'kimi-code', apiKey: 'kc' }, json({ type: 'message', content: [] }))
    expect(calls[0][0]).toBe('https://api.kimi.ai/coding/v1/messages')
    expect(headers(calls[0])['x-api-key']).toBe('kc')
  })

  it('distinguishes a wrong model from a wrong address', async () => {
    const bad = await run({ providerId: 'zai', apiKey: 'k', model: 'glm-9' }, json({ error: { message: 'Unknown Model, please check the model code: glm-9' } }, 400))
    expect(bad.result.verdict).toBe('bad-model')
    const notFound = await run({ providerId: 'fireworks', apiKey: 'k' }, json({ error: { message: 'Model not found' } }, 404))
    expect(notFound.result.verdict).toBe('bad-model')
    expect(notFound.result.message).toMatch(/checks the model before the key/)
    const url = await run({ providerId: 'custom', baseUrl: 'https://gw.example.com', model: 'm' }, text('Not Found', 404))
    expect(url.result.verdict).toBe('bad-url')
    expect(url.result.message).toMatch(/must not end in \/v1/)
  })

  it('maps quota, HTML pages, network errors and server errors', async () => {
    expect((await run({ providerId: 'deepseek', apiKey: 'k' }, json({ error: { message: 'Insufficient Balance' } }, 402))).result.verdict).toBe('quota')
    expect((await run({ providerId: 'deepseek', apiKey: 'k' }, json({ error: { message: 'Rate limit' } }, 429))).result.verdict).toBe('quota')
    expect((await run({ providerId: 'deepseek', apiKey: 'k' }, text('<!DOCTYPE html><html></html>', 200, 'text/html'))).result.verdict).toBe('bad-url')
    const net = await run({ providerId: 'ollama' }, new TypeError('fetch failed'))
    expect(net.result).toMatchObject({ ok: false, verdict: 'network' })
    expect(net.result.message).toMatch(/Ollama running/)
    expect((await run({ providerId: 'deepseek', apiKey: 'k' }, json({ error: { message: 'overloaded' } }, 529))).result.verdict).toBe('unknown')
  })

  it("treats Z.ai's HTTP 200 + {code:401} as a bad key", async () => {
    const { result } = await run({ providerId: 'zai', apiKey: 'k' }, json({ code: 401, msg: 'token expired or incorrect', success: false }))
    expect(result.verdict).toBe('bad-key')
  })

  it('counts a thinking-only model error as a working connection', async () => {
    const { result } = await run(
      { providerId: 'moonshot', apiKey: 'k', model: 'kimi-k2.7-code' },
      json({ error: { message: 'invalid thinking: only type=enabled is allowed for this model' } }, 400)
    )
    expect(result).toMatchObject({ ok: true, verdict: 'ok' })
  })

  it('tests OpenAI-only providers directly at /chat/completions', async () => {
    const groq = await run({ providerId: 'groq', apiKey: 'gsk' }, json({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
    expect(groq.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(headers(groq.calls[0]).authorization).toBe('Bearer gsk')
    expect(body(groq.calls[0])).toMatchObject({ model: 'openai/gpt-oss-120b', max_tokens: 16, stream: false })
    expect(groq.result).toMatchObject({ ok: true, verdict: 'ok', sample: 'pong' })

    const openai = await run({ providerId: 'openai', apiKey: 'sk' }, json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))
    expect(body(openai.calls[0])).toMatchObject({ model: 'gpt-6.1-sol', max_completion_tokens: 16 })
    expect(openai.result.verdict).toBe('ok')

    const retry = await run(
      { providerId: 'gemini', apiKey: 'AIza' },
      json({ error: { message: "Unsupported parameter: 'max_tokens'" } }, 400),
      json({ choices: [{ message: { content: 'ok' } }] })
    )
    expect(retry.calls).toHaveLength(2)
    expect(body(retry.calls[1])).toHaveProperty('max_completion_tokens', 16)
    expect(retry.result.verdict).toBe('ok')
  })

  it('uses the profile key and handles setups that cannot be tested', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch(json({ type: 'message', content: [{ type: 'text', text: 'yo' }] }))
      const p = await saveProfile(ctx, { name: 'P', providerId: 'minimax', regionId: 'china', apiKey: 'mm', models: { main: 'MiniMax-M3.1-Flash[1m]' } })
      const r = await testConnection(ctx, { profileId: p.id })
      expect(r.ok).toBe(true)
      const call = fetch.mock.calls[0] as Call
      expect(call[0]).toBe('https://api.minimax.cn/anthropic/v1/messages')
      expect(headers(call).authorization).toBe('Bearer mm')
      expect(body(call).model).toBe('MiniMax-M3.1-Flash')

      fetch.mockClear()
      expect((await testConnection(ctx, { providerId: 'bedrock' })).verdict).toBe('unknown')
      expect((await testConnection(ctx, { providerId: 'anthropic' })).ok).toBe(true)
      expect((await testConnection(ctx, { providerId: 'openai' })).verdict).toBe('bad-key')
      expect((await testConnection(ctx, { providerId: 'custom', model: 'x' })).verdict).toBe('bad-url')
      expect((await testConnection(ctx, { providerId: 'litellm' })).verdict).toBe('bad-model')
      expect(fetch).not.toHaveBeenCalled()
    })
  })
})
