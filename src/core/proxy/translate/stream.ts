/**
 * OpenAI `chat.completion.chunk` stream → Anthropic SSE events (research_proxy.md §6.4, verified output).
 *
 * Pure state machine (no I/O): feed parsed chunks with `push()`, end with `finish()`.
 *  - reasoning deltas → a `thinking` block, content deltas → a `text` block (switching closes the open block;
 *    a thinking block gets a `signature_delta` before it closes)
 *  - tool-call fragments are BUFFERED per index (a new id on a used index = a new call, Gemini style), then
 *    emitted at the end as complete `tool_use` blocks with one repaired `input_json_delta` each
 *  - `message_delta` carries stop_reason + final usage, then `message_stop`
 *  - an upstream error chunk, or a stream that ends before `finish_reason`/`[DONE]`, raises
 *    `UpstreamStreamError`; the caller then emits `error()` WITHOUT closing the open block, which makes
 *    Claude Code retry the request (non-streaming)
 */
import type { ToolNameMapper } from '../names'
import {
  isObject,
  type AnthropicContentOut,
  type AnthropicMessageOut,
  type AnthropicStopReason,
  type AnthropicUsage,
  type JsonObject,
  type OpenAIChunk,
  type SseEvent
} from '../wire'
import {
  ToolIdAllocator,
  estimateOutputTokens,
  fakeSignature,
  mapStopReason,
  mapUsage,
  newMessageId,
  parseToolArguments,
  textOf
} from './response'

/** The upstream stream failed (error chunk, dropped connection, missing finish). */
export class UpstreamStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamStreamError'
  }
}

/** Inputs for translating one upstream stream. */
export interface StreamTranslatorOptions {
  /** Model name exactly as the client requested it (echoed back). */
  model: string
  names: ToolNameMapper
  inputEstimate: number
  /** tool_use ids already present in the conversation. */
  reservedIds?: Iterable<string>
  onWarning?: (message: string) => void
}

interface ToolBuffer {
  upstreamId?: string
  name: string
  args: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Event builders
// ─────────────────────────────────────────────────────────────────────────────

function messageStart(id: string, model: string, usage: AnthropicUsage): SseEvent {
  const message = { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage }
  return { event: 'message_start', data: { type: 'message_start', message } }
}

function blockStart(index: number, block: JsonObject): SseEvent {
  return { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } }
}

function blockDelta(index: number, delta: JsonObject): SseEvent {
  return { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta } }
}

function blockStop(index: number): SseEvent {
  return { event: 'content_block_stop', data: { type: 'content_block_stop', index } }
}

function messageDelta(stopReason: AnthropicStopReason, usage: AnthropicUsage): SseEvent {
  const delta = { stop_reason: stopReason, stop_sequence: null }
  return { event: 'message_delta', data: { type: 'message_delta', delta, usage: { ...usage } } }
}

const messageStop = (): SseEvent => ({ event: 'message_stop', data: { type: 'message_stop' } })

