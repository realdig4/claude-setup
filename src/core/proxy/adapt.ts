/**
 * Self-healing for picky OpenAI-compatible servers.
 *
 * When an upstream rejects a request (HTTP 400/422) because of an optional field it does not support
 * (`stream_options`, `parallel_tool_calls`, `reasoning_effort`, `max_tokens` vs `max_completion_tokens`, …)
 * or because max_tokens is above the model's output cap, the proxy fixes the payload, retries, and
 * remembers the fix for that upstream/model so later requests succeed on the first try.
 */
import { outputCapFromMessage, type UpstreamErrorDetails } from './errors'
import type { OpenAIRequest } from './wire'

const DROPPABLE = [
  'stream_options',
  'parallel_tool_calls',
  'reasoning_effort',
  'temperature',
  'top_p',
  'stop',
  'prompt_cache_key',
  'response_format'
] as const
/** Optional request fields the proxy may stop sending when an upstream rejects them. */
export type DroppableField = (typeof DROPPABLE)[number]

/** One fix to a rejected upstream payload. */
export type Adaptation =
  | { kind: 'drop'; field: DroppableField }
  | { kind: 'rename-max-tokens'; to: 'max_tokens' | 'max_completion_tokens' }
  | { kind: 'cap-output'; value: number }
  | { kind: 'empty-content' }

const KNOWN_FIELDS = new Set<string>([...DROPPABLE, 'max_tokens', 'max_completion_tokens'])
const UNSUPPORTED_WORDING = new RegExp(
  [
    'unsupported',
    'not supported',
    'does not support',
    'unknown (?:name|field|parameter|argument)',
    'unrecognized',
    'extra (?:inputs|fields)',
    'not permitted',
    'not allowed',
    'cannot find field',
    'invalid (?:field|parameter|argument)'
  ].join('|'),
  'i'
)
const NULL_CONTENT_WORDING = /\bnull\b|\bnone\b|expected (?:a )?string|must be (?:a )?string|is required/i
const FIELD_PATTERNS = [
  /unknown name "([a-z_]+)"/i,
  /unsupported (?:parameter|value|field|argument):? ['"`]?([a-z_]+)['"`]?/i,
  /unrecognized request arguments? supplied:? ['"`]?([a-z_]+)/i,
  /'loc': \('body', '([a-z_]+)'/i,
  /"loc":\s*\[\s*"body",\s*"([a-z_]+)"/i,
  /body\.([a-z_]+): /i,
  /['"`]([a-z_]+)['"`] is not (?:supported|permitted|allowed)/i,
  /\b([a-z_]+) is not (?:supported|permitted|allowed)/i,
  /does not support (?:the )?['"`]?([a-z_]+)/i,
  /(?:parameter|field|argument) ['"`]?([a-z_]+)['"`]? (?:is )?(?:not supported|unsupported|not allowed|not permitted)/i
]

function unsupportedField(details: UpstreamErrorDetails): string | undefined {
  const byCode = details.code === 'unsupported_parameter' || details.code === 'unsupported_value'
  if (!byCode && !UNSUPPORTED_WORDING.test(details.message)) return undefined
  const param = details.param?.replace(/^body\./, '')
  if (param && KNOWN_FIELDS.has(param)) return param
  for (const pattern of FIELD_PATTERNS) {
    const m = pattern.exec(details.message)
    if (m && KNOWN_FIELDS.has(m[1].toLowerCase())) return m[1].toLowerCase()
  }
  return undefined
}

/** The fix for a rejected request, or null when the error is not something the proxy can adapt to. */
export function adaptationForError(payload: OpenAIRequest, status: number, details: UpstreamErrorDetails): Adaptation | null {
  if (status !== 400 && status !== 422) return null
  const current = payload.max_completion_tokens ?? payload.max_tokens
  const cap = outputCapFromMessage(details.message)
  if (cap !== undefined && current !== undefined && cap < current) return { kind: 'cap-output', value: cap }

  const field = unsupportedField(details)
  if (field === 'max_tokens' && payload.max_tokens !== undefined) {
    return { kind: 'rename-max-tokens', to: 'max_completion_tokens' }
  }
  if (field === 'max_completion_tokens' && payload.max_completion_tokens !== undefined) {
    return { kind: 'rename-max-tokens', to: 'max_tokens' }
  }
  if (field && (DROPPABLE as readonly string[]).includes(field) && payload[field as DroppableField] !== undefined) {
    return { kind: 'drop', field: field as DroppableField }
  }

  const nullContent = payload.messages.some((m) => m.role === 'assistant' && m.content === null)
  if (nullContent && /content/i.test(details.message) && NULL_CONTENT_WORDING.test(details.message)) return { kind: 'empty-content' }
  return null
}

/** Apply a fix in place. Returns true when the payload changed. */
export function applyAdaptation(payload: OpenAIRequest, adaptation: Adaptation): boolean {
  switch (adaptation.kind) {
    case 'drop':
      if (payload[adaptation.field] === undefined) return false
      delete payload[adaptation.field]
      return true
    case 'rename-max-tokens': {
      const from = adaptation.to === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      const value = payload[from]
      if (value === undefined) return false
      delete payload[from]
      payload[adaptation.to] = value
      return true
    }
    case 'cap-output': {
      let changed = false
      if (payload.max_tokens !== undefined && payload.max_tokens > adaptation.value) {
        payload.max_tokens = adaptation.value
        changed = true
      }
      if (payload.max_completion_tokens !== undefined && payload.max_completion_tokens > adaptation.value) {
        payload.max_completion_tokens = adaptation.value
        changed = true
      }
      return changed
    }
    case 'empty-content': {
      let changed = false
      for (const m of payload.messages) {
        if (m.role === 'assistant' && m.content === null) {
          m.content = ''
          changed = true
        }
      }
      return changed
    }
  }
}

/** Short description for logs, phrased to follow the upstream's name ("OpenAI does not accept …"). */
export function describeAdaptation(adaptation: Adaptation): string {
  switch (adaptation.kind) {
    case 'drop':
      return `does not accept "${adaptation.field}"`
    case 'rename-max-tokens':
      return `expects "${adaptation.to}" for the output limit`
    case 'cap-output':
      return `allows at most ${adaptation.value} output tokens`
    case 'empty-content':
      return 'does not accept empty (null) message content'
  }
}

/** Fixes learned per upstream + model (kept in memory; cleared when the proxy config changes). */
export class AdaptationMemory {
  private readonly learned = new Map<string, Adaptation[]>()

  constructor(private readonly maxKeys = 200) {}

  get(key: string): Adaptation[] {
    return this.learned.get(key) ?? []
  }

  remember(key: string, adaptation: Adaptation): void {
    const list = this.learned.get(key) ?? []
    const same = (a: Adaptation): boolean => JSON.stringify(a) === JSON.stringify(adaptation)
    if (!list.some(same)) list.push(adaptation)
    this.learned.delete(key)
    this.learned.set(key, list)
    while (this.learned.size > this.maxKeys) this.learned.delete(this.learned.keys().next().value as string)
  }

  clear(): void {
    this.learned.clear()
  }
}
