/** apply() and reset(): put a model profile into Claude Code / VS Code, or go back to official Claude. */
import { join } from 'node:path'
import type { ProxyApi } from '@shared/api'
import type { ApplyModelRequest, ApplyModelResult, ModelProfile, ModelTarget, ProviderPreset } from '@shared/types'
import type { CoreContext } from '../context'
import { pathExists } from '../fs/json'
import { claudeConfigDir } from '../platform/paths'
import { readClaudeSettings, stringEnv } from './claudeSettings'
import { readMarker, updateMarker } from './marker'
import { keyHelperCommand, keyHelperShimPath } from './ownedKeys'
import { buildPlan, PlanError, type ApplyPlan, type Endpoint } from './plan'
import { getProfile, MODEL_SLOTS } from './profiles'
import { ANTHROPIC_CAVEAT, findProvider, modelLabel, modelNotices } from './providers'
import { setupProxyForProfile } from './proxySetup'
import { clearClaudeCode, errorText, mergeVsMarkers, writeClaudeCodePlan, writeVsCodeEnv, type TargetResult } from './writers'

export const RESTART_CLAUDE_CODE = 'Restart Claude Code (close it and run claude again) to use the new settings.'
export const RELOAD_VSCODE = 'Reload VS Code (Command Palette → "Developer: Reload Window") so the Claude Code extension picks up the change.'

const PROXY_RUNNING_NOTE =
  "Claude Code reaches this provider through Claude Setup's local proxy, so keep Claude Setup running " +
  '(it can stay in the tray) or turn on starting it at login.'
const API_KEY_APPROVAL_NOTE =
  'Claude Code asks once whether to use a new API key: run claude in a terminal and choose "Yes" (then restart VS Code if you use it).'
const KEY_HELPER_NOTE =
  'Your key stays in Claude Setup: Claude Code reads it with the claude-setup command. ' +
  "Install that command from Settings if you haven't yet, or Claude Code can't sign in."
const KEY_HELPER_VSCODE_ONLY_NOTE =
  "Key-helper mode is stored in Claude Code's settings — apply this profile to Claude Code as well, or VS Code can't sign in."
const LOGIN_WITH_API_KEY_NOTE =
  'You are also signed in to Claude Code with a Claude account, and an API key next to a login can confuse Claude Code. ' +
  'If it warns about auth, run /logout in Claude Code once.'
const LOGIN_WITH_TOKEN_NOTE =
  'You are also signed in to Claude Code with a Claude account. The provider key takes over (Claude Code may say it is ' +
  '"overriding Claude subscription login"); run /logout in Claude Code if sign-in problems appear.'

/** Valid, de-duplicated model targets. */
export function uniqueTargets(targets: unknown): ModelTarget[] {
  const list = Array.isArray(targets) ? targets : []
  return [...new Set(list.filter((t): t is ModelTarget => t === 'claude-code' || t === 'vscode'))]
}

function failAll(targets: ModelTarget[], message: string, warnings: string[] = []): ApplyModelResult {
  return { ok: false, results: targets.map((target) => ({ target, ok: false, message })), warnings }
}

const NO_TARGETS: ApplyModelResult = { ok: false, results: [], warnings: ['Choose where to apply it: Claude Code, VS Code or both.'] }

function isThirdParty(preset: ProviderPreset): boolean {
  return preset.kind !== 'anthropic' && preset.kind !== 'cloud'
}

type EndpointResult = { endpoint: Endpoint; proxyStarted?: boolean } | { error: string }

/** Read the profile's key and work out where Claude Code should connect. Returns an error message on failure. */
async function resolveEndpoint(ctx: CoreContext, proxy: ProxyApi, profile: ModelProfile, preset: ProviderPreset, warnings: string[]): Promise<EndpointResult> {
  let key: string | null = null
  if (profile.keyRef) {
    try {
      key = await ctx.secrets.get(profile.keyRef)
    } catch (err) {
      return { error: `Couldn't read the saved API key for "${profile.name}": ${errorText(err)}` }
    }
  }
  if (!key && profile.hasKey) {
    return { error: `The saved API key for "${profile.name}" is missing. Edit the profile, enter the key again and save.` }
  }
  if (preset.requiresKey && !key) return { error: `Add your ${preset.name} API key to "${profile.name}" first.` }

  if (preset.kind === 'openai-proxy') {
    const setup = await setupProxyForProfile(proxy, profile, preset)
    if (!setup.ok || !setup.baseUrl || !setup.token) return { error: setup.message ?? 'The translation proxy could not be set up.' }
    if (!setup.started) {
      const why = setup.message ?? "The translation proxy didn't start."
      warnings.push(`${why} Claude Code is set up to use it at ${setup.baseUrl} — start it on the Proxy page or with the Doctor.`)
    }
    warnings.push(PROXY_RUNNING_NOTE)
    const endpoint: Endpoint = { baseUrl: setup.baseUrl, authVar: 'ANTHROPIC_AUTH_TOKEN', credential: setup.token, viaProxy: true }
    return { endpoint, proxyStarted: setup.started }
  }
  if (preset.kind === 'cloud') return { endpoint: { credential: key ?? undefined } }
  const baseUrl = profile.baseUrl || undefined
  if (profile.useKeyHelper && key) return { endpoint: { baseUrl, helper: keyHelperCommand(profile.id) } }
  const authVar = preset.authEnv === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
  return { endpoint: { baseUrl, authVar, credential: key ?? preset.defaultKey } }
}

