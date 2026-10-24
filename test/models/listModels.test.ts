import { afterEach, describe, expect, it, vi } from 'vitest'
import { listModels, mergeModels, parseModelList, resolveListUrl } from '@core/models/listModels'
import { saveProfile } from '@core/models/profiles'
import { findProvider } from '@core/models/providers'
import { withSandbox } from '../helpers/sandbox'
import { makeContext } from './helpers'

type FetchArgs = [string, RequestInit | undefined]

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const headersOf = (call: FetchArgs) => (call[1]?.headers ?? {}) as Record<string, string>

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listModels', () => {
  it('normalizes an OpenAI-shaped list and merges it with the preset (Moonshot)', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch(() =>
        json({
          object: 'list',
          data: [
            { id: 'kimi-k3', object: 'model', context_length: 1048576, supports_image_in: true },
            { id: 'kimi-k3.1-pro', object: 'model', context_length: 1048576, supports_reasoning: true },
            { id: 'kimi-new-model', object: 'model', context_length: 1048576 },
            { id: 'kimi-small', object: 'model', context_length: 131072 },
            { id: 'moonshot-embedding-v2', object: 'model' }
          ]
        })
      )
      const models = await listModels(ctx, { providerId: 'moonshot', apiKey: 'sk-test' })
      const call = fetch.mock.calls[0] as FetchArgs
      expect(call[0]).toBe('https://api.moonshot.ai/v1/models')
      expect(headersOf(call).authorization).toBe('Bearer sk-test')
      const ids = models.map((m) => m.id)
      expect(ids.slice(0, 3)).toEqual(['kimi-k3[1m]', 'kimi-k3.1-pro[1m]', 'kimi-k3.1-pro-highspeed[1m]'])
      expect(ids).toContain('kimi-new-model[1m]')
      expect(ids).toContain('kimi-small')
      expect(ids).not.toContain('moonshot-embedding-v2')
      expect(models.find((m) => m.id === 'kimi-k3[1m]')?.label).toBe('Kimi K3')
      expect(models.find((m) => m.id === 'kimi-small')?.context).toBe(131072)
    })
  })

  it('uses the region of the profile and its stored key', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'CN', providerId: 'moonshot', regionId: 'china', apiKey: 'cn-key', models: { main: 'kimi-k3[1m]' } })
      const fetch = stubFetch(() => json({ data: [] }))
      const models = await listModels(ctx, { profileId: p.id })
      const call = fetch.mock.calls[0] as FetchArgs
      expect(call[0]).toBe('https://api.moonshot.cn/v1/models')
      expect(headersOf(call).authorization).toBe('Bearer cn-key')
      expect(models.map((m) => m.id)).toEqual(findProvider('moonshot')!.models.map((m) => m.id))
    })
  })

  it('reads Anthropic-shaped lists with x-api-key (MiniMax)', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch(() =>
        json({ data: [{ id: 'MiniMax-M3', type: 'model', display_name: 'MiniMax-M3' }, { id: 'MiniMax-M4-Preview', type: 'model', display_name: 'MiniMax M4 Preview' }], has_more: false })
      )
      const models = await listModels(ctx, { providerId: 'minimax', apiKey: 'mm-key' })
      const call = fetch.mock.calls[0] as FetchArgs
      expect(call[0]).toBe('https://api.minimax.io/anthropic/v1/models?limit=1000')
      expect(headersOf(call)['x-api-key']).toBe('mm-key')
      expect(headersOf(call)['anthropic-version']).toBe('2023-06-01')
      expect(models.find((m) => m.id === 'MiniMax-M4-Preview')?.label).toBe('MiniMax M4 Preview')
    })
  })

  it('reads the native Ollama list', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch(() => json({ models: [{ name: 'qwen3.5:latest', model: 'qwen3.5:latest' }, { name: 'llama4:8b', model: 'llama4:8b' }] }))
      const models = await listModels(ctx, { providerId: 'ollama' })
      expect((fetch.mock.calls[0] as FetchArgs)[0]).toBe('http://localhost:11434/api/tags')
      const ids = models.map((m) => m.id)
      expect(ids[0]).toBe('qwen3.5')
      expect(ids.filter((id) => id.startsWith('qwen3.5'))).toEqual(['qwen3.5'])
      expect(ids).toContain('llama4:8b')
    })
  })

  it('treats Z.ai\'s HTTP 200 + {"code":401} body as a failure and returns the presets', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      stubFetch(() => json({ code: 401, msg: 'token expired or incorrect', success: false }))
      const models = await listModels(ctx, { providerId: 'zai', apiKey: 'bad' })
      expect(models.map((m) => m.id)).toEqual(['glm-5.3[1m]', 'glm-5.3-flash[1m]'])
    })
  })

  it('falls back to the presets on network errors and without a key', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch(() => {
        throw new TypeError('fetch failed')
      })
      expect((await listModels(ctx, { providerId: 'deepseek', apiKey: 'k' })).map((m) => m.id)).toEqual(findProvider('deepseek')!.models.map((m) => m.id))
      fetch.mockClear()
      expect((await listModels(ctx, { providerId: 'deepseek' })).length).toBe(3)
      expect(fetch).not.toHaveBeenCalled()
      expect(await listModels(ctx, { providerId: 'unknown-provider' })).toEqual([])
    })
  })

  it('calls public lists without a key and prefixes Vercel ids for its Claude Code endpoint', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const fetch = stubFetch((url) =>
        url.includes('vercel')
          ? json({
              data: [
                { id: 'moonshotai/kimi-k3', context_window: 1000000, type: 'language' },
                { id: 'zai/glm-5.3', context_window: 1000000, type: 'language' },
                { id: 'openai/text-embedding-3-large', type: 'embedding' }
              ]
            })
          : json({ data: [{ id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', context_length: 1048576 }, { id: 'vendor/model:free', context_length: 8192 }] })
      )
      const vercel = await listModels(ctx, { providerId: 'vercel' })
      expect((fetch.mock.calls[0] as FetchArgs)[0]).toBe('https://ai-gateway.vercel.sh/v1/models')
      expect(headersOf(fetch.mock.calls[0] as FetchArgs).authorization).toBeUndefined()
      const vIds = vercel.map((m) => m.id)
      expect(vIds.filter((id) => id.includes('kimi-k3[1m]') && !id.includes('fast'))).toEqual(['claude-code/moonshotai/kimi-k3[1m]'])
      expect(vIds).toContain('claude-code/zai/glm-5.3[1m]')
      expect(vIds.some((id) => id.includes('embedding'))).toBe(false)

      const or = await listModels(ctx, { providerId: 'openrouter' })
      expect(or[0].id).toBe('z-ai/glm-5.3[1m]')
      expect(or.map((m) => m.id)).toContain('vendor/model:free')
    })
  })
})