/** Message text of an error chunk (`{error:{message}}`, `{error:"…"}`, `{message}`). */
export function streamErrorMessage(chunk: JsonObject): string {
  const err = chunk.error
  if (typeof err === 'string' && err) return err
  if (isObject(err)) {
    if (typeof err.message === 'string' && err.message) return err.message
    return JSON.stringify(err)
  }
  if (typeof chunk.message === 'string' && chunk.message) return chunk.message
  return 'The provider reported an error during the response.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Translator
// ─────────────────────────────────────────────────────────────────────────────

/** Stateful OpenAI-chunk → Anthropic-event translator for one response (see the file header). */
export class StreamTranslator {
  readonly messageId = newMessageId()
  private index = -1
  private open: 'text' | 'thinking' | null = null
  private finishReason: string | null = null
  private usage: unknown = null
  private readonly tools = new Map<number, ToolBuffer>()
  private readonly slots = new Map<string | number, number>()
  private nextToolKey = 0
  private lastSlot: string | number = 0
  private readonly blocks: AnthropicContentOut[] = []
  private result: { stopReason: AnthropicStopReason; usage: AnthropicUsage } | null = null

  constructor(private readonly opts: StreamTranslatorOptions) {}

  /** `message_start` (input tokens estimated until the upstream reports usage). */
  start(): SseEvent[] {
    const usage = { input_tokens: this.opts.inputEstimate, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return [messageStart(this.messageId, this.opts.model, usage)]
  }

  /** Whether the upstream has reported a finish_reason. */
  get sawFinish(): boolean {
    return this.finishReason !== null
  }

  /** Translate one parsed upstream chunk. Throws UpstreamStreamError for error chunks. */
  push(chunk: unknown, eventName?: string): SseEvent[] {
    const out: SseEvent[] = []
    if (!isObject(chunk)) return out
    if (eventName === 'error' || (chunk.error !== undefined && chunk.error !== null)) {
      throw new UpstreamStreamError(streamErrorMessage(chunk))
    }
    const c = chunk as OpenAIChunk
    if (isObject(c.usage)) this.usage = c.usage
    if (isObject(c.x_groq) && isObject(c.x_groq.usage)) this.usage = c.x_groq.usage
    const choices = Array.isArray(c.choices) ? c.choices.filter(isObject) : []
    const choice = choices.find((ch) => (ch.index ?? 0) === 0) ?? choices[0]
    if (!choice) return out
    if (isObject(choice.usage)) this.usage = choice.usage
    const delta = isObject(choice.delta) ? choice.delta : {}

    const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning)
    if (reasoning) {
      if (this.open !== 'thinking') this.startBlock('thinking', out)
      this.appendToOpenBlock(reasoning)
      out.push(blockDelta(this.index, { type: 'thinking_delta', thinking: reasoning }))
    }
    const text = textOf(delta.content) || textOf(delta.refusal)
    if (text) {
      if (this.open !== 'text') this.startBlock('text', out)
      this.appendToOpenBlock(text)
      out.push(blockDelta(this.index, { type: 'text_delta', text }))
    }
    if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) if (isObject(call)) this.bufferToolCall(call)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) this.finishReason = choice.finish_reason
    return out
  }

  /**
   * Close the stream after `[DONE]` or end of body. Emits buffered tool calls, `message_delta`, `message_stop`.
   * Throws UpstreamStreamError when the stream ended early (no finish_reason and no `[DONE]`).
   */
  finish(sawDone: boolean): SseEvent[] {
    if (!this.finishReason && !sawDone) {
      throw new UpstreamStreamError('The provider closed the connection before the response was complete.')
    }
    const out: SseEvent[] = []
    this.closeBlock(out)
    const ids = new ToolIdAllocator(this.opts.reservedIds)
    for (const tool of this.tools.values()) {
      if (!tool.name) {
        this.opts.onWarning?.('Ignored a tool call without a tool name from the provider.')
        continue
      }
      const name = this.opts.names.restore(tool.name)
      const args = parseToolArguments(tool.args)
      if (!args.ok && this.finishReason === 'length') {
        this.opts.onWarning?.(`Dropped the cut-off call to ${name} (the response hit the output token limit).`)
        continue
      }
      this.index++
      const id = ids.take(tool.upstreamId)
      out.push(blockStart(this.index, { type: 'tool_use', id, name, input: {} }))
      out.push(blockDelta(this.index, { type: 'input_json_delta', partial_json: JSON.stringify(args.input) }))
      out.push(blockStop(this.index))
      this.blocks.push({ type: 'tool_use', id, name, input: args.input })
    }
    const stopReason = mapStopReason(this.finishReason, this.blocks.some((b) => b.type === 'tool_use'))
    const usage = mapUsage(this.usage, this.opts.inputEstimate, estimateOutputTokens(this.blocks))
    this.result = { stopReason, usage }
    out.push(messageDelta(stopReason, usage), messageStop())
    return out
  }

  /** SSE `error` event (the open block is deliberately left open → Claude Code retries). */
  error(message: string): SseEvent[] {
    return [{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message } } }]
  }

  /** The complete message (after `finish()`), for clients that asked for a non-streaming response. */
  toMessage(): AnthropicMessageOut {
    if (!this.result) throw new Error('StreamTranslator.toMessage() called before finish()')
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      model: this.opts.model,
      content: this.blocks.map((b) => ({ ...b })),
      stop_reason: this.result.stopReason,
      stop_sequence: null,
      usage: { ...this.result.usage }
    }
  }

  private startBlock(kind: 'text' | 'thinking', out: SseEvent[]): void {
    this.closeBlock(out)
    this.index++
    this.open = kind
    const block: AnthropicContentOut = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' }
    this.blocks.push(block)
    out.push(blockStart(this.index, { ...block }))
  }

  private appendToOpenBlock(text: string): void {
    const block = this.blocks[this.blocks.length - 1]
    if (block?.type === 'text') block.text += text
    else if (block?.type === 'thinking') block.thinking += text
  }

  private closeBlock(out: SseEvent[]): void {
    if (!this.open) return
    if (this.open === 'thinking') {
      const signature = fakeSignature()
      const block = this.blocks[this.blocks.length - 1]
      if (block?.type === 'thinking') block.signature = signature
      out.push(blockDelta(this.index, { type: 'signature_delta', signature }))
    }
    out.push(blockStop(this.index))
    this.open = null
  }

  private bufferToolCall(call: JsonObject): void {
    const upstreamId = typeof call.id === 'string' && call.id ? call.id : undefined
    // `index` is the OpenAI correlation key; some providers omit it or reuse index 0 with a new id per call.
    const slot: string | number = typeof call.index === 'number' ? call.index : upstreamId ? `id:${upstreamId}` : this.lastSlot
    this.lastSlot = slot
    let key = this.slots.get(slot)
    const previous = key === undefined ? undefined : this.tools.get(key)
    if (!previous || (upstreamId && previous.upstreamId && previous.upstreamId !== upstreamId)) {
      key = this.nextToolKey++
      this.slots.set(slot, key)
      this.tools.set(key, { upstreamId, name: '', args: '' })
    }
    const tool = this.tools.get(key as number) as ToolBuffer
    if (!tool.upstreamId && upstreamId) tool.upstreamId = upstreamId
    const fn = isObject(call.function) ? call.function : {}
    if (typeof fn.name === 'string' && fn.name && !tool.name) tool.name = fn.name
    const args = fn.arguments
    if (args !== undefined && args !== null) tool.args += typeof args === 'string' ? args : JSON.stringify(args)
  }
}

/** Anthropic SSE events for a complete message (used when an upstream answers a streaming request with JSON). */
export function messageToEvents(message: AnthropicMessageOut): SseEvent[] {
  const startUsage = {
    input_tokens: message.usage.input_tokens,
    output_tokens: 1,
    cache_read_input_tokens: message.usage.cache_read_input_tokens,
    cache_creation_input_tokens: 0
  }
  const events: SseEvent[] = [messageStart(message.id, message.model, startUsage)]
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(blockStart(index, { type: 'text', text: '' }), blockDelta(index, { type: 'text_delta', text: block.text }))
    } else if (block.type === 'thinking') {
      events.push(
        blockStart(index, { type: 'thinking', thinking: '', signature: '' }),
        blockDelta(index, { type: 'thinking_delta', thinking: block.thinking }),
        blockDelta(index, { type: 'signature_delta', signature: block.signature })
      )
    } else {
      events.push(
        blockStart(index, { type: 'tool_use', id: block.id, name: block.name, input: {} }),
        blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input) })
      )
    }
    events.push(blockStop(index))
  })
  events.push(messageDelta(message.stop_reason, message.usage), messageStop())
  return events
}