function successMessage(target: ModelTarget, profile: ModelProfile, preset: ProviderPreset, endpoint: Endpoint): string {
  const app = target === 'claude-code' ? 'Claude Code' : "VS Code's Claude Code extension"
  if (preset.kind === 'anthropic') {
    return endpoint.credential || endpoint.helper ? `${app} now uses Claude with your Anthropic API key.` : `${app} now uses your Claude account.`
  }
  const model = modelLabel(preset, profile.models.main)
  if (preset.kind === 'cloud') return `${app} now uses ${model} through ${preset.name}.`
  return `${app} now uses ${model} from ${preset.name}${endpoint.viaProxy ? ' (through the local proxy)' : ''}.`
}

/** Warnings shown after a successful apply. */
async function afterApplyWarnings(profile: ModelProfile, preset: ProviderPreset, endpoint: Endpoint, targets: ModelTarget[]): Promise<string[]> {
  const out: string[] = []
  if (isThirdParty(preset)) out.push(ANTHROPIC_CAVEAT)
  out.push(...modelNotices(preset.id, MODEL_SLOTS.map((s) => profile.models[s])))
  if (endpoint.authVar === 'ANTHROPIC_API_KEY' && endpoint.credential && !endpoint.helper) out.push(API_KEY_APPROVAL_NOTE)
  if (endpoint.helper) {
    out.push(KEY_HELPER_NOTE)
    if (!(await pathExists(keyHelperShimPath()))) {
      out.push('The claude-setup terminal command is not installed yet, so Claude Code cannot read the key. Install it in Settings → "Terminal command", or turn off "Keep the key out of settings files".')
    }
    if (!targets.includes('claude-code')) out.push(KEY_HELPER_VSCODE_ONLY_NOTE)
  }
  if (isThirdParty(preset) && !endpoint.credential && !endpoint.helper) {
    out.push('No API key is set for this profile, so Claude Code may ask you to sign in.')
  }
  if (isThirdParty(preset) && (await pathExists(join(claudeConfigDir(), '.credentials.json')))) {
    out.push(endpoint.authVar === 'ANTHROPIC_API_KEY' ? LOGIN_WITH_API_KEY_NOTE : LOGIN_WITH_TOKEN_NOTE)
  }
  return out
}

