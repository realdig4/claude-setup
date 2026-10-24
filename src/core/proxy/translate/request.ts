/**
 * Anthropic Messages request → OpenAI Chat Completions request (research_proxy.md §6.2).
 *
 * Verified behaviours kept from the reference proxy:
 *  - system blocks joined with "\n\n"; the `x-anthropic-billing-header:` block and every cache_control dropped
 *  - mid-conversation `role:"system"` entries merged into the previous user message as <system-reminder>
 *  - tool_result blocks become `tool` messages *before* the message's text; images move to a following user message
 *  - tool names shortened to OpenAI's 64-char limit (reverse-mapped on the way back), `$schema` stripped,
 *    server tools and `defer_loading` tools dropped, tool_choice mapped
 *  - max_tokens clamped to the upstream's output cap, reasoning per upstream (`effort` / `roundtrip` / `both`)
 * Additions: consecutive user turns merged, tool-call/result sequences repaired so strict servers accept them,
 * documents (text inlined, PDFs as file parts where supported), JSON output format, OpenAI prompt_cache_key.
 */
import { createHash } from 'node:crypto'
import type { ProxyUpstream } from '@shared/types'
import type { ToolNameMapper } from '../names'
import { isOpenAIReasoningModel, type UpstreamQuirks } from '../quirks'
import {
  isObject,
  type AnthropicBlock,
  type AnthropicMessageParam,
  type AnthropicRequest,
  type AnthropicTool,
  type OpenAIAssistantMessage,
  type OpenAIContentPart,
  type OpenAIMessage,
  type OpenAIRequest,
  type OpenAITool,
  type OpenAIToolCall
} from '../wire'
import { cleanToolSchema } from './schema'

/** System block Claude Code adds for Anthropic billing; meaningless (and cache-busting) upstream. */
export const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'
/** Used when a client omits max_tokens (Claude Code always sends it). */
export const DEFAULT_MAX_TOKENS = 4096
const INTERRUPTED_RESULT = '(no result: the tool call was interrupted)'

// ─────────────────────────────────────────────────────────────────────────────
// Normalization of the untrusted request body
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized request, or the Anthropic-style validation message for a bad body. */
export type ParseResult = { ok: true; request: AnthropicRequest } | { ok: false; message: string }

