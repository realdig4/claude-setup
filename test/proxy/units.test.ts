import { describe, expect, it } from 'vitest'
import type { ProxyConfig } from '@shared/types'
import { ProxyConfigError, sanitizeProxyConfig, validateProxyConfig } from '@core/proxy/config'
import { ProxyLogBook } from '@core/proxy/logbook'
import { ToolNameMapper } from '@core/proxy/names'
import { detectQuirks } from '@core/proxy/quirks'
import { listRoutedModels, normalizeModelName, parseRouteTarget, resolveRoute } from '@core/proxy/router'
import { chatCompletionsUrl } from '@core/proxy/messages'
import { tokensMatch } from '@core/proxy/server'
import { estimateRequestTokens, estimateTextTokens } from '@core/proxy/tokens'
import { cleanToolSchema } from '@core/proxy/translate/schema'

const TOKEN = 'cs-0123456789abcdef'

function config(extra: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 3460,
    authToken: TOKEN,
    autoStart: true,
    upstreams: [
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRef: 'proxy:openai', models: ['gpt-5.1', 'gpt-5-mini'] },
      { id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['moonshotai/kimi-k2'] }
    ],
    routes: { 'kimi-k2.5': 'or/moonshotai/kimi-k2', Fast: 'openai/gpt-5-mini' },
    defaultRoute: 'openai/gpt-5.1',
    smallRoute: 'openai/gpt-5-mini',
    ...extra
  }
}

describe('ToolNameMapper', () => {
  it('keeps valid names, sanitizes others, shortens long ones and maps back', () => {
    const names = new ToolNameMapper()
    expect(names.shorten('Read')).toBe('Read')
    expect(names.shorten('mcp.server/tool')).toBe('mcp_server_tool')
    const long = 'x'.repeat(100)
    const short = names.shorten(long)
    expect(short).toHaveLength(64)
    expect(short).toMatch(/^x{55}_[0-9a-f]{8}$/)
    expect(names.shorten(long)).toBe(short)
    expect(names.restore(short)).toBe(long)
    expect(names.restore('mcp_server_tool')).toBe('mcp.server/tool')
    expect(names.restore('unknown')).toBe('unknown')
  })

  it('disambiguates names that sanitize to the same string', () => {
    const names = new ToolNameMapper()
    const a = names.shorten('a.b')
    const b = names.shorten('a_b')
    expect(a).toBe('a_b')
    expect(b).not.toBe(a)
    expect(b).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect([names.restore(a), names.restore(b)]).toEqual(['a.b', 'a_b'])
  })
})

describe('cleanToolSchema', () => {
  const claudeRead = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      file_path: { description: 'path', type: 'string' },
      limit: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 },
      $schema: { type: 'string', description: 'a property that is literally named $schema' }
    },
    required: ['file_path'],
    additionalProperties: false
  }

  it('default flavor strips $schema keywords but not properties named $schema', () => {
    const out = cleanToolSchema(claudeRead)
    expect(out.$schema).toBeUndefined()
    expect((out.properties as Record<string, unknown>).$schema).toEqual({ type: 'string', description: 'a property that is literally named $schema' })
    expect(out.additionalProperties).toBe(false)
    expect((out.properties as Record<string, Record<string, unknown>>).limit.exclusiveMinimum).toBe(0)
    expect(cleanToolSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(cleanToolSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} })
  })

  it('gemini flavor reduces to the OpenAPI subset', () => {
    const out = cleanToolSchema(
      {
        ...claudeRead,
        $defs: { Mode: { type: 'string', enum: ['a', 'b'] } },
        properties: {
          ...claudeRead.properties,
          mode: { $ref: '#/$defs/Mode', description: 'mode' },
          kind: { const: 'fixed' },
          maybe: { type: ['string', 'null'], format: 'uri' },
          when: { type: 'string', format: 'date-time' },
          either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          opt: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          n: { type: 'integer', enum: [1, 2] }
        }
      },
      'gemini'
    )
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(out.additionalProperties).toBeUndefined()
    expect(out.$defs).toBeUndefined()
    expect(props.limit).toEqual({ type: 'integer', minimum: 1, maximum: 9007199254740991 })
    expect(props.mode).toEqual({ type: 'string', enum: ['a', 'b'], description: 'mode' })
    expect(props.kind).toEqual({ enum: ['fixed'], type: 'string' })
    expect(props.maybe).toEqual({ type: 'string', nullable: true })
    expect(props.when).toEqual({ type: 'string', format: 'date-time' })
    expect(props.either).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(props.opt).toEqual({ nullable: true, type: 'integer' })
    expect(props.n).toEqual({ type: 'integer' })
    expect(out.required).toEqual(['file_path'])
  })

  it('gemini flavor survives recursive $ref', () => {
    const node = { type: 'object', properties: { child: { $ref: '#/definitions/Node' } } }
    const out = cleanToolSchema({ type: 'object', properties: { node: { $ref: '#/definitions/Node' } }, definitions: { Node: node } }, 'gemini')
    expect(JSON.stringify(out).length).toBeLessThan(2000)
    expect((out.properties as Record<string, Record<string, unknown>>).node.type).toBe('object')
  })
})

