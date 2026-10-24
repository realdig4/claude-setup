/**
 * Low-cost connection test: one tiny request (max_tokens 16) to the provider, mapped to a verdict and a friendly
 * message. Anthropic-style providers get POST {base}/v1/messages (retrying with the other auth header on 401/403);
 * OpenAI-only providers are tested directly at POST {base}/chat/completions. Keys are never logged.
 */
import type { ConnectionTestInput, ConnectionTestResult, ProviderPreset } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject } from '../fs/json'
import { fetchText, type HttpResult } from '../http'
import { PROXY_HINTS, siblingForKey } from './providers'
import { resolveConnection } from './resolve'
import { hostOf, isHttpUrl, joinUrl, stripContextSuffix } from './urls'

type Verdict = ConnectionTestResult['verdict']
type Wire = 'anthropic' | 'openai'

const TEST_TIMEOUT_MS = 30_000

const KEY_HINTS: Record<string, string> = {
  moonshot:
    'Keys from platform.kimi.ai (international) and platform.kimi.com (China) only work with their own region. ' +
    'A Kimi membership key (sk-kimi-…) needs “Membership plan” instead.',
  'kimi-code': 'Use an API key from your Kimi Code console (kimi.com/code/console); they start with sk-kimi-. Keys from platform.kimi.ai are for “Pay as you go”.',
  zai: 'Z.ai keys only work with their own site: z.ai keys for International, bigmodel.cn keys for China.',
  qwen: 'Alibaba keys only work in the region where they were created, and Coding Plan keys (sk-sp-…) need the Coding Plan provider.',
  'qwen-coding': 'The Coding Plan needs a Coding Plan key (sk-sp-…); pay-as-you-go keys are rejected here.',
  'qwen-token-plan': 'The Token Plan needs a Token Plan key from the Model Studio console.',
  mimo: 'Pay-as-you-go keys (sk-…) and Token Plan keys (tp-… / ttp-…) only work with their own region.',
  lmstudio: 'If "Require Authentication" is on in LM Studio, paste its token as the API key.'
}

