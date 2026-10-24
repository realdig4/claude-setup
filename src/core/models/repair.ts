/** Repairs offered by the Doctor: credential conflicts, and VS Code settings that drifted from the terminal. */
import type { OpResult } from '@shared/types'
import type { CoreContext } from '../context'
import { cloneJson } from '../fs/json'
import { RELOAD_VSCODE, RESTART_CLAUDE_CODE } from './apply'
import { credentialState } from './auth'
import { rawEnv, readClaudeSettings, settingsErrorMessage, stringEnv, writeClaudeSettings } from './claudeSettings'
import { readMarker, updateMarker } from './marker'
import { CLOUD_SWITCH_ENV, CREDENTIAL_ENV, isAlwaysOwned, isOurKeyHelper, valueTag } from './ownedKeys'
import { getProfile } from './profiles'
import { findProvider } from './providers'
import { claudeMarkerFor, errorText, mergeVsMarkers, writeVsCodeEnv } from './writers'

type Credential = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'apiKeyHelper'

const CREDENTIAL_LABEL: Record<Credential, string> = {
  ANTHROPIC_AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  apiKeyHelper: 'the apiKeyHelper command'
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Keep exactly one credential for Claude Code. The one matching the active profile wins (else the Bearer token);
 * the others are blanked in settings.json, which also cancels values exported in the shell.
 */
export async function resolveAuthConflict(ctx: CoreContext): Promise<OpResult> {
  const file = await readClaudeSettings()
  if (file.error || !file.data) return { ok: false, message: settingsErrorMessage(file) }
  const data = cloneJson(file.data)
  const env: Record<string, unknown> = { ...rawEnv(data) }
  const state = credentialState(env, data.apiKeyHelper, process.env)
  if (state.count <= 1) return { ok: true, message: 'Claude Code has only one credential — nothing needed fixing.' }

  const active = getProfile(ctx, ctx.state.get().activeProfileId)
  const preset = findProvider(active?.providerId)
  let keep: Credential
  if (state.helper && active?.useKeyHelper && isOurKeyHelper(data.apiKeyHelper)) keep = 'apiKeyHelper'
  else if (state.apiKey && preset?.authEnv === 'ANTHROPIC_API_KEY') keep = 'ANTHROPIC_API_KEY'
  else if (state.token) keep = 'ANTHROPIC_AUTH_TOKEN'
  else if (state.apiKey) keep = 'ANTHROPIC_API_KEY'
  else keep = 'apiKeyHelper'

  const changes: string[] = []
  for (const name of CREDENTIAL_ENV) {
    if (name === keep) continue
    const source = name === 'ANTHROPIC_AUTH_TOKEN' ? state.token : state.apiKey
    if (!source) continue
    env[name] = ''
    changes.push(source === 'shell' ? `${name} from your environment variables (cancelled in settings.json)` : name)
  }
  let foreignHelper = false
  if (keep !== 'apiKeyHelper' && state.helper) {
    if (isOurKeyHelper(data.apiKeyHelper)) {
      delete data.apiKeyHelper
      changes.push('apiKeyHelper')
    } else {
      foreignHelper = true
    }
  }
  const helperNote =
    "settings.json also has an apiKeyHelper command that Claude Setup didn't add; remove it yourself if you don't need it."
  if (!changes.length) return { ok: false, message: `Claude Code still has two credentials: ${helperNote}` }
  data.env = env

  let backupId: string
  try {
    backupId = (await ctx.backups.snapshot('Fix Claude Code credential conflict', [file.path])).id
  } catch (err) {
    return { ok: false, message: `Couldn't back up Claude Code's settings, so nothing was changed: ${errorText(err)}` }
  }
  try {
    await writeClaudeSettings(file, data)
  } catch (err) {
    return { ok: false, message: `Couldn't save ${file.path}: ${errorText(err)}`, backupId }
  }
  ctx.log.info('models', `Resolved credential conflict: kept ${keep}, removed ${changes.join(', ')}`)
  ctx.events.emitEvent('state', { key: 'models' })
  return {
    ok: true,
    message: `Claude Code now uses only ${CREDENTIAL_LABEL[keep]}. ${RESTART_CLAUDE_CODE}${foreignHelper ? ` Note: ${helperNote}` : ''}`,
    details: `Removed: ${changes.join('; ')}`,
    backupId
  }
}

/**
 * Make VS Code's Claude Code extension use the same model settings as the terminal (settings.json env) —
 * used when no profile is active, e.g. after a manual setup or a reset of only one side.
 */
export async function syncVsCodeWithClaudeCode(ctx: CoreContext): Promise<OpResult> {
  const file = await readClaudeSettings()
  if (file.error || !file.data) return { ok: false, message: settingsErrorMessage(file) }
  const marker = readMarker(ctx)
  const prev = claudeMarkerFor(marker, file.path)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(stringEnv(file.data).env)) {
    if (isAlwaysOwned(k) || (prev?.env[k] !== undefined && valueTag(v) === prev.env[k])) env[k] = v
  }
  const routed = nonEmpty(env.ANTHROPIC_BASE_URL) || [...CLOUD_SWITCH_ENV, ...CREDENTIAL_ENV].some((k) => nonEmpty(env[k]))
  const out = await writeVsCodeEnv(ctx, routed ? env : null, marker, {
    reason: 'Match VS Code to Claude Code',
    okMessage: routed
      ? 'VS Code now uses the same model settings as Claude Code in the terminal.'
      : "VS Code's Claude Code extension now uses your Claude account, like the terminal.",
    unchangedMessage: 'VS Code already matches Claude Code.'
  })
  if (out.result.ok) {
    await updateMarker(ctx, (m) => {
      m.vscode = mergeVsMarkers(m.vscode, out.files)
    })
    ctx.events.emitEvent('state', { key: 'models' })
  }
  return {
    ok: out.result.ok,
    message: out.result.ok && out.wrote ? `${out.result.message} ${RELOAD_VSCODE}` : out.result.message,
    ...(out.warnings.length ? { details: out.warnings.join('\n') } : {}),
    ...(out.result.backupId ? { backupId: out.result.backupId } : {})
  }
}
