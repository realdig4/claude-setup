/**
 * What Claude Code / VS Code currently use for models, plus problems (auth conflicts, missing slots, proxy down…).
 * `inspectModels` returns structured data (used by the Doctor); `toModelStatus` maps it to the public ModelStatus.
 */
import type { ProxyApi } from '@shared/api'
import type { ModelProfile, ModelStatus, ProviderPreset, ProxyConfig } from '@shared/types'
import type { CoreContext } from '../context'
import { credentialState, describeCredentials, type CredentialState } from './auth'
import { rawEnv, readClaudeSettings, stringEnv } from './claudeSettings'
import { readMarker, vscodeMarkerFor } from './marker'
import { CLOUD_SWITCH_ENV, CREDENTIAL_ENV, SLOT_ENV } from './ownedKeys'
import { findProvider, modelNotices, providerForBaseUrl } from './providers'
import { withTimeout } from './timeout'
import { hostOf, loopbackPort, normalizeBaseUrl } from './urls'
import { ENV_SETTING, ownedEnvMap, parseEnvEntries, readVsCodeSettings, vscodeSettingsTargets } from './vscode'

export type ModelIssueCode =
  | 'settings-invalid'
  | 'non-string-env'
  | 'auth-conflict'
  | 'no-credential'
  | 'missing-slots'
  | 'proxy-down'
  | 'proxy-token'
  | 'retiring'
  | 'base-url-v1'
  | 'deprecated-var'
  | 'gateway-var'
  | 'shell-routing'
  | 'vscode-invalid'

export interface ModelIssue {
  code: ModelIssueCode
  message: string
}

export interface ModelInspection {
  settingsPath: string
  settingsExists: boolean
  settingsError?: string
  /** String-valued settings.json env. */
  env: Record<string, string>
  apiKeyHelper?: string
  mode: ModelStatus['mode']
  baseUrl?: string
  model?: string
  authVar?: ModelStatus['authVar']
  credentials: CredentialState
  profile?: ModelProfile
  preset?: ProviderPreset
  providerName?: string
  /** ANTHROPIC_BASE_URL points at Claude Setup's translation proxy. */
  usesProxy: boolean
  /** Proxy state when `usesProxy` (undefined when it couldn't be checked). */
  proxyRunning?: boolean
  vscode: { configured: boolean; matches: boolean; path?: string; error?: string }
  issues: ModelIssue[]
  shellOverrides: string[]
}

const ROUTING_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', ...CLOUD_SWITCH_ENV]

const CLOUD_PRESETS: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'bedrock',
  CLAUDE_CODE_USE_VERTEX: 'vertex',
  CLAUDE_CODE_USE_FOUNDRY: 'foundry'
}

const CLOUD_NAMES: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Amazon Bedrock',
  CLAUDE_CODE_USE_VERTEX: 'Google Cloud Vertex AI',
  CLAUDE_CODE_USE_FOUNDRY: 'Microsoft Foundry',
  CLAUDE_CODE_USE_MANTLE: 'Amazon Bedrock (Mantle)',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: 'Claude Platform on AWS'
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Claude Code treats a cloud switch as on unless it is empty, "0" or "false". */
function switchOn(value: unknown): boolean {
  return nonEmpty(value) && !/^(0|false|no|off)$/i.test(value.trim())
}

/** Names of ANTHROPIC_… and CLAUDE_CODE_USE_… variables in this process's environment (values never returned). */
export function shellOverrideNames(env: Record<string, string | undefined> = process.env): string[] {
  const names = Object.entries(env)
    .filter(([k, v]) => nonEmpty(v) && (/^ANTHROPIC_/i.test(k) || /^CLAUDE_CODE_USE_/i.test(k)))
    .map(([k]) => k.toUpperCase())
  return [...new Set(names)].sort()
}

function settled<T>(fn: () => Promise<T>, ms: number): Promise<T | undefined> {
  return withTimeout(Promise.resolve().then(fn), ms).catch(() => undefined)
}

