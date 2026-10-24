/**
 * Pure helpers for the Models page and the provider setup wizard: provider grouping and tags, model lists, slot
 * defaults, validation, connection-test verdicts and apply-result wording. No React or DOM (unit-tested in Node).
 */
import type { ConnectionTestResult, ModelPreset, ModelProfile, ModelSlot, ModelStatus, ProviderPreset } from '@shared/types'
import type { KeyValueRow } from './keyValueRows'

/** Same tones as the Badge component (kept local so this file stays free of UI imports). */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'
export type ProviderTag = ProviderPreset['tags'][number]

export const MODEL_SLOTS: readonly ModelSlot[] = ['main', 'opus', 'sonnet', 'haiku', 'fable', 'subagent']

/** Short form of Anthropic's caveat, shown wherever a third-party model is configured. */
export const CAVEAT = 'Anthropic doesn’t support using Claude Code with non-Claude models — some features may not work.'

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

export interface TagMeta {
  /** Advanced-mode label. */
  label: string
  /** Plain-words label for Simple mode. */
  simple: string
  tone: BadgeTone
}

export const TAG_META: Record<ProviderTag, TagMeta> = {
  popular: { label: 'Popular', simple: 'Popular', tone: 'accent' },
  free: { label: 'Free', simple: 'Free', tone: 'success' },
  cheap: { label: 'Cheap', simple: 'Low cost', tone: 'success' },
  fast: { label: 'Fast', simple: 'Fast', tone: 'info' },
  'long-context': { label: 'Long context', simple: 'Big projects', tone: 'neutral' },
  local: { label: 'Local', simple: 'Runs on your computer', tone: 'neutral' },
  'coding-plan': { label: 'Coding plan', simple: 'Monthly plan', tone: 'neutral' },
  'needs-proxy': { label: 'Needs proxy', simple: 'Keeps Claude Setup open', tone: 'warn' },
  china: { label: 'China region', simple: 'China region', tone: 'neutral' }
}

/** Display order of tags on cards and in the filter row. */
export const TAG_ORDER: readonly ProviderTag[] = [
  'popular',
  'free',
  'cheap',
  'fast',
  'long-context',
  'local',
  'coding-plan',
  'needs-proxy',
  'china'
]

/** A provider's tags in display order. */
export function sortedTags(preset: ProviderPreset): ProviderTag[] {
  return TAG_ORDER.filter((tag) => preset.tags.includes(tag))
}

/** Uses a non-Claude model (everything except Anthropic itself and the official Claude clouds). */
export function isThirdParty(preset: ProviderPreset): boolean {
  return preset.kind !== 'anthropic' && preset.kind !== 'cloud'
}

/** The user types the server address (custom endpoints, any OpenAI-compatible server). */
export function isUserDefined(preset: ProviderPreset): boolean {
  return preset.kind !== 'cloud' && preset.regions.length > 0 && preset.regions.every((r) => !r.baseUrl)
}

/** Reached through Claude Setup's local translation proxy. */
export function usesProxy(preset: ProviderPreset): boolean {
  return preset.kind === 'openai-proxy'
}

export type ProviderGroupId = 'direct' | 'plans' | 'local' | 'proxy' | 'cloud' | 'custom' | 'claude'

export interface ProviderGroup {
  id: ProviderGroupId
  title: string
  description: string
}

export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  { id: 'direct', title: 'Pay as you go', description: 'Create an account, add some credit and paste an API key.' },
  { id: 'plans', title: 'Coding plans', description: 'Monthly subscriptions made for coding tools.' },
  { id: 'local', title: 'On your computer', description: 'Free and private — the model runs on this machine.' },
  {
    id: 'proxy',
    title: 'Through Claude Setup’s proxy',
    description: 'OpenAI-style providers. Claude Setup translates for Claude Code.'
  },
  { id: 'cloud', title: 'Claude in your cloud account', description: 'Claude models billed through AWS, Google Cloud or Azure.' },
  { id: 'custom', title: 'Custom', description: 'Your own server or your company’s gateway.' },
  { id: 'claude', title: 'Claude', description: 'Anthropic’s own models — the default.' }
]

/** Which gallery group a provider belongs to. */
export function providerGroup(preset: ProviderPreset): ProviderGroupId {
  if (preset.kind === 'anthropic') return 'claude'
  if (preset.kind === 'cloud') return 'cloud'
  if (preset.kind === 'local') return 'local'
  if (isUserDefined(preset) || preset.kind === 'custom') return 'custom'
  if (preset.kind === 'openai-proxy') return 'proxy'
  return preset.tags.includes('coding-plan') ? 'plans' : 'direct'
}

