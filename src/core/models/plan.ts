/**
 * Pure computation of what a profile writes into Claude Code: the `env` block (strings only) and top-level settings.
 * No I/O — apply.ts decides where and how to write it.
 */
import type { ModelProfile, ProviderPreset } from '@shared/types'
import { CLOUD_KEY_ENV, modelLabel } from './providers'
import { CLOUD_SWITCH_ENV, CREDENTIAL_ENV, PROTECTED_EXTRA_ENV, SLOT_ENV } from './ownedKeys'
import { hasContextSuffix } from './urls'

/** Where Claude Code sends requests and how it authenticates. */
export interface Endpoint {
  /** ANTHROPIC_BASE_URL (unset for Anthropic itself and the official clouds). */
  baseUrl?: string
  /** Credential variable + value… */
  authVar?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'
  credential?: string
  /** …or an apiKeyHelper command instead. */
  helper?: string
  /** Requests go through Claude Setup's translation proxy (forces the compatibility bundle). */
  viaProxy?: boolean
}

export interface ApplyPlan {
  /** settings.json `env` entries (and VS Code claudeCode.environmentVariables). All values are strings. */
  env: Record<string, string>
  /** Top-level settings.json keys (apiKeyHelper, skipWebFetchPreflight, provider extras). */
  settings: Record<string, unknown>
}

/** A profile can't be applied as configured (message is shown to the user). */
export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanError'
  }
}

export interface PlanContext {
  /** The process/shell environment (to cancel conflicting exports and keep proxies working). */
  shellEnv: Record<string, string | undefined>
  /** Current settings.json env (string values), used to merge NO_PROXY. */
  settingsEnv: Record<string, string>
}

const TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const
const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[name] ?? env[name.toLowerCase()]
}

/** NO_PROXY with the loopback addresses added (so Claude Code reaches the local proxy despite HTTP(S)_PROXY). */
function withLoopback(existing: string | undefined): string {
  const parts = (existing ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  for (const host of LOOPBACK) if (!parts.some((p) => p.toLowerCase() === host)) parts.push(host)
  return parts.join(',')
}

/**
 * Window for the slot models without `[1m]` (e.g. 256K models), when the preset knows all of them: Claude Code would
 * otherwise assume 200K. The smallest one wins so compaction never starts too late. Undefined when unknown.
 */
function knownWindowForPlainIds(profile: ModelProfile, preset: ProviderPreset): number | undefined {
  const ids = [...new Set(Object.values(profile.models).filter((id): id is string => !!id && !hasContextSuffix(id) && !/^claude-/i.test(id)))]
  if (!ids.length) return undefined
  const windows = ids.map((id) => preset.models.find((m) => m.id === id)?.context)
  if (windows.some((w) => !w)) return undefined
  return Math.min(...(windows as number[]))
}

/** Build the env/settings a profile needs. Throws PlanError when required values are missing. */
export function buildPlan(profile: ModelProfile, preset: ProviderPreset, endpoint: Endpoint, context: PlanContext): ApplyPlan {
  const env: Record<string, string> = {}
  const settings: Record<string, unknown> = {}

  // Anthropic itself: only an optional Console API key; Claude Code picks Claude models on its own.
  if (preset.kind === 'anthropic') {
    if (endpoint.helper) settings.apiKeyHelper = endpoint.helper
    else if (endpoint.credential) env.ANTHROPIC_API_KEY = endpoint.credential
    return { env, settings }
  }

  // A cloud switch exported in the shell (e.g. CLAUDE_CODE_USE_BEDROCK=1) would take precedence: cancel it.
  for (const name of CLOUD_SWITCH_ENV) if (nonEmpty(context.shellEnv[name])) env[name] = ''

  if (preset.kind === 'cloud') {
    for (const [k, v] of Object.entries(preset.cloudEnv ?? {})) if (v.trim()) env[k] = v
    const keyVar = CLOUD_KEY_ENV[preset.id]
    if (keyVar && endpoint.credential) env[keyVar] = endpoint.credential
  } else {
    if (!endpoint.baseUrl) throw new PlanError(`The address for ${preset.name} is missing. Edit the profile and enter it.`)
    env.ANTHROPIC_BASE_URL = endpoint.baseUrl
    const chosen = endpoint.helper ? undefined : endpoint.authVar
    if (chosen && endpoint.credential !== undefined) env[chosen] = endpoint.credential
    if (endpoint.helper) settings.apiKeyHelper = endpoint.helper
    // Exactly one credential: blank the other variable when the provider asks for it or a shell export would conflict.
    for (const name of CREDENTIAL_ENV) {
      if (name === chosen) continue
      if ((name === 'ANTHROPIC_API_KEY' && preset.blankApiKey) || nonEmpty(context.shellEnv[name])) env[name] = ''
    }
  }

  // Every model slot, so background tasks and subagents never fall back to Claude model names.
  env[SLOT_ENV.main] = profile.models.main
  for (const tier of TIERS) env[SLOT_ENV[tier]] = profile.models[tier] || profile.models.main
  env[SLOT_ENV.subagent] = profile.models.subagent || profile.models.main
  const description = endpoint.viaProxy ? `${preset.name} via the Claude Setup proxy` : preset.name
  for (const tier of TIERS) {
    const id = profile.models[tier] || profile.models.main
    env[`${SLOT_ENV[tier]}_NAME`] = modelLabel(preset, id)
    env[`${SLOT_ENV[tier]}_DESCRIPTION`] = description
  }

  if (profile.compatMode || endpoint.viaProxy) {
    env.ENABLE_TOOL_SEARCH = 'false'
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    env.API_TIMEOUT_MS = '3000000'
    settings.skipWebFetchPreflight = true
  }

  for (const [k, v] of Object.entries(preset.extraEnv ?? {})) env[k] = String(v)
  for (const [k, v] of Object.entries(preset.extraSettings ?? {})) settings[k] = v

  if (profile.contextWindow) {
    const window = Math.round(profile.contextWindow)
    if (window >= 100_000) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(window, 1_000_000))
    const main = profile.models.main
    // Only declares the window of ids Claude Code doesn't know; ignored for `[1m]` and claude-* ids anyway.
    if (!hasContextSuffix(main) && !/^claude-/i.test(main)) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window)
  }
  if (!env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const declared = knownWindowForPlainIds(profile, preset)
    if (declared) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(declared)
  }

  if (endpoint.viaProxy) {
    const proxyVar = envValue(context.shellEnv, 'HTTPS_PROXY') ?? envValue(context.shellEnv, 'HTTP_PROXY')
    const current = context.settingsEnv.NO_PROXY ?? envValue(context.shellEnv, 'NO_PROXY')
    if (nonEmpty(proxyVar) || nonEmpty(context.settingsEnv.NO_PROXY)) env.NO_PROXY = withLoopback(current)
  }

  // The profile's own extras win; an empty value means "don't write this variable".
  for (const [k, v] of Object.entries(profile.extraEnv ?? {})) {
    if (PROTECTED_EXTRA_ENV.includes(k)) continue
    if (v === '') delete env[k]
    else env[k] = String(v)
  }

  const unfilled = Object.entries(env)
    .filter(([, v]) => /^<[^>]+>$/.test(v.trim()))
    .map(([k]) => k)
  if (unfilled.length) {
    throw new PlanError(`Fill in ${unfilled.join(', ')} for ${preset.name} (edit the profile → extra variables), then try again.`)
  }
  return { env, settings }
}
