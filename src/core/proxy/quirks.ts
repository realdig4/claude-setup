/**
 * Provider-specific behaviour derived from an upstream's providerId / base URL.
 * Everything here is a compatibility adjustment; generic OpenAI-compatible servers get the defaults.
 */
import type { ProxyUpstream } from '@shared/types'

/** Provider recognized from providerId / host. */
export type ProviderFamily = 'openai' | 'gemini' | 'groq' | 'cerebras' | 'openrouter' | 'generic'

/** How tool schemas are cleaned for an upstream. */
export type SchemaFlavor = 'default' | 'gemini'

/** Compatibility switches derived for one upstream. */
export interface UpstreamQuirks {
  family: ProviderFamily
  /** How tool JSON schemas are cleaned (Gemini accepts only an OpenAPI 3.0 subset). */
  schemaFlavor: SchemaFlavor
  /** Send `max_completion_tokens` even when the upstream config does not ask for it (OpenAI deprecated `max_tokens`). */
  forceMaxCompletionTokens: boolean
  /** Gemini rejects the `parallel_tool_calls` field ("Unknown name"). */
  supportsParallelToolCalls: boolean
  /** PDFs can be sent as `{type:'file'}` content parts (OpenAI, OpenRouter). */
  pdfAsFile: boolean
  /** OpenAI routes prompt caching by `prompt_cache_key`. */
  promptCacheKey: boolean
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function familyOf(upstream: ProxyUpstream): ProviderFamily {
  const id = (upstream.providerId ?? '').toLowerCase()
  const host = hostOf(upstream.baseUrl)
  if (host === 'api.openai.com' || id === 'openai') return 'openai'
  if (host === 'generativelanguage.googleapis.com' || id === 'gemini' || id === 'google' || id === 'google-gemini') return 'gemini'
  if (host === 'api.groq.com' || host.endsWith('.groq.com') || id === 'groq') return 'groq'
  if (host === 'api.cerebras.ai' || host.endsWith('.cerebras.ai') || id === 'cerebras') return 'cerebras'
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai') || id === 'openrouter') return 'openrouter'
  return 'generic'
}

/** Compatibility switches for one upstream. */
export function detectQuirks(upstream: ProxyUpstream): UpstreamQuirks {
  const family = familyOf(upstream)
  return {
    family,
    schemaFlavor: family === 'gemini' ? 'gemini' : 'default',
    forceMaxCompletionTokens: family === 'openai',
    supportsParallelToolCalls: family !== 'gemini',
    pdfAsFile: family === 'openai' || family === 'openrouter',
    promptCacheKey: family === 'openai'
  }
}

/** OpenAI reasoning models reject temperature / top_p / stop (o-series and the GPT-5 family). */
export function isOpenAIReasoningModel(quirks: UpstreamQuirks, model: string): boolean {
  return quirks.family === 'openai' && /^(o\d|gpt-5)/i.test(model)
}
