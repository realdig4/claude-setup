import { describe, expect, it } from 'vitest'
import type { ModelStatus, ProviderPreset } from '@shared/types'
import { isBlankRow, newRow, recordFromRows, rowErrors, rowsFromRecord, sameRecord } from '../../src/renderer/src/pages/models/keyValueRows'
import {
  CAVEAT,
  apiKeyError,
  classifyWarnings,
  cloudFields,
  contextWindowError,
  defaultCompatMode,
  defaultFastModel,
  effectiveSlots,
  envVarError,
  familyVariants,
  featuredProviders,
  findModel,
  groupProviders,
  isCaveatNote,
  isClaudeModel,
  isRetiring,
  isUserDefined,
  keyPrefixOf,
  matchesProvider,
  mergeModels,
  modelFacts,
  modelIdError,
  modelLabel,
  parseTokenCount,
  profileNameError,
  providerGroup,
  providerNotes,
  sortedTags,
  statusHeadline,
  suggestProfileName,
  variantForKey,
  verdictInfo
} from '../../src/renderer/src/pages/models/logic'

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
  vendor: 'Moonshot AI',
  description: 'Kimi K3 models with a 1M-token context window.',
  regions: [
    { id: 'intl', label: 'International', baseUrl: 'https://api.moonshot.ai/anthropic' },
    { id: 'cn', label: 'China', baseUrl: 'https://api.moonshot.cn/anthropic' }
  ],
  models: [
    { id: 'kimi-k3[1m]', label: 'Kimi K3 (1M context)', context: 1_000_000, thinking: 'optional', recommendedFor: ['main'] },
    { id: 'kimi-k3', label: 'Kimi K3', context: 1_000_000, recommendedFor: ['fast'] },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', context: 262_144, thinking: 'always', notes: 'Retiring at the end of December 2026.' }
  ],
  defaults: { main: 'kimi-k3[1m]', opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
  tags: ['long-context', 'popular'],
  notes: ['Keys are per region.', 'Heads-up from Anthropic: it "doesn\'t support routing Claude Code to non-Claude models". Claude Setup is not affiliated with Anthropic.']
})
const custom = preset({ id: 'custom', kind: 'custom', name: 'Custom endpoint', regions: [{ id: 'custom', label: 'Custom', baseUrl: '' }], requiresKey: false })
const openaiCompatible = preset({ id: 'openai-compatible', kind: 'openai-proxy', regions: [{ id: 'custom', label: 'Custom', baseUrl: '' }], tags: ['needs-proxy'] })
const groq = preset({ id: 'groq', kind: 'openai-proxy', tags: ['fast', 'free', 'needs-proxy'], defaults: { main: 'gpt-oss-120b', haiku: 'gpt-oss-20b' } })
const ollama = preset({ id: 'ollama', kind: 'local', tags: ['local', 'free'], requiresKey: false, defaults: { main: 'qwen3.5' } })
const bedrock = preset({ id: 'bedrock', kind: 'cloud', regions: [{ id: 'aws', label: 'AWS', baseUrl: '' }], cloudEnv: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } })
const vertex = preset({ id: 'vertex', kind: 'cloud', cloudEnv: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: '<your-gcp-project-id>', SOME_NEW_THING: 'x' } })
const anthropic = preset({ id: 'anthropic', kind: 'anthropic', name: 'Claude', tags: ['popular'], defaults: { main: 'claude-sonnet-5-5' } })
const zai = preset({ id: 'zai', tags: ['coding-plan', 'long-context', 'china'] })
const deepseek = preset({ id: 'deepseek', tags: ['cheap', 'popular'] })

