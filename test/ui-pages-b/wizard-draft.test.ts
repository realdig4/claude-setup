import { describe, expect, it } from 'vitest'
import type { ModelProfile, ProviderPreset } from '@shared/types'
import { newRow } from '../../src/renderer/src/pages/models/keyValueRows'
import {
  accountErrors,
  accountStepLabel,
  applyErrors,
  buildProfileInput,
  connectionInput,
  initialDraft,
  isValid,
  modelErrors,
  showsKeyField,
  supportsKeyHelper,
  testSkipReason,
  withMainModel
} from '../../src/renderer/src/pages/models/wizard/draft'

function preset(over: Partial<ProviderPreset> & Pick<ProviderPreset, 'id'>): ProviderPreset {
  return {
    name: over.id,
    vendor: over.id,
    description: '',
    kind: 'anthropic-compatible',
    color: '#123456',
    monogram: 'X',
    regions: [{ id: 'global', label: 'Global', baseUrl: 'https://api.example.com/anthropic' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    models: [],
    defaults: { main: '' },
    tags: [],
    notes: [],
    ...over
  }
}

const kimi = preset({
  id: 'kimi',
  name: 'Kimi',
  regions: [
    { id: 'intl', label: 'International', baseUrl: 'https://api.moonshot.ai/anthropic' },
    { id: 'cn', label: 'China', baseUrl: 'https://api.moonshot.cn/anthropic' }
  ],
  models: [
    { id: 'kimi-k3[1m]', label: 'Kimi K3' },
    { id: 'kimi-k3', label: 'Kimi K3 fast', recommendedFor: ['fast'] },
    { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro' }
  ],
  defaults: { main: 'kimi-k3[1m]', opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' }
})
const custom = preset({ id: 'custom', kind: 'custom', name: 'Custom', regions: [{ id: 'custom', label: 'Custom', baseUrl: '' }], requiresKey: false })
const groq = preset({ id: 'groq', kind: 'openai-proxy', models: [{ id: 'gpt-oss-120b', label: 'gpt-oss 120B' }], defaults: { main: 'gpt-oss-120b' } })
const ollama = preset({ id: 'ollama', kind: 'local', requiresKey: false, defaultKey: 'ollama', defaults: { main: 'qwen3.5' } })
const vertex = preset({
  id: 'vertex',
  kind: 'cloud',
  requiresKey: false,
  regions: [{ id: 'gcp', label: 'Google Cloud', baseUrl: '' }],
  defaults: { main: 'claude-opus-5-5' },
  cloudEnv: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: '<your-gcp-project-id>' }
})
const anthropic = preset({ id: 'anthropic', kind: 'anthropic', requiresKey: false, authEnv: 'none', defaults: { main: 'claude-sonnet-5-5' } })

const opts = { existingNames: [], defaultTargets: ['claude-code' as const] }

describe('pages-b/wizard: initial draft', () => {
  it('starts a new setup from the provider defaults', () => {
    const draft = initialDraft(kimi, opts)
    expect(draft).toMatchObject({ regionId: 'intl', baseUrl: '', apiKey: '', main: 'kimi-k3[1m]', fast: 'kimi-k3', compatMode: true, name: 'Kimi K3' })
    expect(draft.targets).toEqual(['claude-code'])
    expect(initialDraft(custom, opts)).toMatchObject({ main: '', fast: '', regionId: 'custom' })
    expect(initialDraft(vertex, opts).cloud).toEqual({ CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: '' })
    expect(initialDraft(anthropic, opts).compatMode).toBe(false)
  })

  it('pre-fills from an existing profile, keeping only real slot overrides', () => {
    const profile: ModelProfile = {
      id: 'kimi-abc',
      name: 'Work Kimi',
      providerId: 'kimi',
      regionId: 'cn',
      baseUrl: 'https://api.moonshot.cn/anthropic/',
      keyRef: 'profile:kimi-abc',
      hasKey: true,
      models: { main: 'kimi-k3[1m]', opus: 'kimi-k3.1-pro', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
      compatMode: false,
      extraEnv: { MY_VAR: '1' },
      contextWindow: 262144,
      useKeyHelper: true,
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z'
    }
    const draft = initialDraft(kimi, { ...opts, profile })
    expect(draft).toMatchObject({ regionId: 'cn', baseUrl: '', main: 'kimi-k3[1m]', fast: 'kimi-k3', compatMode: false, compatTouched: true })
    expect(draft.overrides).toEqual({ opus: 'kimi-k3.1-pro' })
    expect(draft.extraEnv.map((r) => [r.key, r.value])).toEqual([['MY_VAR', '1']])
    expect(draft).toMatchObject({ contextWindow: '262144', useKeyHelper: true, name: 'Work Kimi', nameTouched: true })
    const moved = initialDraft(kimi, { ...opts, profile: { ...profile, baseUrl: 'https://gateway.example.com/kimi' } })
    expect(moved.baseUrl).toBe('https://gateway.example.com/kimi')
  })

  it('keeps cloud fields apart from extra env when editing', () => {
    const profile = {
      id: 'v',
      name: 'Vertex',
      providerId: 'vertex',
      baseUrl: '',
      hasKey: false,
      models: { main: 'claude-opus-5-5' },
      compatMode: false,
      extraEnv: { ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj', OTHER: 'x' },
      createdAt: '',
      updatedAt: ''
    } satisfies ModelProfile
    const draft = initialDraft(vertex, { ...opts, profile })
    expect(draft.cloud).toEqual({ CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj' })
    expect(draft.extraEnv.map((r) => r.key)).toEqual(['OTHER'])
  })

  it('follows the main model until the user edits the name or compatibility', () => {
    const draft = initialDraft(kimi, opts)
    const next = withMainModel(draft, kimi, 'kimi-k3.1-pro', [])
    expect(next.name).toBe('Kimi K3.1 Pro')
    const touched = withMainModel({ ...draft, name: 'Mine', nameTouched: true, compatMode: false, compatTouched: true }, kimi, 'kimi-k3', [])
    expect(touched).toMatchObject({ name: 'Mine', compatMode: false })
  })
})

describe('pages-b/wizard: validation', () => {
  it('requires a key unless one is saved, and an address for custom servers', () => {
    const draft = initialDraft(kimi, opts)
    expect(accountErrors(kimi, draft, false).apiKey).toMatch(/API key/)
    expect(isValid(accountErrors(kimi, draft, true))).toBe(true)
    expect(accountErrors(kimi, { ...draft, apiKey: 'sk a b' }, false).apiKey).toMatch(/spaces/)
    expect(isValid(accountErrors(kimi, { ...draft, apiKey: 'sk-abc' }, false))).toBe(true)
    expect(accountErrors(kimi, { ...draft, apiKey: 'sk-abc', baseUrl: 'not a url' }, false).baseUrl).toMatch(/http/)
    expect(accountErrors(custom, initialDraft(custom, opts), false).baseUrl).toMatch(/address/)
    expect(isValid(accountErrors(custom, { ...initialDraft(custom, opts), baseUrl: 'http://localhost:4000' }, false))).toBe(true)
  })

  it('requires the cloud fields marked as required', () => {
    const draft = initialDraft(vertex, opts)
    expect(accountErrors(vertex, draft, false).cloud).toEqual({ ANTHROPIC_VERTEX_PROJECT_ID: expect.stringMatching(/project id/i) })
    expect(isValid(accountErrors(vertex, { ...draft, cloud: { ...draft.cloud, ANTHROPIC_VERTEX_PROJECT_ID: 'p' } }, false))).toBe(true)
  })

  it('checks models, slots, context window and env rows', () => {
    const draft = initialDraft(kimi, opts)
    expect(isValid(modelErrors(draft))).toBe(true)
    expect(modelErrors({ ...draft, main: ' ' }).main).toMatch(/Choose/)
    expect(modelErrors({ ...draft, overrides: { opus: 'bad id' } }).slots?.opus).toMatch(/spaces/)
    expect(modelErrors({ ...draft, contextWindow: '12' }).contextWindow).toMatch(/1,024/)
    const bad = newRow('ANTHROPIC_MODEL', 'x')
    expect(modelErrors({ ...draft, extraEnv: [bad] }).env?.[bad.id]).toMatch(/set for you/)
  })

  it('checks the name and targets on the last step', () => {
    const draft = initialDraft(kimi, opts)
    expect(isValid(applyErrors(draft, true))).toBe(true)
    expect(applyErrors({ ...draft, targets: [] }, true).targets).toMatch(/at least one/)
    expect(applyErrors({ ...draft, targets: [] }, false).targets).toBeUndefined()
    expect(applyErrors({ ...draft, name: '' }, false).name).toMatch(/name/)
  })
})

describe('pages-b/wizard: requests', () => {
  it('builds the profile with every slot, cloud values and extras', () => {
    const draft = { ...initialDraft(kimi, opts), apiKey: ' sk-abc ', contextWindow: '262144', extraEnv: [newRow('MY_VAR', '1'), newRow('', '')] }
    const input = buildProfileInput(kimi, draft)
    expect(input).toEqual({
      name: 'Kimi K3',
      providerId: 'kimi',
      regionId: 'intl',
      apiKey: 'sk-abc',
      models: { main: 'kimi-k3[1m]', opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
      compatMode: true,
      extraEnv: { MY_VAR: '1' },
      contextWindow: 262144,
      useKeyHelper: false
    })
    expect(buildProfileInput(kimi, draft, 'kimi-abc').id).toBe('kimi-abc')
    const cloud = buildProfileInput(vertex, { ...initialDraft(vertex, opts), cloud: { CLOUD_ML_REGION: 'us-east5', ANTHROPIC_VERTEX_PROJECT_ID: ' p1 ' } })
    expect(cloud.extraEnv).toEqual({ CLOUD_ML_REGION: 'us-east5', ANTHROPIC_VERTEX_PROJECT_ID: 'p1' })
    expect(cloud.apiKey).toBeUndefined()
    expect(buildProfileInput(groq, { ...initialDraft(groq, opts), compatMode: false }).compatMode).toBe(true)
    expect(buildProfileInput(groq, { ...initialDraft(groq, opts), useKeyHelper: true }).useKeyHelper).toBe(false)
  })

  it('tests with the typed key, or the saved profile key when editing', () => {
    const draft = { ...initialDraft(kimi, opts), apiKey: 'sk-new' }
    expect(connectionInput(kimi, draft, 'kimi-abc')).toEqual({ providerId: 'kimi', regionId: 'intl', apiKey: 'sk-new', model: 'kimi-k3[1m]' })
    expect(connectionInput(kimi, { ...draft, apiKey: '' }, 'kimi-abc')).toEqual({ providerId: 'kimi', regionId: 'intl', profileId: 'kimi-abc', model: 'kimi-k3[1m]' })
    expect(connectionInput(custom, { ...initialDraft(custom, opts), baseUrl: ' http://x:1 ' })).toEqual({ providerId: 'custom', regionId: 'custom', baseUrl: 'http://x:1' })
  })

  it('labels the first step and decides which fields and tests apply', () => {
    expect(accountStepLabel(kimi)).toBe('Your key')
    expect(accountStepLabel(custom)).toBe('Address')
    expect(accountStepLabel(ollama)).toBe('Connect')
    expect(accountStepLabel(vertex)).toBe('Your account')
    expect(accountStepLabel(anthropic)).toBe('Sign-in')
    expect(showsKeyField(ollama)).toBe(false)
    expect(showsKeyField(anthropic)).toBe(true)
    expect(showsKeyField(custom)).toBe(true)
    expect(supportsKeyHelper(kimi)).toBe(true)
    expect(supportsKeyHelper(groq)).toBe(false)
    expect(testSkipReason(vertex, initialDraft(vertex, opts), false)).toMatch(/can’t test/)
    expect(testSkipReason(anthropic, initialDraft(anthropic, opts), false)).toMatch(/Claude account/)
    expect(testSkipReason(anthropic, { ...initialDraft(anthropic, opts), apiKey: 'sk-ant' }, false)).toBeNull()
    expect(testSkipReason(kimi, initialDraft(kimi, opts), false)).toBeNull()
  })
})