function errorMessageFrom(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined
  if (!isPlainObject(body)) return undefined
  const e = body.error
  if (isPlainObject(e) && typeof e.message === 'string') return e.message
  if (typeof e === 'string') return e
  if (typeof body.message === 'string') return body.message
  if (typeof body.msg === 'string') return body.msg
  if (typeof body.detail === 'string') return body.detail
  const meta = body.ResponseMeta
  if (isPlainObject(meta) && isPlainObject(meta.Error) && typeof meta.Error.Message === 'string') return meta.Error.Message
  if (isPlainObject(meta) && typeof meta.ErrorMessage === 'string') return meta.ErrorMessage
  return undefined
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function looksLikeHtml(text: string | undefined): boolean {
  return !!text && /^\s*<(!doctype|html|head|body)/i.test(text)
}

/** Error code in a body that came back with HTTP 200 (Z.ai style {"code":401,"success":false}). */
function embeddedErrorStatus(body: unknown): number | undefined {
  if (!isPlainObject(body)) return undefined
  if (body.type === 'error' || body.success === false || (isPlainObject(body.error) && !body.content && !body.choices)) {
    const code = Number(body.code ?? (isPlainObject(body.error) ? body.error.code : undefined))
    return Number.isFinite(code) && code >= 400 ? code : 400
  }
  if (typeof body.code === 'number' && body.code >= 400 && !body.content && !body.choices) return body.code
  return undefined
}

function sampleFrom(body: unknown, wire: Wire): string | undefined {
  if (!isPlainObject(body)) return undefined
  let text: string | undefined
  if (wire === 'anthropic' && Array.isArray(body.content)) {
    const block = body.content.find((b) => isPlainObject(b) && b.type === 'text' && typeof b.text === 'string') as { text: string } | undefined
    text = block?.text
    if (text === undefined && body.content.some((b) => isPlainObject(b) && b.type === 'thinking')) text = '(the model started thinking)'
  }
  if (wire === 'openai' && Array.isArray(body.choices) && isPlainObject(body.choices[0])) {
    const message = body.choices[0].message
    if (isPlainObject(message)) text = typeof message.content === 'string' && message.content ? message.content : undefined
  }
  const trimmed = text?.trim()
  return trimmed ? trimmed.slice(0, 200) : undefined
}

function hasExpectedShape(body: unknown, wire: Wire): boolean {
  if (!isPlainObject(body)) return false
  if (wire === 'openai') return Array.isArray(body.choices)
  return body.type === 'message' || (typeof body.id === 'string' && body.id.startsWith('msg_')) || Array.isArray(body.content)
}

function mentionsThinkingRequirement(message: string): boolean {
  return /thinking/i.test(message) && /(only|must|required|enabled|cannot be disabled)/i.test(message)
}

const MODEL_PROBLEM =
  /(not\s*found|unknown|does\s*not\s*exist|not\s*exist|no\s*such|invalid|unsupported|not\s*supported|not\s*available|no access|not allowed)/i

function mentionsModel(message: string, model: string): boolean {
  if (!/model/i.test(message)) return false
  return message.toLowerCase().includes(model.toLowerCase()) || MODEL_PROBLEM.test(message)
}

function networkHint(preset: ProviderPreset, baseUrl: string): string {
  if (preset.id === 'ollama') return 'Is Ollama running? Start the Ollama app (or run "ollama serve") and try again.'
  if (preset.id === 'lmstudio') return "Is LM Studio's server running? Start it in LM Studio (Developer → Start server)."
  if (preset.kind === 'custom' || preset.id === 'openai-compatible') {
    return `Is the server at ${hostOf(baseUrl)} running and reachable from this computer?`
  }
  return 'Check your internet connection, VPN or company proxy.'
}

interface Interpretation {
  verdict: Verdict
  message: string
  sample?: string
}

interface InterpretContext {
  preset: ProviderPreset
  model: string
  baseUrl: string
  wire: Wire
  /** The key belongs to a sibling provider (e.g. a Kimi membership key tested against pay as you go). */
  sibling?: ProviderPreset
}

function networkVerdict(res: HttpResult<string>, { preset, baseUrl }: InterpretContext): Interpretation {
  const host = hostOf(baseUrl)
  const message = /timed out/i.test(res.error ?? '')
    ? `${host} didn't answer within ${TEST_TIMEOUT_MS / 1000} seconds. ${networkHint(preset, baseUrl)}`
    : `Couldn't reach ${host} (${res.error ?? 'connection failed'}). ${networkHint(preset, baseUrl)}`
  return { verdict: 'network', message }
}

/** A 2xx answer: success, a web page, or an error hidden in a 200 body (returns its status). */
function successVerdict(res: HttpResult<string>, body: unknown, c: InterpretContext): Interpretation | number {
  const embedded = embeddedErrorStatus(body)
  if (embedded !== undefined) return embedded
  const host = hostOf(c.baseUrl)
  if (looksLikeHtml(res.text)) {
    const message = `${host} answered with a web page instead of the API. Check the address — a firewall, proxy or wrong host can cause this.`
    return { verdict: 'bad-url', message }
  }
  if (hasExpectedShape(body, c.wire)) {
    const sample = sampleFrom(body, c.wire)
    return { verdict: 'ok', message: `Connected to ${c.preset.name} — "${c.model}" answered.`, ...(sample ? { sample } : {}) }
  }
  const api = c.wire === 'openai' ? 'an OpenAI-compatible' : 'an Anthropic-compatible'
  return { verdict: 'unknown', message: `${host} answered, but not like ${api} API. Check the address.` }
}

/** 400/404/422: thinking-only model, unknown model, or wrong address. */
function requestVerdict(status: number, detail: string | undefined, said: string, c: InterpretContext): Interpretation {
  const { preset, model, baseUrl, wire } = c
  if (detail && mentionsThinkingRequirement(detail)) {
    return { verdict: 'ok', message: `Connected to ${preset.name}. "${model}" only works with thinking switched on — Claude Code handles that.` }
  }
  if (detail && mentionsModel(detail, model)) {
    const fireworks = preset.id === 'fireworks' ? ' (Fireworks checks the model before the key, so also double-check the key.)' : ''
    const message = `The address and key work, but ${preset.name} doesn't offer the model "${model}". Pick another model.${fireworks}${said}`
    return { verdict: 'bad-model', message }
  }
  if (status === 404) {
    const url = joinUrl(baseUrl, wire === 'openai' ? '/chat/completions' : '/v1/messages')
    const v1 = wire === 'anthropic' ? ' — it must not end in /v1' : ''
    return { verdict: 'bad-url', message: `Nothing answers at ${url} (HTTP 404). Check the address${v1}.` }
  }
  return { verdict: 'unknown', message: `${preset.name} rejected the test request (HTTP ${status}).${said}` }
}

/** Map an HTTP answer to a verdict (research_providers §6). */
export function interpretResponse(res: HttpResult<string>, c: InterpretContext): Interpretation {
  if (!res.status) return networkVerdict(res, c)
  const { preset } = c
  const body = parseJson(res.text)
  const detail = errorMessageFrom(body) ?? (looksLikeHtml(res.text) ? undefined : res.text?.trim().slice(0, 300))
  const said = detail ? ` The provider said: "${detail.slice(0, 300)}"` : ''
  let status = res.status

  if (status >= 200 && status < 300) {
    const outcome = successVerdict(res, body, c)
    if (typeof outcome !== 'number') return outcome
    status = outcome
  }
  if (looksLikeHtml(res.text) && status !== 401 && status !== 403) {
    return { verdict: 'bad-url', message: `${hostOf(c.baseUrl)} answered with a web page (HTTP ${res.status}) instead of the API. Check the address.` }
  }
  if (status === 401 || status === 403) {
    if (c.sibling) {
      const choice = c.sibling.family?.choice ?? c.sibling.name
      return { verdict: 'bad-key', message: `The API key was rejected (HTTP ${status}). This key is for ${c.sibling.name}, not ${preset.name}: choose “${choice}” and test again.` }
    }
    const hint = KEY_HINTS[preset.id] ? ` ${KEY_HINTS[preset.id]}` : ''
    const message =
      `The API key was rejected (HTTP ${status}).${said} ` +
      `Check that you copied the whole key and that it belongs to this provider, region and plan.${hint}`
    return { verdict: 'bad-key', message }
  }
  if (status === 402) {
    return { verdict: 'quota', message: `${preset.name} says the account has no balance left (HTTP 402). Top up or check your plan, then try again.${said}` }
  }
  if (status === 429) {
    const message = `${preset.name} is limiting requests or the quota is used up (HTTP 429). Wait a moment or check your plan, then try again.${said}`
    return { verdict: 'quota', message }
  }
  if (status === 400 || status === 404 || status === 422) return requestVerdict(status, detail, said, c)
  if (status === 405) return { verdict: 'bad-url', message: "The address doesn't accept API requests (HTTP 405). Check the base URL." }
  if (status >= 500) {
    const message = `${preset.name} had a server problem (HTTP ${status}). This is usually temporary — try again in a minute.${said}`
    return { verdict: 'unknown', message }
  }
  return { verdict: 'unknown', message: `Unexpected answer from ${preset.name} (HTTP ${status}).${said}` }
}

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult<string>> {
  return fetchText(url, { method: 'POST', body, headers: { accept: 'application/json', ...headers }, timeoutMs: TEST_TIMEOUT_MS })
}

function anthropicAuth(kind: 'bearer' | 'x-api-key', key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (key) {
    if (kind === 'bearer') headers.authorization = `Bearer ${key}`
    else headers['x-api-key'] = key
  }
  return headers
}

async function testAnthropic(preset: ProviderPreset, baseUrl: string, key: string | undefined, model: string): Promise<HttpResult<string>> {
  const url = joinUrl(baseUrl, '/v1/messages')
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
  const primary: 'bearer' | 'x-api-key' = preset.authEnv === 'ANTHROPIC_API_KEY' ? 'x-api-key' : 'bearer'
  const first = await post(url, body, anthropicAuth(primary, key))
  if ((first.status === 401 || first.status === 403) && key) {
    const retry = await post(url, body, anthropicAuth(primary === 'bearer' ? 'x-api-key' : 'bearer', key))
    if (retry.status && retry.status !== 401 && retry.status !== 403) return retry
  }
  return first
}

async function testOpenAi(preset: ProviderPreset, baseUrl: string, key: string | undefined, model: string): Promise<HttpResult<string>> {
  const url = joinUrl(baseUrl, '/chat/completions')
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
  const tokenField = PROXY_HINTS[preset.id]?.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'
  const request = (field: string) => ({ model, messages: [{ role: 'user', content: 'ping' }], [field]: 16, stream: false })
  const first = await post(url, request(tokenField), headers)
  if (first.status === 400 && /max_(completion_)?tokens/i.test(first.text ?? '')) {
    return post(url, request(tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'), headers)
  }
  return first
}

function early(ok: boolean, verdict: Verdict, message: string): ConnectionTestResult {
  return { ok, ms: 0, verdict, message }
}

/** Test that a provider address + key + model work. Never throws. */
export async function testConnection(ctx: CoreContext, input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const started = Date.now()
  const resolved = await resolveConnection(ctx, input)
  if ('error' in resolved) return early(false, 'unknown', resolved.error)
  const { preset, baseUrl, key } = resolved
  if (preset.kind === 'cloud') {
    const message =
      `Claude Setup can't test ${preset.name} directly because it signs in with your cloud account. ` +
      'Run claude in a terminal and send a message, or check /status there.'
    return early(false, 'unknown', message)
  }
  if (preset.kind === 'anthropic' && !key) {
    return early(true, 'ok', 'Claude Code uses your Claude account here, so there is no API key to test. Run claude and sign in if it asks.')
  }
  if (preset.requiresKey && !key) return early(false, 'bad-key', `Enter your ${preset.name} API key first.`)
  if (!baseUrl) return early(false, 'bad-url', 'Enter the server address first.')
  if (!isHttpUrl(baseUrl)) return early(false, 'bad-url', `"${baseUrl}" is not a web address. It should start with http:// or https://.`)
  if (!resolved.model) return early(false, 'bad-model', 'Choose or type a model name first.')

  const model = stripContextSuffix(resolved.model)
  const wire: Wire = preset.kind === 'openai-proxy' ? 'openai' : 'anthropic'
  let res: HttpResult<string>
  try {
    res = wire === 'openai' ? await testOpenAi(preset, baseUrl, key, model) : await testAnthropic(preset, baseUrl, key, model)
  } catch (err) {
    res = { ok: false, status: 0, error: (err as Error).message }
  }
  const ms = Date.now() - started
  const sibling = key ? siblingForKey(preset, key) : undefined
  const result = interpretResponse(res, { preset, model, baseUrl, wire, sibling })
  ctx.log.info('models', `Connection test ${preset.name} at ${hostOf(baseUrl)}: HTTP ${res.status || '-'} → ${result.verdict} (${ms} ms)`)
  return {
    ok: result.verdict === 'ok',
    ...(res.status ? { status: res.status } : {}),
    ms,
    verdict: result.verdict,
    message: result.message,
    ...(result.sample ? { sample: result.sample } : {})
  }
}