function matchProfile(p: ModelProfile, env: Record<string, string>, mode: ModelStatus['mode'], usesProxy: boolean): boolean {
  const preset = findProvider(p.providerId)
  if (!preset) return false
  if (preset.kind === 'anthropic') return mode === 'anthropic'
  if (env.ANTHROPIC_MODEL !== p.models.main) return false
  if (preset.kind === 'openai-proxy') return usesProxy
  if (preset.kind === 'cloud') {
    const switches = Object.keys(preset.cloudEnv ?? {}).filter((k) => k.startsWith('CLAUDE_CODE_USE_'))
    return mode === 'cloud' && switches.length > 0 && switches.every((k) => switchOn(env[k]))
  }
  return mode === 'custom' && !usesProxy && normalizeBaseUrl(p.baseUrl) === normalizeBaseUrl(env.ANTHROPIC_BASE_URL)
}

/** VS Code agrees with the terminal when routing and credentials don't contradict settings.json. */
function vscodeAgrees(vs: Record<string, string>, env: Record<string, string>): boolean {
  for (const k of ROUTING_ENV) {
    const a = k === 'ANTHROPIC_BASE_URL' ? normalizeBaseUrl(vs[k]) : (vs[k] ?? '').trim()
    const b = k === 'ANTHROPIC_BASE_URL' ? normalizeBaseUrl(env[k]) : (env[k] ?? '').trim()
    if (a !== b) return false
  }
  return CREDENTIAL_ENV.every((k) => !nonEmpty(vs[k]) || !nonEmpty(env[k]) || vs[k] === env[k])
}

interface ProxyFacts {
  usesProxy: boolean
  proxyRunning?: boolean
  issues: ModelIssue[]
}

/** Does ANTHROPIC_BASE_URL point at our proxy, is it running, and is the token current? */
async function inspectProxy(ctx: CoreContext, proxy: ProxyApi | undefined, baseUrl: string | undefined, env: Record<string, string>): Promise<ProxyFacts> {
  const port = loopbackPort(baseUrl)
  if (port === null) return { usesProxy: false, issues: [] }
  const state = ctx.state.get()
  const config: ProxyConfig | undefined = proxy ? await settled(() => proxy.getConfig(), 4000) : undefined
  if (port !== (config?.port ?? state.proxy?.port)) return { usesProxy: false, issues: [] }

  const issues: ModelIssue[] = []
  const status = proxy ? await settled(() => proxy.status(), 4000) : undefined
  if (status?.running === false) {
    issues.push({
      code: 'proxy-down',
      message:
        `Claude Code is set to use Claude Setup's translation proxy (${baseUrl}), but the proxy isn't running, ` +
        "so Claude Code can't reach the model. Start the proxy."
    })
  }
  const token = config?.authToken ?? state.proxy?.authToken
  if (token && nonEmpty(env.ANTHROPIC_AUTH_TOKEN) && env.ANTHROPIC_AUTH_TOKEN !== token) {
    issues.push({
      code: 'proxy-token',
      message: 'Claude Code has an outdated access token for the translation proxy. Apply your model profile again to update it.'
    })
  }
  return { usesProxy: true, ...(status ? { proxyRunning: status.running } : {}), issues }
}

/** Problems in a readable settings.json. */
function configIssues(
  env: Record<string, string>,
  mode: ModelStatus['mode'],
  credentials: CredentialState,
  providerName: string | undefined,
  noticeProvider: string | undefined
): ModelIssue[] {
  const issues: ModelIssue[] = []
  const baseUrl = env.ANTHROPIC_BASE_URL
  if (credentials.count > 1) {
    issues.push({
      code: 'auth-conflict',
      message:
        `Claude Code sees more than one credential: ${describeCredentials(credentials)}. ` +
        'It warns that auth may not work as expected — keep only one.'
    })
  }
  if (mode === 'custom' && credentials.count === 0) {
    issues.push({ code: 'no-credential', message: `No API key is set for ${providerName ?? 'the custom endpoint'}, so Claude Code will ask you to sign in.` })
  }
  if (mode === 'custom') {
    const missing = Object.values(SLOT_ENV).filter((k) => !nonEmpty(env[k]))
    if (missing.length) {
      issues.push({
        code: 'missing-slots',
        message:
          `Some model settings are missing (${missing.join(', ')}). Background tasks and subagents then ask for Claude models ` +
          `that ${providerName ?? 'the provider'} may reject — apply your profile again to fill them in.`
      })
    }
  }
  for (const message of modelNotices(noticeProvider, Object.values(SLOT_ENV).map((k) => env[k]))) issues.push({ code: 'retiring', message })
  if (nonEmpty(baseUrl) && /\/v1\/?$/i.test(baseUrl.trim())) {
    issues.push({ code: 'base-url-v1', message: 'ANTHROPIC_BASE_URL ends in /v1, so Claude Code calls …/v1/v1/messages and fails. Remove the /v1.' })
  }
  if ('ANTHROPIC_SMALL_FAST_MODEL' in env) {
    issues.push({
      code: 'deprecated-var',
      message: 'ANTHROPIC_SMALL_FAST_MODEL is deprecated; Claude Code now uses ANTHROPIC_DEFAULT_HAIKU_MODEL for background tasks.'
    })
  }
  return issues
}

