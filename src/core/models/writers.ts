/**
 * Writers for the two model targets. Each one: read → compute → back up → write atomically, and reports what it
 * now owns (for the apply marker). They never throw for expected problems; results carry friendly messages.
 */
import { dirname } from 'node:path'
import type { ApplyModelResult } from '@shared/types'
import type { CoreContext } from '../context'
import { cloneJson, editJsonc, pathExists } from '../fs/json'
import { claudeJsonPath, type EditorVariant } from '../platform/paths'
import {
  physicalPath,
  planClaudeJson,
  rawEnv,
  readClaudeSettings,
  removeOwned,
  settingsErrorMessage,
  stringEnv,
  writeClaudeJson,
  writeClaudeSettings,
  type ClaudeJsonUpdate,
  type SettingsFile
} from './claudeSettings'
import { samePath, vscodeMarkerFor, type ModelApplyMarker, type WrittenFile } from './marker'
import { CLOUD_SWITCH_ENV, CREDENTIAL_ENV, isAlwaysOwned, isOurKeyHelper, valueTag } from './ownedKeys'
import type { ApplyPlan } from './plan'
import { planVsCodeEdit, readVsCodeSettings, vscodeSettingsTargets } from './vscode'

export type TargetResult = ApplyModelResult['results'][number]

const FOREIGN_HELPER_NOTE =
  "Claude Code's settings also contain an apiKeyHelper command that Claude Setup didn't add. Claude Code uses the provider key " +
  "instead, but may warn about two credentials — remove apiKeyHelper from settings.json if you don't need it."

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** Claude Code's marker entry when it refers to this settings file. */
export function claudeMarkerFor(marker: ModelApplyMarker, path: string): WrittenFile | undefined {
  return marker.claudeCode && samePath(marker.claudeCode.path, path) ? marker.claudeCode : undefined
}

/** True when settings.json routes Claude Code away from the official setup (or holds something we wrote). */
export function thirdPartyActive(data: Record<string, unknown>, prev: WrittenFile | undefined): boolean {
  const env = rawEnv(data)
  const routed = ['ANTHROPIC_BASE_URL', ...CLOUD_SWITCH_ENV, ...CREDENTIAL_ENV].some((k) => nonEmpty(env[k]))
  return routed || isOurKeyHelper(data.apiKeyHelper) || prev !== undefined
}

export interface ClaudeCodeWrite {
  result: TargetResult
  /** The marker entry should be replaced by `marker` (also true when nothing needed changing). */
  changed: boolean
  marker?: WrittenFile
  warnings: string[]
}

function claudeResult(path: string, ok: boolean, message: string, extra: Partial<ClaudeCodeWrite> & { backupId?: string } = {}): ClaudeCodeWrite {
  const { backupId, ...rest } = extra
  return {
    result: { target: 'claude-code', ok, message, configPath: path, ...(backupId ? { backupId } : {}) },
    changed: false,
    warnings: [],
    ...rest
  }
}

/** Snapshot `paths`; returns the backup id or a friendly error. */
async function backup(ctx: CoreContext, reason: string, paths: string[], what: string): Promise<{ id: string } | { error: string }> {
  try {
    return { id: (await ctx.backups.snapshot(reason, paths)).id }
  } catch (err) {
    return { error: `Couldn't back up ${what}, so nothing was changed: ${errorText(err)}` }
  }
}

/**
 * Write a plan into ~/.claude/settings.json: remove everything Claude Setup owns, then add the plan.
 * `reason` labels the backup.
 */