describe('pages-b/models: key/value rows', () => {
  it('converts between rows and records', () => {
    const rows = rowsFromRecord({ A: '1', B: '2' })
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['A', '1'],
      ['B', '2']
    ])
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    expect(recordFromRows([...rows, newRow('  C ', '3'), newRow('', 'ignored'), newRow('A', 'last')])).toEqual({ A: 'last', B: '2', C: '3' })
    expect(rowsFromRecord(undefined)).toEqual([])
  })

  it('validates rows, ignoring blanks and flagging duplicates', () => {
    const rows = [newRow('OK', '1'), newRow('', ''), newRow('', 'orphan'), newRow('bad name', 'x'), newRow('OK', '2')]
    const errors = rowErrors(rows, (key) => (/\s/.test(key) ? 'no spaces' : undefined), { noun: 'variable' })
    expect(errors[rows[0]!.id]).toBeUndefined()
    expect(errors[rows[1]!.id]).toBeUndefined()
    expect(errors[rows[2]!.id]).toMatch(/name/)
    expect(errors[rows[3]!.id]).toBe('no spaces')
    expect(errors[rows[4]!.id]).toMatch(/twice/)
    expect(isBlankRow(newRow(' ', ' '))).toBe(true)
  })

  it('compares header names case-insensitively when asked', () => {
    const rows = [newRow('X-Key', '1'), newRow('x-key', '2')]
    expect(Object.keys(rowErrors(rows, () => undefined)).length).toBe(0)
    expect(Object.keys(rowErrors(rows, () => undefined, { caseInsensitive: true })).length).toBe(1)
  })

  it('compares records regardless of order', () => {
    expect(sameRecord({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true)
    expect(sameRecord({ a: '1' }, { a: '2' })).toBe(false)
    expect(sameRecord(undefined, {})).toBe(true)
  })
})

describe('pages-b/models: providers', () => {
  it('classifies providers into gallery groups', () => {
    expect(providerGroup(anthropic)).toBe('claude')
    expect(providerGroup(bedrock)).toBe('cloud')
    expect(providerGroup(ollama)).toBe('local')
    expect(providerGroup(custom)).toBe('custom')
    expect(providerGroup(openaiCompatible)).toBe('custom')
    expect(providerGroup(groq)).toBe('proxy')
    expect(providerGroup(zai)).toBe('plans')
    expect(providerGroup(kimi)).toBe('direct')
    expect(isUserDefined(custom)).toBe(true)
    expect(isUserDefined(bedrock)).toBe(false)
  })

  it('groups providers in display order and hides Claude unless asked', () => {
    const groups = groupProviders([anthropic, groq, kimi, ollama, zai])
    expect(groups.map((g) => g.id)).toEqual(['direct', 'plans', 'local', 'proxy'])
    expect(groupProviders([anthropic], { includeClaude: true }).map((g) => g.id)).toEqual(['claude'])
  })

  it('features popular third-party providers first, then free/local ones', () => {
    const picks = featuredProviders([anthropic, groq, kimi, ollama, zai, deepseek, custom, bedrock], 4)
    expect(picks.map((p) => p.id)).toEqual(['kimi', 'deepseek', 'ollama', 'groq'])
    expect(picks.some((p) => p.kind === 'anthropic' || p.kind === 'cloud' || isUserDefined(p))).toBe(false)
  })

  it('searches names, models and tag labels', () => {
    expect(matchesProvider(kimi, 'moonshot')).toBe(true)
    expect(matchesProvider(kimi, 'k2.7')).toBe(true)
    expect(matchesProvider(kimi, 'long context')).toBe(true)
    expect(matchesProvider(kimi, 'groq')).toBe(false)
    expect(matchesProvider(kimi, '  ')).toBe(true)
  })

  it('sorts tags and strips the caveat from notes', () => {
    expect(sortedTags(kimi)).toEqual(['popular', 'long-context'])
    expect(providerNotes(kimi)).toEqual(['Keys are per region.'])
    expect(isCaveatNote('Anthropic doesn’t support using Claude Code with non-Claude models')).toBe(true)
    expect(isCaveatNote('Kimi doesn’t understand Claude model names.')).toBe(false)
  })
})