describe('router', () => {
  it('parses route targets whose model contains slashes', () => {
    expect(parseRouteTarget('or/moonshotai/kimi-k2')).toEqual({ upstreamId: 'or', model: 'moonshotai/kimi-k2' })
    expect(parseRouteTarget('nope')).toBeNull()
    expect(parseRouteTarget('/x')).toBeNull()
    expect(parseRouteTarget('x/')).toBeNull()
    expect(normalizeModelName(' kimi-k2.5[1m] ')).toBe('kimi-k2.5')
  })

  it('resolves in order: route, explicit, listed model, haiku → small, default', () => {
    const c = config()
    const pick = (m: string) => {
      const r = resolveRoute(c, m)
      return r.ok ? `${r.via}:${r.upstream.id}/${r.model}` : r.message
    }
    expect(pick('kimi-k2.5')).toBe('route:or/moonshotai/kimi-k2')
    expect(pick('kimi-k2.5[1m]')).toBe('route:or/moonshotai/kimi-k2')
    expect(pick('fast')).toBe('route:openai/gpt-5-mini')
    expect(pick('openai/gpt-4.1')).toBe('explicit:openai/gpt-4.1')
    expect(pick('moonshotai/kimi-k2')).toBe('model:or/moonshotai/kimi-k2')
    expect(pick('gpt-5.1')).toBe('model:openai/gpt-5.1')
    expect(pick('claude-haiku-4-5-20251001')).toBe('small:openai/gpt-5-mini')
    expect(pick('claude-sonnet-5-5')).toBe('default:openai/gpt-5.1')
    expect(pick('')).toBe('default:openai/gpt-5.1')
  })

  it('explains missing routes', () => {
    const r = resolveRoute(config({ defaultRoute: undefined, smallRoute: undefined }), 'claude-haiku-4-5')
    expect(r).toEqual({ ok: false, message: 'No proxy route is set up for the model "claude-haiku-4-5". Open Claude Setup → Proxy and choose a default model.' })
    const dangling = resolveRoute(config({ routes: { a: 'gone/model' } }), 'a')
    expect(dangling.ok).toBe(false)
  })

  it('lists route aliases and upstream models', () => {
    expect(listRoutedModels(config()).map((m) => m.id)).toEqual(['kimi-k2.5', 'Fast', 'openai/gpt-5.1', 'openai/gpt-5-mini', 'or/moonshotai/kimi-k2'])
    expect(listRoutedModels(config())[0].displayName).toBe('kimi-k2.5 (OpenRouter: moonshotai/kimi-k2)')
  })
})