export async function writeClaudeCodePlan(
  ctx: CoreContext,
  file: SettingsFile,
  plan: ApplyPlan,
  marker: ModelApplyMarker,
  opts: { reason: string; okMessage: string; unchangedMessage: string }
): Promise<ClaudeCodeWrite> {
  if (file.error || !file.data) return claudeResult(file.path, false, settingsErrorMessage(file))
  const before = file.data
  const prev = claudeMarkerFor(marker, file.path)
  const planIsEmpty = !Object.keys(plan.env).length && !Object.keys(plan.settings).length
  if (planIsEmpty && !thirdPartyActive(before, prev)) return claudeResult(file.path, true, opts.unchangedMessage)

  const warnings: string[] = []
  const beforeEnv = stringEnv(before).env
  const data = cloneJson(before)
  removeOwned(data, prev)
  const env: Record<string, unknown> = { ...rawEnv(data) }
  const written: WrittenFile = { path: file.path, env: {}, settings: {} }
  for (const [k, v] of Object.entries(plan.env)) {
    env[k] = v
    const userAlreadyHadIt = beforeEnv[k] === v && prev?.env[k] === undefined
    if (!isAlwaysOwned(k) && !userAlreadyHadIt) written.env[k] = valueTag(v)
  }
  if (Object.keys(env).length) data.env = env
  else delete data.env
  for (const [k, v] of Object.entries(plan.settings)) {
    const userAlreadyHadIt = valueTag(before[k]) === valueTag(v) && prev?.settings[k] === undefined && !isOurKeyHelper(before[k])
    data[k] = v
    if (!userAlreadyHadIt) written.settings[k] = valueTag(v)
  }
  if (nonEmpty(data.apiKeyHelper) && !('apiKeyHelper' in plan.settings) && !planIsEmpty) warnings.push(FOREIGN_HELPER_NOTE)

  if (JSON.stringify(data) === JSON.stringify(before)) {
    return claudeResult(file.path, true, opts.unchangedMessage, { changed: true, marker: written, warnings })
  }
  const saved = await backup(ctx, opts.reason, [file.path], "Claude Code's settings")
  if ('error' in saved) return claudeResult(file.path, false, saved.error, { warnings })
  try {
    await writeClaudeSettings(file, data)
  } catch (err) {
    return claudeResult(file.path, false, `Couldn't save ${file.path}: ${errorText(err)}`, { warnings, backupId: saved.id })
  }
  ctx.log.info('models', `Updated ${file.path} (env: ${Object.keys(plan.env).join(', ') || 'none'})`)
  return claudeResult(file.path, true, opts.okMessage, { changed: true, marker: written, warnings, backupId: saved.id })
}

export interface ClaudeJsonWrite {
  /** We set hasCompletedOnboarding just now. */
  onboardingSet: boolean
  /** The API key is approved in ~/.claude.json (now or already). */
  keyApproved: boolean
  warnings: string[]
}

/**
 * Update ~/.claude.json for a model setup (first-run flag, API key approval). It is backed up first, and only when
 * something actually changes — restoring that backup also rolls back MCP servers and project state.
 */
export async function updateClaudeJson(ctx: CoreContext, update: ClaudeJsonUpdate, reason: string): Promise<ClaudeJsonWrite> {
  const unchanged = (warning: string): ClaudeJsonWrite => ({ onboardingSet: false, keyApproved: false, warnings: [warning] })
  const failed = (err: unknown): string =>
    `Couldn't update ${claudeJsonPath()} (${errorText(err)}), so Claude Code may show its first-run screen or ask about the API key once.`
  let plan: Awaited<ReturnType<typeof planClaudeJson>>
  try {
    plan = await planClaudeJson(update)
  } catch (err) {
    return unchanged(failed(err))
  }
  const warnings = plan.warning ? [plan.warning] : []
  if (!plan.data) return { onboardingSet: false, keyApproved: plan.keyApproved, warnings }
  const saved = await backup(ctx, reason, [plan.path], "Claude Code's ~/.claude.json")
  if ('error' in saved) return { onboardingSet: false, keyApproved: false, warnings: [...warnings, saved.error] }
  try {
    await writeClaudeJson(plan)
  } catch (err) {
    return { onboardingSet: false, keyApproved: false, warnings: [...warnings, failed(err)] }
  }
  ctx.log.info('models', `Updated ${plan.path}${plan.onboardingSet ? ' (first-run screen skipped)' : ''}${update.approveKey ? ' (API key approved)' : ''}`)
  return { onboardingSet: plan.onboardingSet, keyApproved: plan.keyApproved, warnings }
}

/** Remove everything Claude Setup owns from ~/.claude/settings.json (reset to the official setup). */
export async function clearClaudeCode(ctx: CoreContext, marker: ModelApplyMarker): Promise<ClaudeCodeWrite> {
  const file = await readClaudeSettings()
  const nothing = 'Claude Code already uses your Claude account — there was nothing to remove.'
  if (file.error || !file.data) return claudeResult(file.path, false, settingsErrorMessage(file))
  const prev = claudeMarkerFor(marker, file.path)
  if (!file.exists || !thirdPartyActive(file.data, prev)) return claudeResult(file.path, true, nothing, { changed: true })
  const data = cloneJson(file.data)
  const removed = removeOwned(data, prev)
  const count = removed.env.length + removed.settings.length
  if (!count) return claudeResult(file.path, true, nothing, { changed: true })

  const saved = await backup(ctx, 'Go back to Claude in Claude Code', [file.path], "Claude Code's settings")
  if ('error' in saved) return claudeResult(file.path, false, saved.error)
  try {
    await writeClaudeSettings(file, data)
  } catch (err) {
    return claudeResult(file.path, false, `Couldn't save ${file.path}: ${errorText(err)}`, { backupId: saved.id })
  }
  ctx.log.info('models', `Removed model settings from ${file.path}: ${[...removed.env, ...removed.settings].join(', ')}`)
  const message = `Removed ${count} third-party model setting${count === 1 ? '' : 's'} from Claude Code — it uses your Claude account again.`
  return claudeResult(file.path, true, message, { changed: true, backupId: saved.id })
}