/** Providers grouped for the "all providers" view (empty groups dropped, original order kept inside a group). */
export function groupProviders(
  list: readonly ProviderPreset[],
  opts: { includeClaude?: boolean } = {}
): Array<ProviderGroup & { providers: ProviderPreset[] }> {
  return PROVIDER_GROUPS.filter((g) => g.id !== 'claude' || opts.includeClaude)
    .map((group) => ({ ...group, providers: list.filter((p) => providerGroup(p) === group.id) }))
    .filter((group) => group.providers.length > 0)
}

/**
 * The friendly picks shown first in Simple mode: popular third-party providers, then free/local/cheap ones. A family
 * (one service sold several ways, like Kimi) appears once, as its first variant — the wizard offers the others.
 */
export function featuredProviders(list: readonly ProviderPreset[], limit = 8): ProviderPreset[] {
  const seenFamilies = new Set<string>()
  const eligible = list.filter((p) => {
    if (p.kind === 'anthropic' || p.kind === 'cloud' || isUserDefined(p) || p.kind === 'custom') return false
    if (!p.family) return true
    if (seenFamilies.has(p.family.id)) return false
    seenFamilies.add(p.family.id)
    return true
  })
  const popular = eligible.filter((p) => p.tags.includes('popular'))
  const score = (p: ProviderPreset): number =>
    (p.tags.includes('free') ? 4 : 0) +
    (p.tags.includes('local') ? 2 : 0) +
    (p.tags.includes('cheap') ? 1 : 0) +
    (p.tags.includes('fast') ? 1 : 0)
  const rest = eligible.filter((p) => !p.tags.includes('popular')).sort((a, b) => score(b) - score(a))
  return [...popular, ...rest].slice(0, limit)
}

/** Every variant of a provider's family (just the provider itself when it has none), in list order. */
export function familyVariants(preset: ProviderPreset, list: readonly ProviderPreset[]): ProviderPreset[] {
  if (!preset.family) return [preset]
  const variants = list.filter((p) => p.family?.id === preset.family?.id)
  return variants.length ? variants : [preset]
}

/** The family variant a pasted key clearly belongs to, when it isn't a key for `preset` (mirrors the core's rule). */
export function variantForKey(preset: ProviderPreset, list: readonly ProviderPreset[], key: string): ProviderPreset | undefined {
  const value = key.trim()
  if (!preset.family || !value || keyMatches(preset, value)) return undefined
  return familyVariants(preset, list).find((p) => p.id !== preset.id && keyMatches(p, value))
}

/** The literal start of a provider's keys ("sk-kimi-"), when its key pattern is a plain prefix. */
export function keyPrefixOf(preset: ProviderPreset): string | undefined {
  const pattern = preset.keyPattern
  return pattern && /^\^[A-Za-z0-9_-]+$/.test(pattern) ? pattern.slice(1) : undefined
}

function keyMatches(preset: ProviderPreset, key: string): boolean {
  if (!preset.keyPattern) return false
  try {
    return new RegExp(preset.keyPattern).test(key)
  } catch {
    return false
  }
}