describe('config validation', () => {
  it('normalizes a valid config (trims, dedupes models, strips trailing slashes, keeps unknown keys)', () => {
    const input = {
      ...config(),
      future: 1,
      upstreams: [{ id: ' g ', name: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', models: ['a', ' a ', '', 3], extra: true }],
      routes: { ' x ': ' g/a ' },
      defaultRoute: '',
      smallRoute: undefined
    }
    const out = validateProxyConfig(input)
    expect(out.upstreams[0]).toEqual({ id: 'g', name: 'g', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['a'], extra: true })
    expect(out.routes).toEqual({ x: 'g/a' })
    expect(out.defaultRoute).toBeUndefined()
    expect((out as unknown as Record<string, unknown>).future).toBe(1)
  })

  it('rejects invalid configs with friendly messages', () => {
    const bad = (patch: Record<string, unknown>) => () => validateProxyConfig({ ...config(), ...patch })
    const badUpstream = (patch: Record<string, unknown>) =>
      bad({ upstreams: [{ id: 'a', baseUrl: 'https://x.com/v1', models: [], ...patch }], routes: {}, defaultRoute: undefined, smallRoute: undefined })
    expect(bad({ port: 80 })).toThrow('The proxy port must be a whole number between 1024 and 65535.')
    expect(bad({ port: 70000 })).toThrow(ProxyConfigError)
    expect(bad({ authToken: 'short' })).toThrow(/access token/)
    expect(bad({ authToken: 'has space inside' })).toThrow(/access token/)
    expect(bad({ upstreams: [config().upstreams[0], { ...config().upstreams[1], id: 'OpenAI' }] })).toThrow(/Two upstreams use the id/)
    expect(bad({ upstreams: [{ id: 'a/b', baseUrl: 'https://x.com/v1', models: [] }] })).toThrow(/without spaces or "\/"/)
    expect(bad({ upstreams: [{ id: 'a', baseUrl: 'ftp://x.com', models: [] }] })).toThrow(/must start with http/)
    expect(bad({ routes: { m: 'missing/model' } })).toThrow('The route for "m" uses the upstream "missing", which does not exist.')
    expect(bad({ routes: { m: 'no-slash' } })).toThrow(/must look like/)
    expect(bad({ defaultRoute: 'ghost/x' })).toThrow(/default model uses the upstream "ghost"/)
    expect(badUpstream({ extraHeaders: { Host: 'evil' } })).toThrow(/cannot be used as an extra header/)
    expect(badUpstream({ extraHeaders: { 'X-Ok': 'line\nbreak' } })).toThrow(/single line of text/)
    expect(badUpstream({ maxOutputTokens: 0 })).toThrow(/positive whole number/)
    expect(badUpstream({ reasoning: 'loud' })).toThrow(/reasoning mode/)
    expect(badUpstream({ streamOptions: 'yes' })).toThrow(/must be true or false/)
    expect(badUpstream({ models: 'gpt-5' })).toThrow(/list of model names/)
    expect(badUpstream({ maxEffort: 'ultra' })).toThrow(/maximum reasoning effort/)
    expect(badUpstream({ extraBody: [1] })).toThrow(/must be a JSON object/)
    const ok = validateProxyConfig({ ...config(), upstreams: [{ ...config().upstreams[0], maxEffort: 'xhigh', extraBody: { a: 1 } }, config().upstreams[1]] })
    expect(ok.upstreams[0]).toMatchObject({ maxEffort: 'xhigh', extraBody: { a: 1 } })
  })

  it('sanitize never throws and drops broken parts', () => {
    const out = sanitizeProxyConfig({
      port: 'x',
      authToken: 5,
      upstreams: [{ id: '' }, { id: 'ok', baseUrl: 'http://127.0.0.1:1234/v1' }],
      routes: { a: 'zzz/q', b: 'ok/m' },
      defaultRoute: 7
    })
    expect(out.port).toBe(3460)
    expect(out.authToken).toBe('')
    expect(out.upstreams.map((u) => u.id)).toEqual(['ok'])
    expect(out.routes).toEqual({ b: 'ok/m' })
    expect(out.defaultRoute).toBeUndefined()
    expect(sanitizeProxyConfig(null).upstreams).toEqual([])
  })
})

describe('misc helpers', () => {
  it('chatCompletionsUrl', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1').toString()).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.groq.com/openai/v1/').toString()).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(chatCompletionsUrl('https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2025-01-01').toString()).toBe(
      'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2025-01-01'
    )
    expect(chatCompletionsUrl('https://host/v1?key=1').toString()).toBe('https://host/v1/chat/completions?key=1')
  })

  it('detectQuirks', () => {
    const q = (baseUrl: string, providerId?: string) => detectQuirks({ id: 'u', name: 'u', baseUrl, models: [], providerId }).family
    expect(q('https://api.openai.com/v1')).toBe('openai')
    expect(q('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('gemini')
    expect(q('https://api.groq.com/openai/v1')).toBe('groq')
    expect(q('https://api.cerebras.ai/v1')).toBe('cerebras')
    expect(q('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(q('http://127.0.0.1:8000/v1', 'gemini')).toBe('gemini')
    expect(q('http://127.0.0.1:8000/v1')).toBe('generic')
  })

  it('token estimates', () => {
    expect(estimateTextTokens('abcd'.repeat(10))).toBe(10)
    expect(estimateTextTokens('你好你好你好')).toBe(4)
    const n = estimateRequestTokens({
      system: 'x'.repeat(400),
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'y'.repeat(40) }] }],
      tools: [{ name: 'T', input_schema: {} }, { name: 'Deferred', defer_loading: true }]
    })
    expect(n).toBeGreaterThan(100 + 1500 + 10)
    expect(n).toBeLessThan(100 + 1500 + 10 + 30)
  })

  it('tokensMatch compares in constant time', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
  })

  it('ProxyLogBook keeps the newest 500 entries and counts errors', () => {
    const seen: string[] = []
    const book = new ProxyLogBook((e) => seen.push(e.message))
    for (let i = 0; i < 520; i++) book.add({ level: 'info', message: `m${i}` })
    expect(book.list(1000)).toHaveLength(500)
    expect(book.list(2).map((e) => e.message)).toEqual(['m518', 'm519'])
    expect(book.list(1000)[0].message).toBe('m20')
    expect(seen).toHaveLength(520)
    book.count()
    book.count('bad')
    expect([book.requests, book.errors, book.lastError]).toEqual([2, 1, 'bad'])
  })
})
