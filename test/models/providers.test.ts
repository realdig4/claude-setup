import { describe, expect, it } from 'vitest'
import type { ProviderPreset } from '@shared/types'
import { MODEL_SLOTS } from '@core/models/profiles'
import {
  ANTHROPIC_CAVEAT,
  findProvider,
  isUserDefinedEndpoint,
  keyMatchesPreset,
  listProviders,
  modelLabel,
  modelNotices,
  providerForBaseUrl,
  PROXY_HINTS,
  sameFamily,
  siblingForKey
} from '@core/models/providers'
import { hasContextSuffix } from '@core/models/urls'

const providers = listProviders()
const TAGS = new Set(['popular', 'cheap', 'fast', 'long-context', 'free', 'local', 'coding-plan', 'china', 'needs-proxy'])

function isUrl(value: string, protocols = ['https:', 'http:']): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}

describe('provider presets', () => {
  it('has unique ids', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every provider the app promises', () => {
    const ids = providers.map((p) => p.id)
    for (const id of [
      'anthropic',
      'moonshot',
      'kimi-code',
      'deepseek',
      'zai',
      'minimax',
      'qwen',
      'qwen-coding',
      'mimo',
      'streamlake',
      'volcengine',
      'byteplus',
      'siliconflow',
      'openrouter',
      'vercel',
      'ollama',
      'ollama-cloud',
      'lmstudio',
      'litellm',
      'fireworks',
      'openai',
      'gemini',
      'groq',
      'cerebras',
      'openai-compatible',
      'bedrock',
      'vertex',
      'foundry',
      'custom'
    ]) {
      expect(ids).toContain(id)
    }
  })

  it.each(providers.map((p) => [p.id, p] as [string, ProviderPreset]))('%s is well-formed', (_id, p) => {
    expect(p.name.trim()).not.toBe('')
    expect(p.vendor.trim()).not.toBe('')
    expect(p.description.trim()).not.toBe('')
    expect(p.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(p.monogram.length).toBeGreaterThanOrEqual(1)
    expect(p.monogram.length).toBeLessThanOrEqual(2)
    expect(p.regions.length).toBeGreaterThan(0)
    expect(new Set(p.regions.map((r) => r.id)).size).toBe(p.regions.length)
    for (const region of p.regions) {
      expect(region.label.trim()).not.toBe('')
      if (!region.baseUrl) {
        expect(isUserDefinedEndpoint(p) || p.kind === 'cloud').toBe(true)
        continue
      }
      expect(isUrl(region.baseUrl)).toBe(true)
      if (p.kind !== 'openai-proxy') expect(region.baseUrl).not.toMatch(/\/v1\/?$/)
    }
    for (const url of [p.website, p.keyUrl, p.docsUrl]) if (url) expect(isUrl(url, ['https:'])).toBe(true)

    // Every slot is always present.
    for (const slot of MODEL_SLOTS) expect(typeof p.defaults[slot]).toBe('string')
    if (p.defaults.main === '') {
      expect(['custom', 'openai-proxy']).toContain(p.kind)
      for (const slot of MODEL_SLOTS) expect(p.defaults[slot]).toBe('')
    } else {
      const ids = p.models.map((m) => m.id)
      for (const slot of MODEL_SLOTS) {
        expect(p.defaults[slot]).toBeTruthy()
        expect(ids).toContain(p.defaults[slot])
      }
    }
    const modelIds = p.models.map((m) => m.id)
    expect(new Set(modelIds).size).toBe(modelIds.length)
    for (const m of p.models) {
      expect(m.label.trim()).not.toBe('')
      expect(m.id).not.toMatch(/\s/)
      if (hasContextSuffix(m.id) && m.context !== undefined) expect(m.context).toBeGreaterThanOrEqual(1_000_000)
    }

    for (const v of Object.values(p.extraEnv ?? {})) expect(typeof v).toBe('string')
    if (p.contextWindow !== undefined) expect(p.contextWindow).toBeGreaterThan(0)
    for (const tag of p.tags) expect(TAGS.has(tag)).toBe(true)
    expect(Array.isArray(p.notes)).toBe(true)
    if (p.listModels) expect(p.listModels.url).toMatch(/^(https?:\/\/|\/|\{origin\}\/)/)

    if (p.kind === 'cloud') {
      expect(p.authEnv).toBe('none')
      expect(Object.keys(p.cloudEnv ?? {}).some((k) => k.startsWith('CLAUDE_CODE_USE_'))).toBe(true)
    } else {
      expect(p.authEnv).not.toBe('none')
    }
    if (p.kind === 'openai-proxy') expect(p.tags).toContain('needs-proxy')
    if (p.kind === 'local') expect(p.defaultKey).toBeTruthy()
  })

  it('never ships retired model ids', () => {
    const all = providers.flatMap((p) => [...p.models.map((m) => m.id), ...Object.values(p.defaults)])
    for (const id of all) {
      expect(id).not.toMatch(/kimi-k2\.5|kimi-k2p5|^deepseek-chat$|^deepseek-reasoner$/)
    }
  })

  it('uses Kimi K3 for every Moonshot slot (the K2 series is retiring)', () => {
    const moonshot = findProvider('moonshot')!
    for (const slot of MODEL_SLOTS) expect(moonshot.defaults[slot]).toBe('kimi-k3[1m]')
    expect(moonshot.regions.map((r) => r.baseUrl)).toEqual(['https://api.moonshot.ai/anthropic', 'https://api.moonshot.cn/anthropic'])
  })

  it('follows the documented Kimi Code setup', () => {
    const kimi = findProvider('kimi-code')!
    expect(kimi.authEnv).toBe('ANTHROPIC_API_KEY')
    expect(kimi.regions.map((r) => r.baseUrl)).toEqual(['https://api.kimi.ai/coding/', 'https://api.kimi.com/coding/'])
    expect(kimi.contextWindow).toBe(262144)
    expect(hasContextSuffix(kimi.defaults.main)).toBe(false)
    // Every 256K model the plans offer has its 1M variant for Pro and higher plans (the wizard switches to it).
    for (const id of ['k3.1-pro', 'k3']) expect(kimi.models.map((m) => m.id)).toContain(`${id}[1m]`)
  })

  it('offers Kimi as one family: membership plan first, then pay as you go', () => {
    const kimiFamily = providers.filter((p) => p.family?.id === 'kimi')
    expect(kimiFamily.map((p) => p.id)).toEqual(['kimi-code', 'moonshot'])
    expect(new Set(kimiFamily.map((p) => p.family?.name))).toEqual(new Set(['Kimi']))
    expect(new Set(kimiFamily.map((p) => p.family?.choice)).size).toBe(2)
  })

  it('keeps every family consistent', () => {
    const families = new Map<string, ProviderPreset[]>()
    for (const p of providers) if (p.family) families.set(p.family.id, [...(families.get(p.family.id) ?? []), p])
    for (const [, variants] of families) {
      expect(variants.length).toBeGreaterThanOrEqual(2)
      expect(new Set(variants.map((v) => `${v.family?.name}|${v.family?.description}`)).size).toBe(1)
      expect(new Set(variants.map((v) => v.vendor)).size).toBe(1)
      for (const v of variants) expect(v.family?.choiceHint.trim()).not.toBe('')
    }
  })

  it('recognises Kimi membership keys pasted into pay as you go', () => {
    const moonshot = findProvider('moonshot')!
    const kimiCode = findProvider('kimi-code')!
    expect(keyMatchesPreset(kimiCode, '  sk-kimi-abc123  ')).toBe(true)
    expect(siblingForKey(moonshot, 'sk-kimi-abc123')?.id).toBe('kimi-code')
    expect(siblingForKey(kimiCode, 'sk-kimi-abc123')).toBeUndefined()
    expect(siblingForKey(moonshot, 'sk-abc123')).toBeUndefined()
    expect(siblingForKey(findProvider('deepseek')!, 'sk-kimi-abc123')).toBeUndefined()
    expect(sameFamily(moonshot, kimiCode)).toBe(true)
    expect(sameFamily(moonshot, findProvider('deepseek'))).toBe(false)
  })

  it('blanks ANTHROPIC_API_KEY where providers require Bearer only', () => {
    for (const id of ['openrouter', 'vercel', 'ollama', 'ollama-cloud']) expect(findProvider(id)!.blankApiKey).toBe(true)
  })

  it('pins Sonnet and Haiku on Bedrock', () => {
    const bedrock = findProvider('bedrock')!
    expect(bedrock.defaults.sonnet).toBe('us.anthropic.claude-sonnet-5-5')
    expect(bedrock.defaults.haiku).toBe('us.anthropic.claude-haiku-5-5')
  })

  it('has proxy hints only for proxy providers', () => {
    for (const id of Object.keys(PROXY_HINTS)) expect(findProvider(id)?.kind).toBe('openai-proxy')
  })

  it('recognises providers by base URL (any trailing slash, any case)', () => {
    expect(providerForBaseUrl('https://API.moonshot.cn/anthropic/')?.preset.id).toBe('moonshot')
    expect(providerForBaseUrl('https://api.moonshot.cn/anthropic')?.region.id).toBe('china')
    expect(providerForBaseUrl('https://openrouter.ai/api')?.preset.id).toBe('openrouter')
    expect(providerForBaseUrl('https://example.com')).toBeUndefined()
  })

  it('reports retirements for the provider that retires them only', () => {
    expect(modelNotices('moonshot', ['kimi-k2.7-code'])).toHaveLength(1)
    expect(modelNotices('moonshot', ['kimi-k2.7-code'])[0]).toMatch(/December 2026/)
    expect(modelNotices('moonshot', ['kimi-k3[1m]'])).toEqual([])
    expect(modelNotices('ollama-cloud', ['kimi-k2.7-code'])).toEqual([])
    expect(modelNotices('deepseek', ['deepseek-chat'])[0]).toMatch(/discontinued/)
    expect(modelNotices('minimax', ['MiniMax-M2.7'])[0]).toMatch(/18 Nov 2026/)
  })

  it('labels models from the preset', () => {
    const moonshot = findProvider('moonshot')!
    expect(modelLabel(moonshot, 'kimi-k3[1m]')).toBe('Kimi K3')
    expect(modelLabel(moonshot, 'kimi-k3')).toBe('Kimi K3')
    expect(modelLabel(moonshot, 'something-new[1m]')).toBe('something-new')
  })

  it("shows Anthropic's caveat on every third-party provider", () => {
    for (const p of providers) {
      const hasCaveat = p.notes.includes(ANTHROPIC_CAVEAT)
      expect(hasCaveat).toBe(p.kind !== 'anthropic' && p.kind !== 'cloud')
    }
  })

  it('hands out copies', () => {
    const copy = listProviders()
    copy[0].name = 'changed'
    expect(listProviders()[0].name).not.toBe('changed')
  })
})