/** Free-text search over name, vendor, description, models and tag labels. */
export function matchesProvider(preset: ProviderPreset, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [
    preset.name,
    preset.vendor,
    preset.description,
    preset.id,
    ...preset.models.flatMap((m) => [m.id, m.label]),
    ...preset.tags.flatMap((t) => [TAG_META[t].label, TAG_META[t].simple])
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Matches Anthropic's caveat (the core appends it to every third-party provider's notes). */
export function isCaveatNote(note: string): boolean {
  return /anthropic/i.test(note) && /(non-claude|third-party|not affiliated)/i.test(note)
}

/** Provider notes without the caveat (the UI shows the caveat separately). */
export function providerNotes(preset: ProviderPreset): string[] {
  return preset.notes.filter((note) => !isCaveatNote(note))
}

/** "platform.kimi.ai" for a URL (or the input when it isn't one). */
export function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────────────────────────────────────

/** Claude Code's `[1m]` suffix marks a 1M-context variant; it is stripped before requests are sent. */
export function stripContextSuffix(id: string): string {
  return id.trim().replace(/\[1m\]$/i, '')
}

/** True for Claude model ids (direct, gateway-prefixed or cloud-prefixed). Mirrors the core's rule. */
export function isClaudeModel(id: string): boolean {
  const clean = id.trim().replace(/^claude-code\//i, '')
  return /(^|[/.~])claude-(opus|sonnet|haiku|fable|mythos|\d)/i.test(clean)
}

/** A model by id (exact first, then ignoring the `[1m]` suffix). */
export function findModel(models: readonly ModelPreset[], id: string | undefined): ModelPreset | undefined {
  if (!id) return undefined
  return models.find((m) => m.id === id) ?? models.find((m) => stripContextSuffix(m.id) === stripContextSuffix(id))
}

/** Friendly label of a model id ("Kimi K3"), falling back to the id without its suffix. */
export function modelLabel(models: readonly ModelPreset[] | undefined, id: string | undefined): string {
  if (!id) return ''
  return findModel(models ?? [], id)?.label ?? stripContextSuffix(id)
}

/**
 * Preset models first (they carry curated labels and notes, plus the window the live list reports for the account),
 * then extra ones not already listed.
 */
export function mergeModels(base: readonly ModelPreset[], extra: readonly ModelPreset[]): ModelPreset[] {
  const live = new Map(extra.map((m) => [m.id, m.liveContext]))
  const out = base.map((m) => {
    const liveContext = live.get(m.id)
    return liveContext && liveContext !== m.liveContext ? { ...m, liveContext } : m
  })
  const ids = new Set(base.map((m) => m.id))
  for (const model of extra) {
    if (!ids.has(model.id)) {
      ids.add(model.id)
      out.push(model)
    }
  }
  return out
}

/** Short facts about a model: "1M context", "Always thinks", "Sees images". */
export function modelFacts(model: ModelPreset | undefined, formatTokens: (n: number) => string): string[] {
  if (!model) return []
  const facts: string[] = []
  if (model.context) facts.push(`${formatTokens(model.context)} context`)
  if (model.thinking === 'always') facts.push('Always thinks')
  else if (model.thinking === 'optional') facts.push('Can think step by step')
  if (model.vision) facts.push('Sees images')
  return facts
}

/** The model's note mentions a retirement or deprecation. */
export function isRetiring(model: ModelPreset | undefined): boolean {
  return !!model?.notes && /(retir|deprecat|discontinu|switched off)/i.test(model.notes)
}

/** The default "fast" model: the preset's haiku slot, a model recommended for fast work, else the main default. */
export function defaultFastModel(preset: ProviderPreset): string {
  return preset.defaults.haiku || preset.models.find((m) => m.recommendedFor?.includes('fast'))?.id || preset.defaults.main
}

/**
 * Every slot's model, exactly as the core resolves them: explicit overrides win; the haiku slot uses the fast model;
 * other slots follow the preset defaults while the main model is the preset default, else they use the main model.
 */
export function effectiveSlots(
  preset: ProviderPreset,
  main: string,
  fast: string,
  overrides: Partial<Record<ModelSlot, string>> = {}
): Record<ModelSlot, string> {
  const mainId = main.trim()
  const usesDefaults = mainId !== '' && mainId === preset.defaults.main
  const out = {} as Record<ModelSlot, string>
  for (const slot of MODEL_SLOTS) {
    const override = overrides[slot]?.trim()
    if (slot === 'main') out.main = mainId
    else if (override) out[slot] = override
    else if (slot === 'haiku' && fast.trim()) out.haiku = fast.trim()
    else out[slot] = usesDefaults ? preset.defaults[slot] || mainId : mainId
  }
  return out
}

export const SLOT_LABELS: Record<ModelSlot, { label: string; hint: string; env: string }> = {
  main: { label: 'Main model', hint: 'Used for your conversations.', env: 'ANTHROPIC_MODEL' },
  opus: { label: 'Opus tier', hint: 'Used when you pick “Opus” in /model.', env: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  sonnet: { label: 'Sonnet tier', hint: 'Used when you pick “Sonnet” in /model.', env: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  haiku: {
    label: 'Haiku tier (background)',
    hint: 'Quick background work like titles and summaries.',
    env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
  },
  fable: { label: 'Fable tier', hint: 'Used when you pick “Fable” in /model.', env: 'ANTHROPIC_DEFAULT_FABLE_MODEL' },
  subagent: { label: 'Subagents', hint: 'Helpers Claude starts for parallel work.', env: 'CLAUDE_CODE_SUBAGENT_MODEL' }
}

/** A model name must be a single token without spaces or control characters. */
export function modelIdError(id: string): string | undefined {
  const value = id.trim()
  if (!value) return undefined
  if (value.length > 200) return 'That model name is too long.'
  if (/[\s\u0000-\u001f]/.test(value)) return 'Model names can’t contain spaces.'
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compatibility mode default: always on for proxy providers, off for Claude itself and the clouds, the provider's own
 * default when it has one, else on for non-Claude models. Mirrors the core's rule.
 */
export function defaultCompatMode(preset: ProviderPreset, main: string): boolean {
  if (preset.kind === 'anthropic' || preset.kind === 'cloud') return false
  if (preset.kind === 'openai-proxy') return true
  if (preset.compatDefault !== undefined) return preset.compatDefault
  return !isClaudeModel(main)
}

/** Variables the core never accepts as extras (they come from the provider, the key field or the model choices). */
export const PROTECTED_ENV: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL'
]

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validation for one extra environment variable. */
export function envVarError(key: string, value: string): string | undefined {
  if (!ENV_NAME.test(key)) return 'Use letters, numbers and _ only, and don’t start with a number.'
  if (PROTECTED_ENV.includes(key)) return `${key} is set for you by the steps above.`
  if (/[\u0000]/.test(value)) return 'The value contains an invalid character.'
  return undefined
}

/** Parse a token count typed by the user ("262144", "262,144"). undefined = empty, null = invalid. */
export function parseTokenCount(text: string): number | undefined | null {
  const clean = text.replace(/[\s,_]/g, '')
  if (!clean) return undefined
  if (!/^\d+$/.test(clean)) return null
  const value = Number(clean)
  return Number.isSafeInteger(value) ? value : null
}

/** Message for an invalid context window (core accepts 1,024 – 10,000,000 tokens). */
export function contextWindowError(text: string): string | undefined {
  const value = parseTokenCount(text)
  if (value === undefined) return undefined
  if (value === null) return 'Enter a whole number of tokens, like 262144.'
  if (value < 1024 || value > 10_000_000) return 'Use a value between 1,024 and 10,000,000 tokens.'
  return undefined
}

/** Message for a pasted API key that can't be right. */
export function apiKeyError(key: string): string | undefined {
  let clean = key.trim().replace(/^["']|["']$/g, '').trim()
  clean = clean.replace(/^Bearer\s+/i, '')
  if (/\s/.test(clean)) return 'The key contains spaces or line breaks. Copy it again from the provider’s website.'
  return undefined
}

export interface CloudField {
  key: string
  label: string
  hint?: string
  required: boolean
  defaultValue: string
  placeholder: string
}

const CLOUD_LABELS: Record<string, { label: string; hint?: string }> = {
  AWS_REGION: { label: 'AWS region', hint: 'The region where Claude is enabled, for example us-east-1.' },
  AWS_PROFILE: { label: 'AWS profile', hint: 'The profile you signed in with (aws sso login).' },
  CLOUD_ML_REGION: { label: 'Region', hint: '“global” works for most projects.' },
  ANTHROPIC_VERTEX_PROJECT_ID: { label: 'Google Cloud project ID', hint: 'Shown at the top of the Google Cloud console.' },
  ANTHROPIC_FOUNDRY_RESOURCE: { label: 'Foundry resource name', hint: 'Just the name, not a web address.' }
}

/** "SOME_THING_ID" → "Some thing id". */
function humanizeEnv(key: string): string {
  const words = key.toLowerCase().split('_').filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Fields the user fills for an official cloud provider (values in <angle brackets> are required). */
export function cloudFields(preset: ProviderPreset): CloudField[] {
  return Object.entries(preset.cloudEnv ?? {})
    .filter(([key]) => !key.startsWith('CLAUDE_CODE_USE_'))
    .map(([key, value]) => {
      const template = /^<(.+)>$/.exec(value.trim())
      const meta = CLOUD_LABELS[key]
      return {
        key,
        label: meta?.label ?? humanizeEnv(key),
        hint: meta?.hint,
        required: !!template,
        defaultValue: template ? '' : value,
        placeholder: template ? (template[1] ?? '') : value
      }
    })
}

/** A friendly, unique profile name for a provider + main model. */
export function suggestProfileName(preset: ProviderPreset, main: string, existing: readonly string[]): string {
  const label = modelLabel(preset.models, main)
  const provider = preset.name.replace(/\s*\(.*\)\s*$/, '').trim() || preset.name
  let base: string
  if (preset.kind === 'anthropic') base = 'Claude with an API key'
  else if (!label) base = provider
  else if (label.toLowerCase().includes(provider.toLowerCase().split(' ')[0] ?? '')) base = label
  else base = `${provider} · ${label}`
  base = base.slice(0, 72).trim()
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base
}

/** Message for an invalid profile name. */
export function profileNameError(name: string): string | undefined {
  const value = name.trim()
  if (!value) return 'Give this setup a name.'
  if (value.length > 80) return 'Use at most 80 characters.'
  return undefined
}

/** Extra env rows without the cloud fields (those have their own inputs). */
export function extraEnvWithout(record: Record<string, string>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

/** Count rows that will actually be saved. */
export function filledRows(rows: readonly KeyValueRow[]): number {
  return rows.filter((r) => r.key.trim()).length
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection test & apply results
// ─────────────────────────────────────────────────────────────────────────────

export type VerdictAction = 'key' | 'models' | 'address' | 'retry' | 'billing'

export interface VerdictInfo {
  title: string
  tone: BadgeTone
  tips: string[]
  /** The most useful next step for this verdict. */
  action?: VerdictAction
}

/** Headline, tone and next steps for a connection test result. */
export function verdictInfo(result: Pick<ConnectionTestResult, 'verdict'>, preset: ProviderPreset): VerdictInfo {
  const where = preset.vendor && preset.vendor !== 'Custom' ? preset.vendor : preset.name
  switch (result.verdict) {
    case 'ok':
      return { title: 'It works!', tone: 'success', tips: [] }
    case 'bad-key': {
      const tips = [`Copy the key again from ${where} and make sure nothing is cut off.`]
      if (preset.regions.length > 1) tips.push('Check the region: a key only works in the region where it was created.')
      tips.push('A brand-new key can take a minute to start working.')
      return { title: 'The key didn’t work', tone: 'danger', tips, action: 'key' }
    }
    case 'bad-model':
      return {
        title: 'That model wasn’t accepted',
        tone: 'warn',
        tips: [`Pick another model, or load the current list from ${preset.name}.`, 'Your plan may not include this model.'],
        action: 'models'
      }
    case 'bad-url':
      return {
        title: 'Nothing answered at that address',
        tone: 'danger',
        tips: [
          usesProxy(preset)
            ? 'OpenAI-style addresses usually end with /v1, for example http://localhost:8000/v1.'
            : 'Anthropic-style addresses don’t end with /v1 — Claude Code adds that itself.',
          'Check for typos and that the server is the right one.'
        ],
        action: 'address'
      }
    case 'quota':
      return {
        title: 'Your account is out of credit',
        tone: 'warn',
        tips: [`Add credit or check your plan on ${where}’s website, then test again.`],
        action: 'billing'
      }
    case 'network':
      return {
        title: `Couldn’t reach ${preset.name}`,
        tone: 'danger',
        tips:
          preset.kind === 'local'
            ? [`Make sure ${preset.name} is open and running on this computer.`, 'Then test again.']
            : ['Check your internet connection, VPN or company proxy.', 'Then test again.'],
        action: 'retry'
      }
    default:
      return {
        title: 'Something unexpected happened',
        tone: 'warn',
        tips: ['Read the message below. You can continue anyway and try it in Claude Code.'],
        action: 'retry'
      }
  }
}

export interface ClassifiedWarnings {
  /** "Restart Claude Code…", "Reload VS Code…". */
  steps: string[]
  caveat?: string
  notes: string[]
}

/** Split apply/reset warnings into next steps, the caveat and other notes. */
export function classifyWarnings(warnings: readonly string[]): ClassifiedWarnings {
  const out: ClassifiedWarnings = { steps: [], notes: [] }
  for (const warning of warnings) {
    if (/^(restart|reload)\b/i.test(warning.trim())) out.steps.push(warning)
    else if (isCaveatNote(warning)) out.caveat ??= warning
    else out.notes.push(warning)
  }
  return out
}

export const TARGET_LABELS: Record<'claude-code' | 'vscode', { title: string; description: string }> = {
  'claude-code': { title: 'Terminal (Claude Code)', description: 'The claude command in your terminal.' },
  vscode: { title: 'VS Code', description: 'The Claude Code extension in VS Code.' }
}

export interface StatusHeadline {
  title: string
  subtitle: string
}

/** Main line + secondary line of the "Claude Code is using…" banner. */
export function statusHeadline(
  status: ModelStatus,
  preset: ProviderPreset | undefined,
  profile: ModelProfile | undefined
): StatusHeadline {
  if (status.mode === 'anthropic') {
    return { title: 'Official Claude (Anthropic)', subtitle: 'Your Claude account or Anthropic API key — the default.' }
  }
  const model = status.model ? modelLabel(preset?.models, status.model) : ''
  if (status.mode === 'cloud') {
    return {
      title: `Claude via ${status.providerName ?? preset?.name ?? 'your cloud account'}`,
      subtitle: model || 'Claude models in your cloud account.'
    }
  }
  const provider =
    status.providerName ?? preset?.name ?? profile?.name ?? (status.baseUrl ? hostOf(status.baseUrl) : 'A custom provider')
  return { title: provider, subtitle: model || 'A third-party model.' }
}