export interface VsCodeWrite {
  result: TargetResult
  /** Files processed and what we own in each afterwards (marker undefined = nothing). */
  files: Array<{ path: string; marker?: WrittenFile }>
  /** At least one file was modified. */
  wrote: boolean
  warnings: string[]
}

function variantLabel(variant: EditorVariant): string {
  return variant === 'Code' ? 'VS Code' : variant === 'Code - Insiders' ? 'VS Code Insiders' : variant
}

function vsResult(path: string, ok: boolean, message: string, backupId?: string): TargetResult {
  return { target: 'vscode', ok, configPath: path, message, ...(backupId ? { backupId } : {}) }
}

/**
 * Write the model env into VS Code user settings (claudeCode.environmentVariables + disableLoginPrompt), or remove
 * ours when `env` is null. Comments and the user's own entries are preserved.
 */
export async function writeVsCodeEnv(
  ctx: CoreContext,
  env: Record<string, string> | null,
  marker: ModelApplyMarker,
  opts: { reason: string; okMessage: string; unchangedMessage: string }
): Promise<VsCodeWrite> {
  const warnings: string[] = []
  const targets = await vscodeSettingsTargets()
  const files = await Promise.all(targets.map((t) => readVsCodeSettings(t.variant, t.path)))
  const primary = files[0]
  if (primary.error) {
    const message = `VS Code's settings file (${primary.path}) has a syntax error (${primary.error}). Fix it in VS Code, then try again. Nothing was changed.`
    return { result: vsResult(primary.path, false, message), files: [], wrote: false, warnings }
  }
  if (env && !files.some((f) => f.exists) && !(await pathExists(dirname(primary.path)))) {
    const message = "VS Code isn't set up on this computer yet. Open VS Code once (and install the Claude Code extension), then try again."
    return { result: vsResult(primary.path, false, message), files: [], wrote: false, warnings }
  }
  const usable = files.filter((f) => {
    if (!f.error) return true
    warnings.push(`Skipped ${variantLabel(f.variant)}: its settings file has a syntax error (${f.error}).`)
    return false
  })
  const entries = env ? Object.entries(env).map(([name, value]) => ({ name, value })) : null
  const plans = usable.map((file) => ({ file, plan: planVsCodeEdit(file, entries, vscodeMarkerFor(marker, file.path)) }))
  const toWrite = plans.filter((p) => p.plan.edits.length)
  const untouched = plans.filter((p) => !p.plan.edits.length).map((p) => ({ path: p.file.path, marker: p.plan.marker }))
  if (!toWrite.length) return { result: vsResult(primary.path, true, opts.unchangedMessage), files: untouched, wrote: false, warnings }

  const saved = await backup(ctx, opts.reason, toWrite.map((p) => p.file.path), "VS Code's settings")
  if ('error' in saved) return { result: vsResult(primary.path, false, saved.error), files: [], wrote: false, warnings }

  const done = [...untouched]
  const written: string[] = []
  let primaryError: string | undefined
  for (const p of toWrite) {
    try {
      await editJsonc(await physicalPath(p.file.path), p.plan.edits)
      done.push({ path: p.file.path, marker: p.plan.marker })
      written.push(variantLabel(p.file.variant))
    } catch (err) {
      if (p.file === primary) primaryError = errorText(err)
      else warnings.push(`Couldn't update ${variantLabel(p.file.variant)} settings: ${errorText(err)}`)
    }
  }
  if (primaryError) {
    const message = `Couldn't save VS Code's settings (${primary.path}): ${primaryError}`
    return { result: vsResult(primary.path, false, message, saved.id), files: done, wrote: written.length > 0, warnings }
  }
  ctx.log.info('models', `Updated Claude Code extension settings in ${written.join(' and ')}`)
  const where = written.length > 1 ? ` Updated: ${written.join(' and ')}.` : ''
  return { result: vsResult(primary.path, true, `${opts.okMessage}${where}`, saved.id), files: done, wrote: true, warnings }
}

/** Replace the marker entries of the processed VS Code files. */
export function mergeVsMarkers(existing: WrittenFile[] | undefined, updates: Array<{ path: string; marker?: WrittenFile }>): WrittenFile[] {
  const out = (existing ?? []).filter((e) => !updates.some((u) => samePath(u.path, e.path)))
  for (const u of updates) {
    if (u.marker && (Object.keys(u.marker.env).length || Object.keys(u.marker.settings).length)) out.push(u.marker)
  }
  return out
}