describe('pages-b/models: models and slots', () => {
  it('finds models and labels ignoring the [1m] suffix', () => {
    expect(findModel(kimi.models, 'kimi-k3[1m]')?.label).toBe('Kimi K3 (1M context)')
    expect(findModel(kimi.models, 'kimi-k2.7-code[1m]')?.id).toBe('kimi-k2.7-code')
    expect(modelLabel(kimi.models, 'unknown[1m]')).toBe('unknown')
    expect(modelLabel(undefined, undefined)).toBe('')
  })

  it('merges loaded models after the curated ones', () => {
    const merged = mergeModels(kimi.models, [{ id: 'kimi-k3', label: 'dup' }, { id: 'kimi-new', label: 'New' }])
    expect(merged.map((m) => m.id)).toEqual(['kimi-k3[1m]', 'kimi-k3', 'kimi-k2.7-code', 'kimi-new'])
    expect(merged[1]?.label).toBe('Kimi K3')
  })

  it('describes model facts and retirements', () => {
    expect(modelFacts(kimi.models[0], (n) => `${n / 1_000_000}M`)).toEqual(['1M context', 'Can think step by step'])
    expect(modelFacts(kimi.models[2], () => '256K')).toEqual(['256K context', 'Always thinks'])
    expect(isRetiring(kimi.models[2])).toBe(true)
    expect(isRetiring(kimi.models[0])).toBe(false)
  })

  it('recognises Claude model ids like the core', () => {
    expect(isClaudeModel('claude-sonnet-5-5')).toBe(true)
    expect(isClaudeModel('us.anthropic.claude-opus-5-5')).toBe(true)
    expect(isClaudeModel('~anthropic/claude-haiku-latest')).toBe(true)
    expect(isClaudeModel('claude-code/moonshotai/kimi-k3')).toBe(false)
    expect(isClaudeModel('kimi-k3')).toBe(false)
  })

  it('fills every slot like the core does', () => {
    expect(defaultFastModel(kimi)).toBe('kimi-k3')
    expect(defaultFastModel(ollama)).toBe('qwen3.5')
    expect(effectiveSlots(kimi, 'kimi-k3[1m]', 'kimi-k3')).toEqual({
      main: 'kimi-k3[1m]',
      opus: 'kimi-k3[1m]',
      sonnet: 'kimi-k3[1m]',
      haiku: 'kimi-k3',
      fable: 'kimi-k3[1m]',
      subagent: 'kimi-k3[1m]'
    })
    // A non-default main model fills the other slots with it.
    expect(effectiveSlots(kimi, 'kimi-k2.7-code', '')).toEqual({
      main: 'kimi-k2.7-code',
      opus: 'kimi-k2.7-code',
      sonnet: 'kimi-k2.7-code',
      haiku: 'kimi-k2.7-code',
      fable: 'kimi-k2.7-code',
      subagent: 'kimi-k2.7-code'
    })
    expect(effectiveSlots(kimi, 'kimi-k3[1m]', 'kimi-k3', { opus: 'kimi-k2.7-code', subagent: '  ' }).opus).toBe('kimi-k2.7-code')
    expect(effectiveSlots(kimi, 'kimi-k3[1m]', 'kimi-k3', { subagent: '  ' }).subagent).toBe('kimi-k3[1m]')
  })

  it('validates model names', () => {
    expect(modelIdError('kimi-k3')).toBeUndefined()
    expect(modelIdError('')).toBeUndefined()
    expect(modelIdError('two words')).toMatch(/spaces/)
    expect(modelIdError('x'.repeat(201))).toMatch(/long/)
  })
})