function isBlock(value: unknown): value is AnthropicBlock {
  return isObject(value) && typeof value.type === 'string'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseTools(raw: unknown): AnthropicTool[] {
  if (!Array.isArray(raw)) return []
  const tools: AnthropicTool[] = []
  for (const t of raw) {
    if (!isObject(t) || typeof t.name !== 'string' || !t.name) continue
    tools.push({
      name: t.name,
      type: typeof t.type === 'string' ? t.type : undefined,
      description: typeof t.description === 'string' ? t.description : undefined,
      input_schema: t.input_schema,
      defer_loading: t.defer_loading === true
    })
  }
  return tools
}

/** Validate and normalize an incoming Messages API body. */
export function parseAnthropicRequest(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, message: 'The request body must be a JSON object.' }
  if (!Array.isArray(raw.messages)) return { ok: false, message: 'messages: Field required' }
  const messages: AnthropicMessageParam[] = []
  for (const m of raw.messages) {
    if (!isObject(m) || typeof m.role !== 'string') continue
    if (typeof m.content === 'string') messages.push({ role: m.role, content: m.content })
    else if (Array.isArray(m.content)) messages.push({ role: m.role, content: m.content.filter(isBlock) })
  }
  const maxTokens = finiteNumber(raw.max_tokens)
  const request: AnthropicRequest = {
    model: typeof raw.model === 'string' ? raw.model : '',
    messages,
    system: typeof raw.system === 'string' ? raw.system : Array.isArray(raw.system) ? raw.system.filter(isBlock) : undefined,
    max_tokens: maxTokens !== undefined && maxTokens >= 1 ? Math.floor(maxTokens) : undefined,
    stream: raw.stream === true,
    temperature: finiteNumber(raw.temperature),
    top_p: finiteNumber(raw.top_p),
    stop_sequences: Array.isArray(raw.stop_sequences)
      ? raw.stop_sequences.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : undefined,
    tools: parseTools(raw.tools)
  }
  if (isObject(raw.tool_choice) && typeof raw.tool_choice.type === 'string') {
    request.tool_choice = {
      type: raw.tool_choice.type,
      name: typeof raw.tool_choice.name === 'string' ? raw.tool_choice.name : undefined,
      disable_parallel_tool_use: raw.tool_choice.disable_parallel_tool_use === true
    }
  }
  if (isObject(raw.thinking) && typeof raw.thinking.type === 'string') {
    request.thinking = { type: raw.thinking.type, budget_tokens: finiteNumber(raw.thinking.budget_tokens) }
  }
  if (isObject(raw.output_config)) {
    request.output_config = {
      effort: typeof raw.output_config.effort === 'string' ? raw.output_config.effort : undefined,
      format: raw.output_config.format
    }
  }
  if (isObject(raw.metadata) && typeof raw.metadata.user_id === 'string') request.metadata = { user_id: raw.metadata.user_id }
  return { ok: true, request }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content helpers
// ─────────────────────────────────────────────────────────────────────────────

function textPart(text: string): OpenAIContentPart {
  return { type: 'text', text }
}

/** System prompt as one string (billing block and cache_control dropped). */
export function systemText(system: AnthropicRequest['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text && !b.text.startsWith(BILLING_HEADER_PREFIX))
    .map((b) => b.text as string)
    .join('\n\n')
}

function blocksText(content: string | AnthropicBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text)
    .map((b) => b.text as string)
    .join('\n')
}

function imagePart(block: AnthropicBlock): OpenAIContentPart | null {
  const source = isObject(block.source) ? block.source : {}
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' && source.media_type ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } }
  return null
}

function documentParts(block: AnthropicBlock, quirks: UpstreamQuirks): OpenAIContentPart[] {
  const source = isObject(block.source) ? block.source : {}
  const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : undefined
  const label = title ? `document "${title}"` : 'document'
  if (source.type === 'text' && typeof source.data === 'string') return [textPart(title ? `${title}\n\n${source.data}` : source.data)]
  if (source.type === 'content') {
    const inner = typeof source.content === 'string' ? [textPart(source.content)] : contentParts(source.content, quirks)
    return title ? [textPart(title), ...inner] : inner
  }
  if (source.type === 'url' && typeof source.url === 'string') return [textPart(`[${label}: ${source.url}]`)]
  if (source.type === 'base64' && typeof source.data === 'string' && source.media_type === 'application/pdf' && quirks.pdfAsFile) {
    const stem = (title ?? 'document').replace(/[^\w.-]+/g, '_').slice(0, 80)
    const filename = stem.toLowerCase().endsWith('.pdf') ? stem : `${stem}.pdf`
    return [{ type: 'file', file: { filename, file_data: `data:application/pdf;base64,${source.data}` } }]
  }
  return [textPart(`[${label} omitted: this model's provider does not accept PDF or file attachments]`)]
}

function searchResultText(block: AnthropicBlock): string {
  const lines = [typeof block.title === 'string' ? block.title : '', typeof block.source === 'string' ? block.source : '']
  if (Array.isArray(block.content)) lines.push(blocksText(block.content.filter(isBlock)))
  return lines.filter(Boolean).join('\n')
}

/** User-side content blocks (text, image, document, search_result) as OpenAI parts. */
function contentParts(content: unknown, quirks: UpstreamQuirks): OpenAIContentPart[] {
  if (!Array.isArray(content)) return []
  const parts: OpenAIContentPart[] = []
  for (const b of content) {
    if (!isBlock(b)) continue
    if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text) parts.push(textPart(b.text))
    } else if (b.type === 'image') parts.push(imagePart(b) ?? textPart('[image omitted: unsupported image source]'))
    else if (b.type === 'document') parts.push(...documentParts(b, quirks))
    else if (b.type === 'search_result') parts.push(textPart(searchResultText(b)))
  }
  return parts
}

function collapse(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts
}

function asParts(content: string | OpenAIContentPart[]): OpenAIContentPart[] {
  return typeof content === 'string' ? (content ? [textPart(content)] : []) : content
}