/** Apply a profile to Claude Code and/or VS Code. */
export async function applyProfile(ctx: CoreContext, proxy: ProxyApi, req: ApplyModelRequest): Promise<ApplyModelResult> {
  const targets = uniqueTargets(req?.targets)
  if (!targets.length) return structuredClone(NO_TARGETS)
  const profile = getProfile(ctx, req.profileId)
  if (!profile) return failAll(targets, 'That model profile no longer exists. Refresh the list and pick it again.')
  const preset = findProvider(profile.providerId)
  if (!preset) return failAll(targets, `"${profile.name}" uses a provider this version of Claude Setup doesn't know (${profile.providerId}).`)

  const warnings: string[] = []
  const resolved = await resolveEndpoint(ctx, proxy, profile, preset, warnings)
  if ('error' in resolved) return failAll(targets, resolved.error, warnings)
  const { endpoint, proxyStarted } = resolved

  const settingsFile = await readClaudeSettings()
  let plan: ApplyPlan
  try {
    plan = buildPlan(profile, preset, endpoint, { shellEnv: process.env, settingsEnv: stringEnv(settingsFile.data).env })
  } catch (err) {
    if (err instanceof PlanError) return failAll(targets, err.message, warnings)
    throw err
  }

  const marker = readMarker(ctx)
  const results: TargetResult[] = []
  const hasEnv = Object.keys(plan.env).length > 0
  let claude: Awaited<ReturnType<typeof writeClaudeCodePlan>> | undefined
  let vscode: Awaited<ReturnType<typeof writeVsCodeEnv>> | undefined

  if (targets.includes('claude-code')) {
    claude = await writeClaudeCodePlan(ctx, settingsFile, plan, marker, {
      reason: `Use "${profile.name}" in Claude Code`,
      onboarding: preset.kind !== 'anthropic',
      okMessage: successMessage('claude-code', profile, preset, endpoint),
      unchangedMessage: preset.kind === 'anthropic' && !hasEnv ? 'Claude Code already uses your Claude account.' : 'Claude Code already uses these settings.'
    })
    results.push(claude.result)
    warnings.push(...claude.warnings)
  }
  if (targets.includes('vscode')) {
    vscode = await writeVsCodeEnv(ctx, hasEnv ? plan.env : null, marker, {
      reason: `Use "${profile.name}" in VS Code`,
      okMessage: successMessage('vscode', profile, preset, endpoint),
      unchangedMessage: hasEnv ? 'VS Code already uses these settings.' : 'VS Code already uses your Claude account.'
    })
    results.push(vscode.result)
    warnings.push(...vscode.warnings)
  }

  if (results.some((r) => r.ok)) {
    await updateMarker(
      ctx,
      (m) => {
        m.profileId = profile.id
        if (claude?.result.ok && claude.changed) m.claudeCode = claude.marker
        if (claude?.onboardingSet) m.onboardingSet = true
        if (vscode?.result.ok) m.vscode = mergeVsMarkers(m.vscode, vscode.files)
      },
      (draft) => {
        draft.activeProfileId = profile.id
      }
    )
    ctx.events.emitEvent('state', { key: 'models' })
    warnings.push(...(await afterApplyWarnings(profile, preset, endpoint, targets)))
    if (claude?.result.ok && claude.result.backupId) warnings.push(RESTART_CLAUDE_CODE)
    if (vscode?.result.ok && vscode.wrote) warnings.push(RELOAD_VSCODE)
  }
  const outcome = results.map((r) => `${r.target} ${r.ok ? 'ok' : 'failed'}`).join(', ')
  ctx.log.info('models', `Applied "${profile.name}" to ${targets.join(' + ')}: ${outcome}`)
  return {
    ok: results.length > 0 && results.every((r) => r.ok) && proxyStarted !== false,
    results,
    warnings: [...new Set(warnings)],
    ...(proxyStarted !== undefined ? { proxyStarted } : {})
  }
}

/** Remove every third-party model setting Claude Setup owns → back to official Claude. */
export async function resetModels(ctx: CoreContext, targetsInput: ModelTarget[]): Promise<ApplyModelResult> {
  const targets = uniqueTargets(targetsInput)
  if (!targets.length) return structuredClone(NO_TARGETS)
  const marker = readMarker(ctx)
  const results: TargetResult[] = []
  const warnings: string[] = []
  let claude: Awaited<ReturnType<typeof clearClaudeCode>> | undefined
  let vscode: Awaited<ReturnType<typeof writeVsCodeEnv>> | undefined

  if (targets.includes('claude-code')) {
    claude = await clearClaudeCode(ctx, marker)
    results.push(claude.result)
    warnings.push(...claude.warnings)
  }
  if (targets.includes('vscode')) {
    vscode = await writeVsCodeEnv(ctx, null, marker, {
      reason: 'Go back to Claude in VS Code',
      okMessage: "VS Code's Claude Code extension uses your Claude account again.",
      unchangedMessage: 'VS Code already uses your Claude account — there was nothing to remove.'
    })
    results.push(vscode.result)
    warnings.push(...vscode.warnings)
  }

  const claudeCleared = Boolean(claude?.result.ok && claude.changed)
  if (claudeCleared || vscode?.result.ok) {
    await updateMarker(
      ctx,
      (m) => {
        if (claudeCleared) {
          delete m.claudeCode
          delete m.profileId
        }
        if (vscode?.result.ok) m.vscode = mergeVsMarkers(m.vscode, vscode.files.map((f) => ({ path: f.path })))
      },
      (draft) => {
        if (claudeCleared) delete draft.activeProfileId
      }
    )
    ctx.events.emitEvent('state', { key: 'models' })
  }
  if (claude?.result.ok && claude.result.backupId) warnings.push(RESTART_CLAUDE_CODE)
  if (vscode?.result.ok && vscode.wrote) warnings.push(RELOAD_VSCODE)
  return { ok: results.every((r) => r.ok), results, warnings: [...new Set(warnings)] }
}