describe('pages-b/models: wizard fields', () => {
  it('chooses the compatibility default', () => {
    expect(defaultCompatMode(anthropic, 'claude-sonnet-5-5')).toBe(false)
    expect(defaultCompatMode(bedrock, 'us.anthropic.claude-opus-5-5')).toBe(false)
    expect(defaultCompatMode(groq, 'claude-sonnet-5-5')).toBe(true)
    expect(defaultCompatMode(kimi, 'kimi-k3')).toBe(true)
    expect(defaultCompatMode(custom, '~anthropic/claude-opus-latest')).toBe(false)
  })

  it('validates extra environment variables', () => {
    expect(envVarError('MY_VAR', 'x')).toBeUndefined()
    expect(envVarError('1BAD', 'x')).toMatch(/letters/)
    expect(envVarError('ANTHROPIC_BASE_URL', 'x')).toMatch(/set for you/)
    expect(envVarError('CLAUDE_CODE_SUBAGENT_MODEL', 'x')).toMatch(/set for you/)
  })

  it('parses and validates token counts', () => {
    expect(parseTokenCount('')).toBeUndefined()
    expect(parseTokenCount('262,144')).toBe(262_144)
    expect(parseTokenCount('256k')).toBeNull()
    expect(contextWindowError('500')).toMatch(/1,024/)
    expect(contextWindowError('1000000')).toBeUndefined()
    expect(contextWindowError('abc')).toMatch(/whole number/)
  })

  it('rejects keys with spaces inside but accepts quoted or Bearer keys', () => {
    expect(apiKeyError('  sk-abc  ')).toBeUndefined()
    expect(apiKeyError('"sk-abc"')).toBeUndefined()
    expect(apiKeyError('Bearer sk-abc')).toBeUndefined()
    expect(apiKeyError('sk-abc def')).toMatch(/spaces/)
  })

  it('derives cloud fields from the provider template', () => {
    expect(cloudFields(bedrock)).toEqual([
      { key: 'AWS_REGION', label: 'AWS region', hint: expect.any(String), required: false, defaultValue: 'us-east-1', placeholder: 'us-east-1' }
    ])
    const fields = cloudFields(vertex)
    expect(fields.map((f) => f.key)).toEqual(['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'SOME_NEW_THING'])
    expect(fields[1]).toMatchObject({ required: true, defaultValue: '', placeholder: 'your-gcp-project-id', label: 'Google Cloud project ID' })
    expect(fields[2]?.label).toBe('Some new thing')
  })

  it('suggests unique, friendly profile names', () => {
    expect(suggestProfileName(kimi, 'kimi-k3[1m]', [])).toBe('Kimi K3 (1M context)')
    expect(suggestProfileName(kimi, 'kimi-k3[1m]', ['kimi k3 (1m context)'])).toBe('Kimi K3 (1M context) (2)')
    const router = preset({ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'moonshotai/kimi-k3', label: 'Kimi K3 (Moonshot)' }] })
    expect(suggestProfileName(router, 'moonshotai/kimi-k3', [])).toBe('OpenRouter · Kimi K3 (Moonshot)')
    const local = preset({ id: 'ollama', name: 'Ollama (this computer)', models: [{ id: 'qwen3.5', label: 'Qwen3.5' }] })
    expect(suggestProfileName(local, 'qwen3.5', [])).toBe('Ollama · Qwen3.5')
    expect(suggestProfileName(custom, '', [])).toBe('Custom endpoint')
    expect(suggestProfileName(anthropic, 'claude-sonnet-5-5', [])).toBe('Claude with an API key')
    expect(profileNameError('  ')).toMatch(/name/)
    expect(profileNameError('x'.repeat(81))).toMatch(/80/)
  })
})

describe('pages-b/models: results', () => {
  it('explains connection test verdicts with next steps', () => {
    expect(verdictInfo({ verdict: 'ok' }, kimi)).toMatchObject({ title: 'It works!', tone: 'success', tips: [] })
    const badKey = verdictInfo({ verdict: 'bad-key' }, kimi)
    expect(badKey.action).toBe('key')
    expect(badKey.tips.join(' ')).toMatch(/region/)
    expect(verdictInfo({ verdict: 'bad-key' }, groq).tips.join(' ')).not.toMatch(/region/)
    expect(verdictInfo({ verdict: 'bad-model' }, kimi).action).toBe('models')
    expect(verdictInfo({ verdict: 'bad-url' }, groq).tips[0]).toMatch(/\/v1/)
    expect(verdictInfo({ verdict: 'network' }, ollama).tips[0]).toMatch(/running/)
    expect(verdictInfo({ verdict: 'quota' }, kimi).action).toBe('billing')
    expect(verdictInfo({ verdict: 'unknown' }, kimi).tone).toBe('warn')
  })

  it('splits apply warnings into steps, caveat and notes', () => {
    const result = classifyWarnings([
      'Heads-up from Anthropic: it "doesn\'t support routing Claude Code to non-Claude models". Claude Setup is not affiliated with Anthropic.',
      'Restart Claude Code (close it and run claude again) to use the new settings.',
      'Reload VS Code (Command Palette → "Developer: Reload Window").',
      'Keep Claude Setup running.'
    ])
    expect(result.steps).toHaveLength(2)
    expect(result.caveat).toMatch(/^Heads-up/)
    expect(result.notes).toEqual(['Keep Claude Setup running.'])
    expect(CAVEAT).toMatch(/non-Claude/)
  })

  it('writes the status headline', () => {
    const base: ModelStatus = { mode: 'anthropic', vscodeConfigured: false, vscodeMatches: true, problems: [], shellOverrides: [] }
    expect(statusHeadline(base, undefined, undefined).title).toBe('Official Claude (Anthropic)')
    expect(statusHeadline({ ...base, mode: 'custom', providerName: 'Kimi', model: 'kimi-k3[1m]' }, kimi, undefined)).toEqual({
      title: 'Kimi',
      subtitle: 'Kimi K3 (1M context)'
    })
    expect(statusHeadline({ ...base, mode: 'custom', baseUrl: 'https://gw.example.com/x' }, undefined, undefined).title).toBe('gw.example.com')
    expect(statusHeadline({ ...base, mode: 'cloud', providerName: 'Amazon Bedrock' }, undefined, undefined).title).toBe('Claude via Amazon Bedrock')
  })
})

