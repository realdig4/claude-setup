/**
 * OpenAI Chat Completions response → Anthropic Messages response (research_proxy.md §6.3),
 * plus helpers shared with the streaming translator (usage, stop reason, tool arguments, ids).
 */
import { randomUUID } from 'node:crypto'
import type { ToolNameMapper } from '../names'
import { estimateTextTokens } from '../tokens'
import {
  isObject,
  type AnthropicContentOut,
  type AnthropicMessageOut,
  type AnthropicStopReason,
  type AnthropicUsage,
  type JsonObject,
  type OpenAIResponse
} from '../wire'

function randomId(): string {
  return randomUUID().replace(/-/g, '')
}

/** A fresh Anthropic-style message id (`msg_…`). */
export function newMessageId(): string {
  return `msg_${randomId()}`
}

/** A fresh Anthropic-style tool_use id (`toolu_…`). */
export function newToolUseId(): string {
  return `toolu_${randomId()}`
}

/** Placeholder signature for thinking blocks (Claude Code replays it verbatim; verified). */
export function fakeSignature(): string {
  return `proxy-${randomId()}`
}

/**
 * Hands out tool_use ids: keeps the upstream's id when usable, otherwise (missing, reused within the
 * conversation, or containing characters unsafe for file names) generates a fresh `toolu_…` id.
 */
export class ToolIdAllocator {
  private readonly used: Set<string>

  constructor(reserved?: Iterable<string>) {
    this.used = new Set(reserved ?? [])
  }

  take(candidate: unknown): string {
    let id = typeof candidate === 'string' ? candidate.trim() : ''
    if (id && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) id = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
    if (!id || this.used.has(id)) id = newToolUseId()
    this.used.add(id)
    return id
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool arguments
// ─────────────────────────────────────────────────────────────────────────────

/** Result of parsing tool-call arguments. */
export interface ParsedArguments {
  input: JsonObject
  /** false when the arguments could not be read as a JSON object (input is then `{_raw_arguments}`). */
  ok: boolean
}

/** Remove commas directly before `}` / `]`, ignoring string contents. */
export function removeTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

function parseObject(text: string): JsonObject | undefined {
  try {
    let value: unknown = JSON.parse(text)
    // Some providers double-encode: "{\"a\":1}"
    if (typeof value === 'string') value = JSON.parse(value)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse tool-call arguments. Safe repairs only (trailing commas, markdown fences, double encoding);
 * truncated JSON is never "completed", so a cut-off call cannot run with partial input.
 */
export function parseToolArguments(raw: unknown): ParsedArguments {
  if (isObject(raw)) return { input: raw, ok: true }
  if (raw === undefined || raw === null) return { input: {}, ok: true }
  const text = (typeof raw === 'string' ? raw : JSON.stringify(raw)).trim()
  if (!text) return { input: {}, ok: true }
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text)?.[1]
  for (const candidate of [text, fenced, removeTrailingCommas(fenced ?? text)]) {
    if (candidate === undefined) continue
    const parsed = parseObject(candidate)
    if (parsed) return { input: parsed, ok: true }
  }
  return { input: { _raw_arguments: typeof raw === 'string' ? raw : text }, ok: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage / stop reason
// ─────────────────────────────────────────────────────────────────────────────

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/** OpenAI usage → Anthropic usage (cached prompt tokens reported as cache reads). */
export function mapUsage(usage: unknown, fallbackInput: number, fallbackOutput = 0): AnthropicUsage {
  const u = isObject(usage) ? usage : {}
  const details = isObject(u.prompt_tokens_details) ? u.prompt_tokens_details : {}
  const cached = count(details.cached_tokens) ?? count(u.prompt_cache_hit_tokens) ?? 0
  const prompt = count(u.prompt_tokens)
  return {
    input_tokens: prompt === undefined ? fallbackInput : Math.max(0, prompt - cached),
    output_tokens: count(u.completion_tokens) ?? fallbackOutput,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0
  }
}

/**
 * finish_reason → stop_reason. `length` always means truncation (max_tokens); otherwise any tool call means
 * tool_use (Gemini reports `stop` with tool calls). Never `refusal`: Claude Code turns that into a policy message.
 */
export function mapStopReason(finish: string | null | undefined, hasToolUse: boolean): AnthropicStopReason {
  if (finish === 'length') return 'max_tokens'
  return hasToolUse ? 'tool_use' : 'end_turn'
}

/** Text of an OpenAI message field (string, or an array of content parts). */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => (typeof part === 'string' ? part : isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** Rough output-token count of produced content (used when the upstream reports no usage). */
export function estimateOutputTokens(content: AnthropicContentOut[]): number {
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += estimateTextTokens(block.text)
    else if (block.type === 'thinking') total += estimateTextTokens(block.thinking)
    else total += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input))
  }
  return total
}

// ─────────────────────────────────────────────────────────────────────────────
// Message
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs for translating one non-streaming upstream response. */
export interface ResponseTranslationOptions {
  /** Model name exactly as the client requested it (echoed back). */
  requestedModel: string
  names: ToolNameMapper
  inputEstimate: number
  /** tool_use ids already present in the conversation. */
  reservedIds?: Iterable<string>
  onWarning?: (message: string) => void
}

/** Translate a non-streaming Chat Completions body. */
export function toAnthropicMessage(json: unknown, opts: ResponseTranslationOptions): AnthropicMessageOut {
  const body: OpenAIResponse = isObject(json) ? (json as OpenAIResponse) : {}
  const choices = Array.isArray(body.choices) ? body.choices.filter(isObject) : []
  const choice = choices.find((c) => (c.index ?? 0) === 0) ?? choices[0] ?? {}
  const message = isObject(choice.message) ? choice.message : {}
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null

  const content: AnthropicContentOut[] = []
  const reasoning = textOf(message.reasoning_content) || textOf(message.reasoning)
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: fakeSignature() })
  const text = textOf(message.content) || textOf(message.refusal)
  if (text) content.push({ type: 'text', text })

  const ids = new ToolIdAllocator(opts.reservedIds)
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObject(call)) continue
    const fn = isObject(call.function) ? call.function : {}
    const name = typeof fn.name === 'string' ? fn.name.trim() : ''
    if (!name) {
      opts.onWarning?.('Ignored a tool call without a tool name from the provider.')
      continue
    }
    const args = parseToolArguments(fn.arguments)
    if (!args.ok && finish === 'length') {
      opts.onWarning?.(`Dropped the cut-off call to ${opts.names.restore(name)} (the response hit the output token limit).`)
      continue
    }
    content.push({ type: 'tool_use', id: ids.take(call.id), name: opts.names.restore(name), input: args.input })
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use')
  return {
    id: newMessageId(),
    type: 'message',
    role: 'assistant',
    model: opts.requestedModel,
    content,
    stop_reason: mapStopReason(finish, hasToolUse),
    stop_sequence: null,
    usage: mapUsage(body.usage, opts.inputEstimate, estimateOutputTokens(content))
  }
}