/** Variables in the shell that settings.json doesn't override (so they really apply). */
function shellIssues(env: Record<string, string>, shell: Record<string, string | undefined>): ModelIssue[] {
  const issues: ModelIssue[] = []
  if (nonEmpty(env.CLAUDE_CODE_USE_GATEWAY) || nonEmpty(shell.CLAUDE_CODE_USE_GATEWAY)) {
    issues.push({ code: 'gateway-var', message: 'CLAUDE_CODE_USE_GATEWAY is an undocumented setting that can force a cloud sign-in. Remove it.' })
  }
  for (const name of ['ANTHROPIC_BASE_URL', ...CLOUD_SWITCH_ENV]) {
    if (name in env || !nonEmpty(shell[name])) continue
    const shown = name === 'ANTHROPIC_BASE_URL' ? ` (${hostOf(shell[name] as string)})` : ''
    issues.push({
      code: 'shell-routing',
      message: `Your environment variables set ${name}${shown}, and settings.json doesn't override it, so Claude Code in a terminal uses it.`
    })
  }
  return issues
}

/** Whether VS Code's Claude Code extension is configured and agrees with settings.json. */
async function inspectVsCode(ctx: CoreContext, env: Record<string, string>): Promise<{ vscode: ModelInspection['vscode']; issues: ModelIssue[] }> {
  const marker = readMarker(ctx)
  const vscode: ModelInspection['vscode'] = { configured: false, matches: true }
  const issues: ModelIssue[] = []
  try {
    const targets = await vscodeSettingsTargets()
    const files = await Promise.all(targets.map((t) => readVsCodeSettings(t.variant, t.path)))
    vscode.path = files[0]?.path
    const maps = files
      .filter((f) => !f.error)
      .map((f) => ownedEnvMap(parseEnvEntries(f.data?.[ENV_SETTING]), vscodeMarkerFor(marker, f.path)))
    const configured = maps.filter((m) => [...ROUTING_ENV, ...CREDENTIAL_ENV].some((k) => nonEmpty(m[k])))
    vscode.configured = configured.length > 0
    vscode.matches = (configured.length ? configured : maps.slice(0, 1)).every((m) => vscodeAgrees(m, env))
    const broken = files.find((f) => f.error)
    if (broken) {
      vscode.error = broken.error
      issues.push({
        code: 'vscode-invalid',
        message: `VS Code's settings file (${broken.path}) has a syntax error (${broken.error}), so its Claude Code settings can't be checked or changed.`
      })
    }
  } catch (err) {
    vscode.error = (err as Error).message
  }
  return { vscode, issues }
}

