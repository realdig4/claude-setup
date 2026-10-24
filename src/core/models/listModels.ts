/**
 * Live model lists from providers (OpenAI, Anthropic and Ollama response shapes), normalized to ModelPreset[] and
 * merged with the preset's curated models. Any failure falls back to the preset's static list.
 */
import type { ConnectionTestInput, ModelPreset, ProviderPreset } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject } from '../fs/json'
import { fetchJson } from '../http'
import { LIST_ID_PREFIX, NO_CONTEXT_SUFFIX } from './providers'
import { resolveConnection } from './resolve'
import { hasContextSuffix, hostOf, joinUrl, stripContextSuffix } from './urls'

/** One entry of a provider's live list, before merging. */
export interface LiveModel {
  id: string
  label?: string
  context?: number
  vision?: boolean
  thinking?: boolean
}

const LIST_TIMEOUT_MS = 10_000
const MAX_MODELS = 1000
const CHAT_TYPES = new Set(['model', 'language', 'chat', 'text', 'llm', 'text-generation'])
const NON_CHAT = new RegExp(
  ['embed', 'whisper', 'tts', 'dall-e', 'moderation', 'transcri', 'speech', 'rerank', 'guard', 'lyria', 'imagen', 'veo-', 'sora']
    .concat(['-image', 'image-\\d', 'nano-banana', 'audio', 'realtime', 'babbage', 'davinci', 'orpheus'])
    .join('|'),
  'i'
)

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v)
  return undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : []
}

/** Resolve the list URL: absolute, '/path' under the base URL, or '{origin}/path' under the base URL's origin. */
export function resolveListUrl(spec: string, baseUrl: string): string {
  if (spec.startsWith('{origin}')) return new URL(baseUrl).origin + spec.slice('{origin}'.length)
  if (spec.startsWith('/')) return joinUrl(baseUrl, spec)
  return spec
}

/** Parse any supported list shape. Returns null for error bodies (e.g. Z.ai's HTTP 200 + {"code":401}). */
export function parseModelList(body: unknown): LiveModel[] | null {
  let items: unknown[] | undefined
  if (Array.isArray(body)) items = body
  else if (isPlainObject(body)) {
    if (Array.isArray(body.data)) items = body.data
    else if (Array.isArray(body.models)) items = body.models
  }
  if (!items) return null
  const out: LiveModel[] = []
  for (const item of items) {
    if (nonEmptyString(item)) {
      out.push({ id: item.trim() })
      continue
    }
    if (!isPlainObject(item)) continue
    const rawId = [item.id, item.name, item.model].find(nonEmptyString)
    if (!rawId) continue
    if (typeof item.type === 'string' && !CHAT_TYPES.has(item.type.toLowerCase())) continue
    const id = rawId.trim().replace(/^models\//, '')
    const label = [item.display_name, item.displayName, item.name].find((v): v is string => nonEmptyString(v) && v.trim() !== rawId)
    const top = isPlainObject(item.top_provider) ? item.top_provider : {}
    const arch = isPlainObject(item.architecture) ? item.architecture : {}
    const modalities = [...stringList(item.input_modalities), ...stringList(arch.input_modalities)]
    const params = stringList(item.supported_parameters)
    const model: LiveModel = { id }
    if (label) model.label = label.trim()
    const context = firstNumber(
      item.context_length,
      item.context_window,
      item.max_context_length,
      item.max_input_tokens,
      top.context_length,
      item.max_model_len,
      item.contextWindow
    )
    if (context) model.context = context
    if (item.supports_image_in === true || modalities.includes('image')) model.vision = true
    if (item.supports_reasoning === true || params.includes('reasoning') || isPlainObject(item.reasoning)) model.thinking = true
    out.push(model)
  }
  return out
}

/** Merge the live list into the preset's curated models (curated first, then the rest alphabetically). */
export function mergeModels(preset: ProviderPreset, live: LiveModel[]): ModelPreset[] {
  const prefix = LIST_ID_PREFIX[preset.id] ?? ''
  const allowSuffix = !NO_CONTEXT_SUFFIX.has(preset.id) && preset.kind !== 'local'
  const liveByKey = new Map<string, LiveModel>()
  for (const m of live) {
    let id = m.id.replace(/:latest$/i, '')
    if (NON_CHAT.test(id) || /(:|-)batch$/i.test(id)) continue
    if (prefix && !id.startsWith(prefix)) id = prefix + id
    const key = stripContextSuffix(id).toLowerCase()
    if (!liveByKey.has(key)) liveByKey.set(key, { ...m, id })
  }

  const used = new Set<string>()
  const curated: ModelPreset[] = preset.models.map((p) => {
    const key = stripContextSuffix(p.id).toLowerCase()
    const lm = liveByKey.get(key)
    if (!lm) return { ...p }
    used.add(key)
    const merged: ModelPreset = { ...p }
    if (merged.context === undefined && lm.context) merged.context = lm.context
    if (lm.context) merged.liveContext = lm.context
    if (merged.vision === undefined && lm.vision) merged.vision = true
    return merged
  })

  const extras: ModelPreset[] = []
  for (const [key, m] of liveByKey) {
    if (used.has(key)) continue
    const longContext = allowSuffix && m.context !== undefined && m.context >= 1_000_000 && !hasContextSuffix(m.id)
    const entry: ModelPreset = { id: longContext ? `${m.id}[1m]` : m.id, label: m.label ?? m.id }
    if (m.context) {
      entry.context = m.context
      entry.liveContext = m.context
    }
    if (m.vision) entry.vision = true
    if (m.thinking) entry.thinking = 'optional'
    extras.push(entry)
  }
  extras.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  return [...curated, ...extras].slice(0, MAX_MODELS)
}

/** List the models a provider offers (live when possible, otherwise the preset's list). Never throws. */
export async function listModels(ctx: CoreContext, input: ConnectionTestInput): Promise<ModelPreset[]> {
  const resolved = await resolveConnection(ctx, input)
  if ('error' in resolved) return []
  const { preset, baseUrl, key } = resolved
  const fallback = structuredClone(preset.models)
  const spec = preset.listModels
  if (!spec || (!baseUrl && !/^https?:/i.test(spec.url))) return fallback
  // Keyed lists need a key — except servers where the key is optional (local / self-hosted).
  if (spec.auth !== 'none' && !key && preset.requiresKey) return fallback

  let url: string
  try {
    url = resolveListUrl(spec.url, baseUrl)
    if (spec.shape === 'anthropic' && !url.includes('?')) url += '?limit=1000'
  } catch {
    return fallback
  }
  const headers: Record<string, string> = {}
  if (spec.shape === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  if (key && spec.auth === 'bearer') headers.authorization = `Bearer ${key}`
  if (key && spec.auth === 'x-api-key') headers['x-api-key'] = key

  const res = await fetchJson<unknown>(url, { headers, timeoutMs: LIST_TIMEOUT_MS })
  const live = res.ok && res.data !== undefined ? parseModelList(res.data) : null
  if (!live || !live.length) {
    ctx.log.info('models', `Model list from ${hostOf(url)} unavailable (${res.error ?? `HTTP ${res.status}`}); using ${preset.name} presets`)
    return fallback
  }
  ctx.log.debug('models', `Model list from ${hostOf(url)}: ${live.length} models`)
  return mergeModels(preset, live)
}