describe('pages-b/models: provider families (one service sold several ways)', () => {
  const fam = (choice: string) => ({ id: 'kimi', name: 'Kimi', description: 'Kimi K3 with your membership or pay as you go.', choice, choiceHint: '' })
  const plan = preset({ id: 'kimi-code', name: 'Kimi Code (membership plan)', family: fam('Membership plan'), keyPattern: '^sk-kimi-', tags: ['popular', 'coding-plan'] })
  const payg = preset({ id: 'moonshot', name: 'Kimi API (pay as you go)', family: fam('Pay as you go'), tags: ['popular'] })
  const ds = preset({ id: 'deepseek', tags: ['popular', 'cheap'] })
  const list = [plan, payg, ds]

  it('features a family once, as its first variant', () => {
    expect(featuredProviders(list).map((p) => p.id)).toEqual(['kimi-code', 'deepseek'])
  })

  it('lists the variants of a family in order', () => {
    expect(familyVariants(payg, list).map((p) => p.id)).toEqual(['kimi-code', 'moonshot'])
    expect(familyVariants(ds, list).map((p) => p.id)).toEqual(['deepseek'])
  })

  it('spots a membership key pasted into pay as you go (and nothing else)', () => {
    expect(variantForKey(payg, list, ' sk-kimi-abc ')?.id).toBe('kimi-code')
    expect(variantForKey(plan, list, 'sk-kimi-abc')).toBeUndefined()
    expect(variantForKey(payg, list, 'sk-abc')).toBeUndefined()
    expect(variantForKey(ds, list, 'sk-kimi-abc')).toBeUndefined()
    expect(keyPrefixOf(plan)).toBe('sk-kimi-')
    expect(keyPrefixOf(preset({ id: 'x', keyPattern: '^(a|b)-' }))).toBeUndefined()
  })

  it('carries the window the live list reports onto curated models', () => {
    const base = [{ id: 'k3.1-pro', label: 'K3.1 Pro (256K)', context: 262144 }]
    const merged = mergeModels(base, [{ id: 'k3.1-pro', label: 'K3.1 Pro', context: 262144, liveContext: 1048576 }, { id: 'new', label: 'New' }])
    expect(merged).toEqual([{ id: 'k3.1-pro', label: 'K3.1 Pro (256K)', context: 262144, liveContext: 1048576 }, { id: 'new', label: 'New' }])
  })
})

describe('pages-b/models: compatibility default from the provider', () => {
  it('follows a provider that documents a setup without the compatibility bundle', () => {
    const kimiCode = preset({ id: 'kimi-code', compatDefault: false })
    expect(defaultCompatMode(kimiCode, 'k3.1-pro')).toBe(false)
    expect(defaultCompatMode(preset({ id: 'other' }), 'k3.1-pro')).toBe(true)
    expect(defaultCompatMode(preset({ id: 'groq', kind: 'openai-proxy', compatDefault: false }), 'x')).toBe(true)
  })
})