/** Append user content, merging with a directly preceding user message (strict servers require alternation). */
function appendUser(out: OpenAIMessage[], content: string | OpenAIContentPart[]): void {
  const last = out[out.length - 1]
  if (last?.role === 'user') {
    if (typeof last.content !== 'string' || typeof content !== 'string') last.content = [...asParts(last.content), ...asParts(content)]
    else last.content = last.content ? `${last.content}\n\n${content}` : content
    return
  }
  out.push({ role: 'user', content })
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

interface MessageContext {
  upstream: ProxyUpstream
  names: ToolNameMapper
  quirks: UpstreamQuirks
  historyToolIds: Set<string>
}

function toolResultText(block: AnthropicBlock, attachments: OpenAIContentPart[], quirks: UpstreamQuirks): string {
  const parts: string[] = []
  const content = block.content
  if (typeof content === 'string') {
    if (content) parts.push(content)
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (!isBlock(c)) continue
      if (c.type === 'text') {
        if (typeof c.text === 'string' && c.text) parts.push(c.text)
      } else if (c.type === 'image') {
        const image = imagePart(c)
        if (image) attachments.push(image)
        else parts.push('[image omitted: unsupported image source]')
      } else if (c.type === 'tool_reference') parts.push(`[tool loaded: ${String(c.tool_name ?? '')}]`)
      else if (c.type === 'document') {
        for (const p of documentParts(c, quirks)) {
          if (p.type === 'text') parts.push(p.text)
          else attachments.push(p)
        }
      } else if (c.type === 'search_result') parts.push(searchResultText(c))
      else parts.push(`[${c.type} block omitted]`)
    }
  }
  const text = parts.join('\n') || '(no output)'
  return block.is_error === true ? `[tool error] ${text}` : text
}

/** `leading`: reminders that arrived while tool results were pending; they go after the tool messages. */
function convertUser(content: AnthropicBlock[], out: OpenAIMessage[], ctx: MessageContext, leading: string[]): void {
  const attachments: OpenAIContentPart[] = []
  for (const b of content) {
    if (b.type !== 'tool_result') continue
    out.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: toolResultText(b, attachments, ctx.quirks) })
  }
  for (const text of leading) appendUser(out, text)
  const parts: OpenAIContentPart[] = []
  if (attachments.length) {
    const kind = attachments.every((a) => a.type === 'image_url') ? 'Images' : 'Files'
    parts.push(textPart(`${kind} returned by the tool calls above:`), ...attachments)
  }
  parts.push(...contentParts(content, ctx.quirks))
  if (parts.length) appendUser(out, collapse(parts))
}

function convertAssistant(content: AnthropicBlock[], ctx: MessageContext): OpenAIAssistantMessage | null {
  let text = ''
  let reasoning = ''
  const calls: OpenAIToolCall[] = []
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
    else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoning += b.thinking
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const id = typeof b.id === 'string' && b.id ? b.id : `toolu_${calls.length}_${ctx.historyToolIds.size}`
      ctx.historyToolIds.add(id)
      calls.push({ id, type: 'function', function: { name: ctx.names.shorten(b.name), arguments: JSON.stringify(b.input ?? {}) } })
    }
    // redacted_thinking, server_tool_use, *_tool_result, mcp_* blocks: provider-side only → dropped
  }
  const roundtrip = ctx.upstream.reasoning === 'roundtrip' || ctx.upstream.reasoning === 'both'
  if (!text && !calls.length && !(roundtrip && reasoning)) return null
  const message: OpenAIAssistantMessage = { role: 'assistant', content: text || (calls.length ? null : '') }
  if (calls.length) message.tool_calls = calls
  // DeepSeek-style APIs require reasoning_content on every assistant turn that called tools.
  if (roundtrip && (reasoning || calls.length)) message.reasoning_content = reasoning
  return message
}

