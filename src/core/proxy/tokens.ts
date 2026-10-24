/**
 * Input-token estimates for `message_start`, `/v1/messages/count_tokens` and as a fallback
 * when an upstream does not report usage. Character based (≈4 chars per token for ASCII,
 * denser for other scripts) plus a flat cost per image/document — Claude Code itself falls
 * back to a character estimate, so this is the same order of accuracy.
 */
import { isObject, type AnthropicBlock, type AnthropicRequest } from './wire'

const IMAGE_TOKENS = 1500
const DOCUMENT_TOKENS = 1500
const MESSAGE_OVERHEAD = 4

/** Estimated token count of a piece of text. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5)
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) if (isObject(block)) total += blockTokens(block as AnthropicBlock)
  return total
}

function blockTokens(block: AnthropicBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(typeof block.text === 'string' ? block.text : '')
    case 'thinking':
      return estimateTextTokens(typeof block.thinking === 'string' ? block.thinking : '')
    case 'redacted_thinking':
      return 0
    case 'tool_use':
      return estimateTextTokens(String(block.name ?? '')) + estimateTextTokens(JSON.stringify(block.input ?? {}))
    case 'tool_result':
      return contentTokens(block.content) + MESSAGE_OVERHEAD
    case 'image':
      return IMAGE_TOKENS
    case 'document': {
      const source = isObject(block.source) ? block.source : {}
      if (source.type === 'text' && typeof source.data === 'string') return estimateTextTokens(source.data)
      if (source.type === 'content') return contentTokens(source.content)
      return DOCUMENT_TOKENS
    }
    case 'search_result':
      return estimateTextTokens(String(block.title ?? '')) + contentTokens(block.content)
    default:
      return estimateTextTokens(JSON.stringify(block))
  }
}

/** Estimated input tokens of a (normalized) Anthropic Messages request. Always ≥ 1. */
export function estimateRequestTokens(request: Pick<AnthropicRequest, 'system' | 'messages' | 'tools'>): number {
  let total = contentTokens(request.system)
  for (const message of request.messages) total += contentTokens(message.content) + MESSAGE_OVERHEAD
  const tools = request.tools.filter((tool) => !tool.defer_loading)
  if (tools.length) total += estimateTextTokens(JSON.stringify(tools))
  return Math.max(1, total)
}