/** Inspect Claude Code's model configuration. Never throws. */
export async function inspectModels(ctx: CoreContext, proxy?: ProxyApi): Promise<ModelInspection> {
  const file = await readClaudeSettings()
  const shell = process.env
  const issues: ModelIssue[] = []
  const { env, nonString } = file.error ? { env: {} as Record<string, string>, nonString: [] as string[] } : stringEnv(file.data)
  const apiKeyHelper = nonEmpty(file.data?.apiKeyHelper) ? (file.data!.apiKeyHelper as string) : undefined
  if (file.error) {
    issues.push({
      code: 'settings-invalid',
      message:
        `Claude Code can't read ${file.path} (${file.error}). It shows a "Settings Error" and ignores the whole file ` +
        "until it's fixed — correct it or restore a backup."
    })
  }
  if (nonString.length) {
    issues.push({
      code: 'non-string-env',
      message: `These env values in settings.json aren't text, so Claude Code ignores them: ${nonString.join(', ')}. Put the values in quotes.`
    })
  }

  const cloudSwitch = CLOUD_SWITCH_ENV.find((k) => switchOn(env[k]))
  const baseUrl = nonEmpty(env.ANTHROPIC_BASE_URL) ? env.ANTHROPIC_BASE_URL.trim() : undefined
  const custom = baseUrl !== undefined && normalizeBaseUrl(baseUrl) !== 'https://api.anthropic.com'
  const mode: ModelStatus['mode'] = cloudSwitch ? 'cloud' : custom ? 'custom' : 'anthropic'
  const credentials = credentialState(file.error ? {} : rawEnv(file.data), apiKeyHelper, shell)
  const authVar: ModelStatus['authVar'] = credentials.token
    ? 'ANTHROPIC_AUTH_TOKEN'
    : credentials.apiKey
      ? 'ANTHROPIC_API_KEY'
      : credentials.helper
        ? 'apiKeyHelper'
        : undefined

  const proxyFacts = await inspectProxy(ctx, proxy, baseUrl, env)
  const { usesProxy } = proxyFacts
  issues.push(...proxyFacts.issues)

  // Which profile / provider is this?
  const state = ctx.state.get()
  const active = state.profiles.find((p) => p.id === state.activeProfileId)
  let profile: ModelProfile | undefined
  if (active && matchProfile(active, env, mode, usesProxy)) profile = active
  else if (mode !== 'anthropic') profile = state.profiles.find((p) => matchProfile(p, env, mode, usesProxy))
  let preset = profile ? findProvider(profile.providerId) : undefined
  if (!preset && mode === 'custom' && !usesProxy) preset = providerForBaseUrl(baseUrl)?.preset
  if (!preset && mode === 'cloud' && cloudSwitch) preset = findProvider(CLOUD_PRESETS[cloudSwitch])
  if (!preset && mode === 'anthropic') preset = findProvider('anthropic')
  const providerName = preset?.name ?? (usesProxy ? 'Claude Setup translation proxy' : cloudSwitch ? CLOUD_NAMES[cloudSwitch] : undefined)

  if (!file.error) {
    const noticeProvider = preset?.id ?? providerForBaseUrl(baseUrl)?.preset.id
    issues.push(...configIssues(env, mode, credentials, providerName, noticeProvider))
  }
  issues.push(...shellIssues(env, shell))
  const vs = await inspectVsCode(ctx, env)
  issues.push(...vs.issues)

  return {
    settingsPath: file.path,
    settingsExists: file.exists,
    ...(file.error ? { settingsError: file.error } : {}),
    env,
    ...(apiKeyHelper ? { apiKeyHelper } : {}),
    mode,
    ...(baseUrl ? { baseUrl } : {}),
    ...(nonEmpty(env.ANTHROPIC_MODEL) ? { model: env.ANTHROPIC_MODEL } : {}),
    ...(authVar ? { authVar } : {}),
    credentials,
    ...(profile ? { profile } : {}),
    ...(preset ? { preset } : {}),
    ...(providerName ? { providerName } : {}),
    usesProxy,
    ...(proxyFacts.proxyRunning !== undefined ? { proxyRunning: proxyFacts.proxyRunning } : {}),
    vscode: vs.vscode,
    issues,
    shellOverrides: shellOverrideNames(shell)
  }
}

/** Public ModelStatus from an inspection. */
export function toModelStatus(i: ModelInspection): ModelStatus {
  const status: ModelStatus = {
    mode: i.mode,
    vscodeConfigured: i.vscode.configured,
    vscodeMatches: i.vscode.matches,
    problems: i.issues.map((x) => x.message),
    shellOverrides: i.shellOverrides
  }
  if (i.profile) status.profileId = i.profile.id
  if (i.preset) status.providerId = i.preset.id
  if (i.providerName) status.providerName = i.providerName
  if (i.baseUrl) status.baseUrl = i.baseUrl
  if (i.model) status.model = i.model
  if (i.authVar) status.authVar = i.authVar
  return status
}