function convertMessages(messages: AnthropicMessageParam[], ctx: MessageContext): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  // Mid-conversation system entries become <system-reminder> user text. One that arrives while tool results
  // are still pending is deferred until after those results (OpenAI requires tool messages to come first).
  let deferred: string[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = blocksText(m.content)
      if (!text.trim()) continue
      const reminder = `<system-reminder>\n${text}\n</system-reminder>`
      const last = out[out.length - 1]
      if (last?.role === 'assistant' && last.tool_calls?.length) deferred.push(reminder)
      else appendUser(out, reminder)
    } else if (m.role === 'assistant') {
      if (deferred.length) appendUser(out, deferred.splice(0).join('\n\n'))
      if (typeof m.content === 'string') {
        if (m.content) out.push({ role: 'assistant', content: m.content })
      } else {
        const converted = convertAssistant(m.content, ctx)
        if (converted) out.push(converted)
      }
    } else {
      const leading = deferred
      deferred = []
      if (typeof m.content === 'string') {
        for (const text of leading) appendUser(out, text)
        if (m.content) appendUser(out, m.content)
      } else convertUser(m.content, out, ctx, leading)
    }
  }
  if (deferred.length) appendUser(out, deferred.join('\n\n'))
  return out
}

/**
 * Make tool-call sequences valid for OpenAI: every assistant `tool_calls` id must be answered by a `tool`
 * message before the next non-tool message, and `tool` messages must answer a preceding call.
 * Missing answers get a placeholder; orphan results are kept as user text.
 */
export function repairToolSequence(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  let expected: string[] = []
  const answered = new Set<string>()
  const orphans: string[] = []
  const settle = (): void => {
    for (const id of expected) if (!answered.has(id)) out.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED_RESULT })
    expected = []
    answered.clear()
    if (orphans.length) appendUser(out, orphans.splice(0).join('\n\n'))
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      if (expected.includes(m.tool_call_id) && !answered.has(m.tool_call_id)) {
        answered.add(m.tool_call_id)
        out.push(m)
      } else orphans.push(`[Result of an earlier tool call${m.tool_call_id ? ` (${m.tool_call_id})` : ''}]\n${m.content}`)
      continue
    }
    settle()
    if (m.role === 'user') appendUser(out, m.content)
    else out.push(m)
    if (m.role === 'assistant' && m.tool_calls?.length) expected = m.tool_calls.map((c) => c.id)
  }
  settle()
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs for translating one request to one upstream. */
export interface RequestTranslationOptions {
  upstream: ProxyUpstream
  /** Upstream model id (from the route). */
  model: string
  names: ToolNameMapper
  quirks: UpstreamQuirks
}

/** The upstream payload plus what the response translation needs to know about the request. */
export interface TranslatedRequest {
  payload: OpenAIRequest
  /** Every tool_use id in the conversation history (new ids must not collide with them). */
  historyToolIds: Set<string>
  /** Names of tools that cannot be forwarded (server tools, deferred tools). */
  droppedTools: string[]
}

/** Anthropic effort for this request: output_config.effort, else derived from an explicit thinking budget. */
export function requestedEffort(request: AnthropicRequest): string | undefined {
  if (request.output_config?.effort) return request.output_config.effort
  if (request.thinking?.type === 'enabled') {
    const budget = request.thinking.budget_tokens ?? 0
    return budget >= 16000 ? 'high' : budget >= 4000 ? 'medium' : 'low'
  }
  return undefined
}

/**
 * Upstream fields from the reference proxy that ProxyUpstream does not declare yet (CONTRACT CHANGE REQUEST).
 * They are preserved by config validation and honoured here when present.
 */
export interface UpstreamExtras {
  /** reasoning_effort sent for Anthropic `xhigh` / `max` (default 'high', which every provider accepts). */
  maxEffort?: string
  /** Extra top-level fields merged into every upstream payload (e.g. OpenRouter `provider` routing). */
  extraBody?: Record<string, unknown>
}

/** Payload fields extraBody may not override (they would break routing or the response handling). */
const PROTECTED_FIELDS = new Set(['model', 'messages', 'stream'])

/** Map Anthropic effort levels onto OpenAI's widely supported `reasoning_effort` values. */
export function toReasoningEffort(effort: string, maxEffort?: string): string {
  const e = effort.toLowerCase()
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'minimal') return e
  if (e === 'xhigh' || e === 'max') return maxEffort ?? 'high'
  return 'medium'
}

function promptCacheKey(userId: string | undefined): string | undefined {
  if (!userId) return undefined
  let basis = userId
  try {
    const parsed: unknown = JSON.parse(userId)
    if (isObject(parsed) && (parsed.session_id || parsed.device_id)) basis = String(parsed.session_id || parsed.device_id)
  } catch {
    // plain string id
  }
  return `cs-${createHash('sha256').update(basis).digest('hex').slice(0, 40)}`
}