describe('model list parsing', () => {
  it('handles every shape and rejects error bodies', () => {
    expect(parseModelList({ data: [{ id: 'a', display_name: 'A' }] })).toEqual([{ id: 'a', label: 'A' }])
    expect(parseModelList({ object: 'list', data: [{ id: 'b', context_window: 1000, input_modalities: ['text', 'image'] }] })).toEqual([
      { id: 'b', context: 1000, vision: true }
    ])
    expect(parseModelList({ models: [{ name: 'c:latest' }] })).toEqual([{ id: 'c:latest' }])
    expect(parseModelList(['d', 'e'])).toEqual([{ id: 'd' }, { id: 'e' }])
    expect(parseModelList({ data: [{ id: 'models/gemini-4-argon', top_provider: { context_length: 1048576 } }] })).toEqual([
      { id: 'gemini-4-argon', context: 1048576 }
    ])
    expect(parseModelList({ code: 401, msg: 'no', success: false })).toBeNull()
    expect(parseModelList({ error: { message: 'bad key' } })).toBeNull()
    expect(parseModelList('nope')).toBeNull()
  })

  it('resolves list URLs', () => {
    expect(resolveListUrl('{origin}/v1/models', 'https://api.moonshot.cn/anthropic')).toBe('https://api.moonshot.cn/v1/models')
    expect(resolveListUrl('/v1/models', 'https://api.z.ai/api/anthropic/')).toBe('https://api.z.ai/api/anthropic/v1/models')
    expect(resolveListUrl('https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/models')
  })

  it('never adds [1m] for providers that forbid it', () => {
    const merged = mergeModels(findProvider('siliconflow')!, [{ id: 'deepseek-ai/Big', context: 2_000_000 }])
    expect(merged.map((m) => m.id)).toContain('deepseek-ai/Big')
  })
})
