import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '@shared/types'
import { buildPlan, PlanError, type Endpoint } from '@core/models/plan'
import { findProvider } from '@core/models/providers'

function profile(providerId: string, models: ModelProfile['models'], extra: Partial<ModelProfile> = {}): ModelProfile {
  const preset = findProvider(providerId)!
  return {
    id: 'p-1',
    name: 'Test',
    providerId,
    baseUrl: preset.regions[0].baseUrl,
    hasKey: true,
    keyRef: 'profile:p-1',
    models: { opus: models.main, sonnet: models.main, haiku: models.main, fable: models.main, subagent: models.main, ...models },
    compatMode: true,
    extraEnv: {},
    createdAt: '',
    updatedAt: '',
    ...extra
  }
}

const ctx = (shellEnv: Record<string, string | undefined> = {}, settingsEnv: Record<string, string> = {}) => ({ shellEnv, settingsEnv })
const bearer = (baseUrl: string, credential = 'key'): Endpoint => ({ baseUrl, authVar: 'ANTHROPIC_AUTH_TOKEN', credential })

describe('buildPlan', () => {
  it('declares the window of 256K models that have no [1m] suffix', () => {
    const preset = findProvider('moonshot')!
    const p = profile('moonshot', { main: 'kimi-k3[1m]', haiku: 'kimi-k2.7-code' }, { contextWindow: 1_000_000 })
    const plan = buildPlan(p, preset, bearer(p.baseUrl), ctx())
    expect(plan.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    expect(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('262144')
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe('Kimi K2.7 Code')
  })

  it('leaves out the compatibility bundle when compatibility mode is off', () => {
    const preset = findProvider('deepseek')!
    const p = profile('deepseek', { main: 'deepseek-flash[1m]' }, { compatMode: false })
    const plan = buildPlan(p, preset, bearer(p.baseUrl), ctx())
    expect(plan.env.ENABLE_TOOL_SEARCH).toBeUndefined()
    expect(plan.env.API_TIMEOUT_MS).toBeUndefined()
    expect(plan.settings.skipWebFetchPreflight).toBeUndefined()
    expect(plan.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })

  it('lets the profile override or drop provider extras, but never routing variables', () => {
    const preset = findProvider('moonshot')!
    const p = profile('moonshot', { main: 'kimi-k3[1m]' }, { extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: '', MY_FLAG: '1', ANTHROPIC_BASE_URL: 'https://evil.example' } })
    const plan = buildPlan(p, preset, bearer(p.baseUrl), ctx())
    expect('CLAUDE_CODE_EFFORT_LEVEL' in plan.env).toBe(false)
    expect(plan.env.MY_FLAG).toBe('1')
    expect(plan.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
  })

  it('keeps the local proxy reachable when an HTTP proxy is configured', () => {
    const preset = findProvider('openai')!
    const p = profile('openai', { main: 'gpt-6.1-sol[1m]' })
    const endpoint: Endpoint = { baseUrl: 'http://127.0.0.1:3460', authVar: 'ANTHROPIC_AUTH_TOKEN', credential: 'cs-token-123', viaProxy: true }
    const plan = buildPlan(p, preset, endpoint, ctx({ HTTPS_PROXY: 'http://corp:8080', NO_PROXY: 'corp.local' }))
    expect(plan.env.NO_PROXY).toBe('corp.local,127.0.0.1,localhost,::1')
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION).toMatch(/proxy/)
    expect(plan.env.ENABLE_TOOL_SEARCH).toBe('false')
    expect(buildPlan(p, preset, endpoint, ctx()).env.NO_PROXY).toBeUndefined()
  })

  it('cancels cloud switches and the other credential exported in the shell', () => {
    const preset = findProvider('zai')!
    const p = profile('zai', { main: 'glm-5.3[1m]' })
    const plan = buildPlan(p, preset, bearer(p.baseUrl), ctx({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'shell' }))
    expect(plan.env.CLAUDE_CODE_USE_BEDROCK).toBe('')
    expect(plan.env.ANTHROPIC_API_KEY).toBe('')
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe('key')
  })

  it('requires the cloud placeholders to be filled in', () => {
    const preset = findProvider('foundry')!
    const p = profile('foundry', { main: 'claude-opus-5-5' }, { compatMode: false })
    expect(() => buildPlan(p, preset, { credential: 'az-key' }, ctx())).toThrow(PlanError)
    const filled = buildPlan({ ...p, extraEnv: { ANTHROPIC_FOUNDRY_RESOURCE: 'my-res' } }, preset, { credential: 'az-key' }, ctx())
    expect(filled.env).toMatchObject({ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'my-res', ANTHROPIC_FOUNDRY_API_KEY: 'az-key' })
    expect(filled.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('writes only an API key for the Claude (Anthropic) preset', () => {
    const preset = findProvider('anthropic')!
    const p = profile('anthropic', { main: 'claude-opus-5-5' })
    expect(buildPlan(p, preset, { credential: 'sk-ant' }, ctx())).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant' }, settings: {} })
    expect(buildPlan(p, preset, {}, ctx())).toEqual({ env: {}, settings: {} })
  })
})