function translateTools(request: AnthropicRequest, opts: RequestTranslationOptions): { tools: OpenAITool[]; dropped: string[] } {
  const tools: OpenAITool[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const tool of request.tools) {
    if ((tool.type && tool.type !== 'custom') || tool.defer_loading) {
      dropped.push(tool.name)
      continue
    }
    const name = opts.names.shorten(tool.name)
    if (seen.has(name)) continue
    seen.add(name)
    tools.push({
      type: 'function',
      function: { name, description: tool.description ?? '', parameters: cleanToolSchema(tool.input_schema, opts.quirks.schemaFlavor) }
    })
  }
  return { tools, dropped }
}

/** Build the OpenAI Chat Completions payload for a normalized Anthropic request. */
export function toOpenAIRequest(request: AnthropicRequest, opts: RequestTranslationOptions): TranslatedRequest {
  const { upstream, quirks, model } = opts
  // Tools first: their names claim the short-name slots before history tool_use names do (deterministic).
  const { tools, dropped } = translateTools(request, opts)
  const ctx: MessageContext = { upstream, names: opts.names, quirks, historyToolIds: new Set() }

  const messages: OpenAIMessage[] = []
  const system = systemText(request.system)
  if (system) messages.push({ role: 'system', content: system })
  messages.push(...repairToolSequence(convertMessages(request.messages, ctx)))

  const payload: OpenAIRequest = { model, messages }
  const cap = upstream.maxOutputTokens && upstream.maxOutputTokens > 0 ? upstream.maxOutputTokens : Number.POSITIVE_INFINITY
  const maxTokens = Math.max(1, Math.min(request.max_tokens ?? DEFAULT_MAX_TOKENS, cap))
  if (upstream.useMaxCompletionTokens || quirks.forceMaxCompletionTokens) payload.max_completion_tokens = maxTokens
  else payload.max_tokens = maxTokens

  if (!isOpenAIReasoningModel(quirks, model)) {
    if (request.temperature !== undefined) payload.temperature = request.temperature
    if (request.top_p !== undefined) payload.top_p = request.top_p
    if (request.stop_sequences?.length) payload.stop = request.stop_sequences.slice(0, 4)
  }

  if (tools.length) {
    payload.tools = tools
    const choice = request.tool_choice
    if (choice?.type === 'any') payload.tool_choice = 'required'
    else if (choice?.type === 'auto' || choice?.type === 'none') payload.tool_choice = choice.type
    else if (choice?.type === 'tool' && choice.name) {
      const name = opts.names.shorten(choice.name)
      if (tools.some((t) => t.function.name === name)) payload.tool_choice = { type: 'function', function: { name } }
    }
    if (choice?.disable_parallel_tool_use && quirks.supportsParallelToolCalls) payload.parallel_tool_calls = false
  }

  const extras = upstream as ProxyUpstream & UpstreamExtras
  const mode = upstream.reasoning ?? 'off'
  if ((mode === 'effort' || mode === 'both') && request.thinking?.type !== 'disabled') {
    const effort = requestedEffort(request)
    if (effort) payload.reasoning_effort = toReasoningEffort(effort, extras.maxEffort)
  }

  const format = request.output_config?.format
  if (isObject(format) && format.type === 'json_schema' && isObject(format.schema)) {
    const jsonSchema = { name: 'response', schema: cleanToolSchema(format.schema), strict: false }
    payload.response_format = { type: 'json_schema', json_schema: jsonSchema }
  }

  if (quirks.promptCacheKey) {
    const key = promptCacheKey(request.metadata?.user_id)
    if (key) payload.prompt_cache_key = key
  }

  if (request.stream) {
    payload.stream = true
    if (upstream.streamOptions !== false) payload.stream_options = { include_usage: true }
  }
  if (isObject(extras.extraBody)) {
    const target = payload as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(extras.extraBody)) if (!PROTECTED_FIELDS.has(key)) target[key] = structuredClone(value)
  }
  return { payload, historyToolIds: ctx.historyToolIds, droppedTools: dropped }
}
