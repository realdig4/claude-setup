import { describe, expect, it } from 'vitest'
import type { ProviderPreset, ProxyConfig } from '@shared/types'
import {
  baseUrlError,
  configFromDraft,
  draftFromConfig,
  draftIssues,
  filterLogs,
  headerError,
  isDraftDirty,
  issueCount,
  logTime,
  maxTokensError,
  newRouteRow,
  parseExtraBody,
  parseModelList,
  parseRouteTarget,
  portError,
  removeUpstream,
  renameUpstream,
  routeChoices,
  routesUsing,
  slugId,
  statusTone,
  tokenError,
  upstreamFromPreset,
  upstreamIdError,
  upstreamKeyRef
} from '../../src/renderer/src/pages/proxy/logic'

const config: ProxyConfig = {
  port: 3460,
  authToken: 'cs-0123456789abcdef',
  upstreams: [
    { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRef: 'proxy:groq', models: ['gpt-oss-120b', 'gpt-oss-20b'], reasoning: 'effort' },
    { id: 'local', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', models: ['qwen/qwen3'] }
  ],
  routes: { 'claude-sonnet-5-5': 'groq/gpt-oss-120b', 'claude-haiku-5-5': 'groq/gpt-oss-20b' },
  defaultRoute: 'groq/gpt-oss-120b',
  smallRoute: 'groq/gpt-oss-20b',
  autoStart: true
}

describe('pages-b/proxy: draft', () => {
  it('round-trips a config through the editable draft', () => {
    const draft = draftFromConfig(config)
    expect(draft.port).toBe('3460')
    expect(draft.routes.map((r) => [r.alias, r.target])).toEqual([
      ['claude-sonnet-5-5', 'groq/gpt-oss-120b'],
      ['claude-haiku-5-5', 'groq/gpt-oss-20b']
    ])
    expect(configFromDraft(draft, config)).toEqual(config)
    expect(isDraftDirty(draft, config)).toBe(false)
    expect(isDraftDirty({ ...draft, port: '3461' }, config)).toBe(true)
  })

  it('keeps unknown keys, drops empty routes and optional routes', () => {
    const base = { ...config, futureField: 1 } as ProxyConfig & { futureField: number }
    const draft = { ...draftFromConfig(base), defaultRoute: '', smallRoute: ' ', routes: [newRouteRow(' ', 'x'), newRouteRow(' a ', ' groq/m ')] }
    const out = configFromDraft(draft, base) as ProxyConfig & { futureField?: number }
    expect(out.futureField).toBe(1)
    expect(out.routes).toEqual({ a: 'groq/m' })
    expect('defaultRoute' in out).toBe(false)
    expect('smallRoute' in out).toBe(false)
  })

  it('renames and removes upstreams everywhere they are used', () => {
    const draft = draftFromConfig(config)
    const renamed = renameUpstream(draft, 'groq', 'groq2')
    expect(renamed.routes.every((r) => r.target.startsWith('groq2/'))).toBe(true)
    expect(renamed.defaultRoute).toBe('groq2/gpt-oss-120b')
    expect(renamed.smallRoute).toBe('groq2/gpt-oss-20b')
    expect(renameUpstream(draft, 'groq', 'groq')).toBe(draft)
    expect(routesUsing(draft, 'groq')).toBe(4)
    const removed = removeUpstream(draft, 'groq')
    expect(removed.upstreams.map((u) => u.id)).toEqual(['local'])
    expect(removed.routes).toEqual([])
    expect(removed.defaultRoute).toBe('')
    expect(removed.smallRoute).toBe('')
  })
})

describe('pages-b/proxy: validation', () => {
  it('parses route targets like the core', () => {
    expect(parseRouteTarget('groq/openai/gpt-oss-120b')).toEqual({ upstreamId: 'groq', model: 'openai/gpt-oss-120b' })
    expect(parseRouteTarget('/x')).toBeNull()
    expect(parseRouteTarget('groq/')).toBeNull()
    expect(parseRouteTarget('nothing')).toBeNull()
  })

  it('checks single fields', () => {
    expect(portError('3460')).toBeUndefined()
    expect(portError('80')).toMatch(/1024/)
    expect(portError('34.5')).toMatch(/whole/)
    expect(tokenError('cs-12345')).toBeUndefined()
    expect(tokenError('short')).toMatch(/8/)
    expect(tokenError('has space inside')).toMatch(/spaces/)
    expect(upstreamIdError('groq')).toBeUndefined()
    expect(upstreamIdError('a/b')).toBeDefined()
    expect(upstreamIdError('')).toBeDefined()
    expect(baseUrlError('https://api.openai.com/v1')).toBeUndefined()
    expect(baseUrlError('ftp://x')).toBeDefined()
    expect(baseUrlError('nope')).toBeDefined()
    expect(maxTokensError('')).toBeUndefined()
    expect(maxTokensError('32768')).toBeUndefined()
    expect(maxTokensError('0')).toBeDefined()
    expect(headerError('X-Org', 'acme')).toBeUndefined()
    expect(headerError('Host', 'x')).toMatch(/can’t/)
    expect(headerError('Bad Header', 'x')).toBeDefined()
    expect(headerError('X-Ok', 'a\nb')).toMatch(/single line/)
  })

  it('parses extra body JSON and model lists', () => {
    expect(parseExtraBody('')).toEqual({})
    expect(parseExtraBody('{"temperature":0.2}')).toEqual({ value: { temperature: 0.2 } })
    expect(parseExtraBody('{"error":"text"}')).toEqual({ value: { error: 'text' } })
    expect(parseExtraBody('[1]').error).toMatch(/object/)
    expect(parseExtraBody('{oops').error).toMatch(/valid JSON/)
    expect(parseModelList(' a\nb, c\n\na ')).toEqual(['a', 'b', 'c'])
  })

  it('reports every problem in a draft', () => {
    const draft = draftFromConfig(config)
    expect(issueCount(draftIssues(draft))).toBe(0)
    const broken = {
      ...draft,
      port: '22',
      authToken: 'x',
      upstreams: [...draft.upstreams, { ...draft.upstreams[0]!, name: 'Copy' }, { id: 'bad id', name: 'Bad', baseUrl: 'x', models: [] }],
      routes: [newRouteRow('claude-opus-5-5', 'missing/model'), newRouteRow('dup', 'groq/a'), newRouteRow('dup', 'groq/b'), newRouteRow('', 'groq/a'), newRouteRow('', '')],
      defaultRoute: 'nope',
      smallRoute: 'ghost/x'
    }
    const issues = draftIssues(broken)
    expect(issues.port).toBeDefined()
    expect(issues.authToken).toBeDefined()
    expect(Object.keys(issues.upstreams)).toEqual(['2', '3'])
    expect(issues.upstreams[2]).toMatch(/Two upstreams/)
    expect(Object.values(issues.routes)).toHaveLength(3)
    expect(issues.defaultRoute).toMatch(/upstream\/model/)
    expect(issues.smallRoute).toMatch(/ghost/)
    expect(issueCount(issues)).toBe(2 + 2 + 3 + 2)
  })
})

describe('pages-b/proxy: presets and logs', () => {
  it('creates upstreams from provider presets with unique ids', () => {
    const groq: ProviderPreset = {
      id: 'groq',
      name: 'Groq',
      vendor: 'Groq',
      description: '',
      kind: 'openai-proxy',
      color: '#F55036',
      monogram: 'G',
      regions: [{ id: 'default', label: 'Groq API', baseUrl: 'https://api.groq.com/openai/v1' }],
      authEnv: 'ANTHROPIC_AUTH_TOKEN',
      requiresKey: true,
      models: [
        { id: 'gpt-oss-120b', label: '120B' },
        { id: 'gpt-oss-120b[1m]', label: 'dup' }
      ],
      defaults: { main: 'gpt-oss-120b' },
      tags: [],
      notes: []
    }
    const upstream = upstreamFromPreset(groq, ['groq'])
    expect(upstream).toMatchObject({ id: 'groq-2', name: 'Groq', providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', reasoning: 'off', streamOptions: true })
    expect(upstream.models).toEqual(['gpt-oss-120b'])
    expect(slugId('My Server!', [])).toBe('my-server')
    expect(slugId('', [])).toBe('upstream')
    expect(upstreamKeyRef({ id: 'x' })).toBe('proxy:x')
    expect(upstreamKeyRef({ id: 'x', keyRef: 'profile:abc' })).toBe('profile:abc')
  })

  it('offers route choices, labelling upstreams when there are several', () => {
    expect(routeChoices([config.upstreams[0]!]).map((c) => c.label)).toEqual(['gpt-oss-120b', 'gpt-oss-20b'])
    const both = routeChoices(config.upstreams)
    expect(both.map((c) => c.value)).toEqual(['groq/gpt-oss-120b', 'groq/gpt-oss-20b', 'local/qwen/qwen3'])
    expect(both[2]?.label).toBe('vLLM: qwen/qwen3')
  })

  it('filters and formats log entries', () => {
    const logs = [
      { time: '2026-10-23T21:41:07.000Z', level: 'info' as const, message: 'ok' },
      { time: '2026-10-23T21:41:08.000Z', level: 'warn' as const, message: 'slow' },
      { time: '2026-10-23T21:41:09.000Z', level: 'error' as const, message: 'bad' }
    ]
    expect(filterLogs(logs, 'all')).toHaveLength(3)
    expect(filterLogs(logs, 'warn').map((l) => l.message)).toEqual(['slow', 'bad'])
    expect(filterLogs(logs, 'error').map((l) => l.message)).toEqual(['bad'])
    expect(logTime('2026-10-23T21:41:07.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(logTime('garbage')).toBe('—')
    expect(statusTone(200)).toBe('success')
    expect(statusTone(429)).toBe('warn')
    expect(statusTone(401)).toBe('warn')
    expect(statusTone(502)).toBe('danger')
    expect(statusTone(undefined)).toBe('neutral')
  })
})
