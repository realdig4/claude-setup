/**
 * Wire formats spoken by the translation proxy:
 *   - Anthropic Messages API (what Claude Code sends and expects back)
 *   - OpenAI Chat Completions (what OpenAI-compatible upstreams understand)
 *
 * Incoming Anthropic requests are untrusted JSON; they are normalized by
 * `parseAnthropicRequest()` (translate/request.ts) into the shapes below.
 * Upstream OpenAI responses are also untrusted and are read defensively.
 */

export type JsonObject = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic request side (normalized)
// ─────────────────────────────────────────────────────────────────────────────

/** Any Anthropic content block. Known fields are checked at runtime before use. */
export interface AnthropicBlock {
  type: string
  [key: string]: unknown
}

export interface AnthropicMessageParam {
  /** 'user' | 'assistant' | 'system' (Claude Code sends mid-conversation system entries). */
  role: string
  content: string | AnthropicBlock[]
}

export interface AnthropicTool {
  name: string
  type?: string
  description?: string
  input_schema?: unknown
  defer_loading?: boolean
}

export interface AnthropicToolChoice {
  type: string
  name?: string
  disable_parallel_tool_use?: boolean
}

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessageParam[]
  system?: string | AnthropicBlock[]
  max_tokens?: number
  stream: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  tools: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  thinking?: { type: string; budget_tokens?: number }
  output_config?: { effort?: string; format?: unknown }
  metadata?: { user_id?: string }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic response side (produced by the proxy)
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'tool_use'

export type AnthropicContentOut =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface AnthropicMessageOut {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicContentOut[]
  stop_reason: AnthropicStopReason
  stop_sequence: null
  usage: AnthropicUsage
}

/** One server-sent event in Anthropic's streaming format. */
export interface SseEvent {
  event: string
  data: JsonObject
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions request side (produced by the proxy)
// ─────────────────────────────────────────────────────────────────────────────

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAISystemMessage {
  role: 'system'
  content: string
}

export interface OpenAIUserMessage {
  role: 'user'
  content: string | OpenAIContentPart[]
}

export interface OpenAIAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OpenAIToolCall[]
  /** DeepSeek-style reasoning round-trip. */
  reasoning_content?: string
}

export interface OpenAIToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type OpenAIMessage = OpenAISystemMessage | OpenAIUserMessage | OpenAIAssistantMessage | OpenAIToolMessage

export interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: JsonObject }
}

export type OpenAIToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  parallel_tool_calls?: boolean
  reasoning_effort?: string
  response_format?: JsonObject
  prompt_cache_key?: string
  stream?: boolean
  stream_options?: { include_usage: boolean }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI response side (untrusted; every field optional)
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } | null
  /** DeepSeek naming. */
  prompt_cache_hit_tokens?: number
}

export interface OpenAIToolCallOut {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: unknown }
}

export interface OpenAIChoiceMessage {
  role?: string
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  refusal?: unknown
  tool_calls?: OpenAIToolCallOut[]
}

export interface OpenAIResponse {
  id?: string
  choices?: Array<{ index?: number; message?: OpenAIChoiceMessage; finish_reason?: string | null }>
  usage?: OpenAIUsage | null
  error?: unknown
}

export interface OpenAIChunkDelta {
  role?: string
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  refusal?: unknown
  tool_calls?: OpenAIToolCallOut[]
}

export interface OpenAIChunk {
  id?: string
  choices?: Array<{ index?: number; delta?: OpenAIChunkDelta; finish_reason?: string | null; usage?: OpenAIUsage | null }>
  usage?: OpenAIUsage | null
  /** Groq reports streaming usage here. */
  x_groq?: { usage?: OpenAIUsage | null } | null
  error?: unknown
}

/** Narrow an unknown value to a plain JSON object. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
