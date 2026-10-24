/**
 * Hooks and status lines, installed from JSON fragments on GitHub:
 *   hook        { description?, hooks: { "<Event>": [groups] }, supportingFiles? }  → merged into settings (identical handlers deduped)
 *   status line { description?, statusLine: { type: "command", command } }           → replaces settings.statusLine (previous kept)
 * Target file: ~/.claude/settings.json (user), .claude/settings.json (project), .claude/settings.local.json (local).
 * Settings are strict JSON; they are backed up before every change. Switching off parks the handlers in our registry.
 */
import { readFile, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import type { OpResult, Scope } from '@shared/types'
import { cloneJson, isPlainObject } from '../../fs/json'
import { downloadRepoFile, friendlyGitHubError, GitHubError, githubBlobUrl } from '../github'
import type { CatalogId } from '../ids'
import type { InstalledEntry } from '../installed'
import { settingsPathFor } from '../paths'
import type { RegistryRecord } from '../registry'
import { FriendlyError, readSettings, writeSettings } from '../settingsFile'
import {
  addHook,
  hasHook,
  hookCommands,
  mergeHooks,
  removeHooks,
  restoreStatusLine,
  setStatusLine,
  validateHooks,
  validateStatusLine,
  type HookRef,
  type HooksMap
} from '../settingsMerge'
import { runsCommandsWarning } from '../sources/aitmpl'
import type { CatalogItem, ExtEnv } from '../types'
import { clip, deepEqual, samePath, sha256 } from '../util'
import { backupFiles, failure, rememberProject, writeFileAtomic, type Target } from './common'
import {
  adaptForPlatform,
  missingToolWarnings,
  planScripts,
  rewriteForUserScope,
  unresolvedWarnings,
  userScriptBase,
  usesPython,
  windowsPython,
  type ScriptFile
} from './scripts'

const SCRIPT_MAX_FILES = 50
const SCRIPT_MAX_BYTES = 10 * 1024 * 1024

type SettingsKind = 'hook' | 'statusline'

function label(kind: SettingsKind): string {
  return kind === 'hook' ? 'hook' : 'status line'
}

/** "in your user settings" / "in the project's shared settings" / "in your personal settings for this project". */
export function settingsWhere(scope: Scope): string {
  if (scope === 'project') return "in the project's shared settings (.claude/settings.json)"
  if (scope === 'local') return 'in your personal settings for this project (.claude/settings.local.json)'
  return 'in your user settings (all projects)'
}

async function downloadFragment(id: CatalogId, what: string): Promise<Record<string, unknown>> {
  let buf: Buffer
  try {
    buf = await downloadRepoFile(id.owner, id.repo, id.path, { maxBytes: 1024 * 1024 })
  } catch (err) {
    throw new FriendlyError(friendlyGitHubError(err, `this ${what}`))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))
  } catch {
    throw new FriendlyError(`This ${what} file is not valid JSON, so it wasn't installed.`)
  }
  if (!isPlainObject(parsed)) throw new FriendlyError(`This ${what} file is not in the expected format, so it wasn't installed.`)
  return parsed
}

/** Delete script files we wrote, unless the user changed them or another install still uses them. Returns the kept ones. */
async function deleteOwnedFiles(env: ExtEnv, record: RegistryRecord): Promise<string[]> {
  const kept: string[] = []
  for (const f of record.files) {
    const buf = await readFile(f.path).catch(() => null)
    if (!buf) continue
    if (sha256(buf) !== f.sha256 || (await env.registry.fileSharedWith(f.path, record.key))) {
      kept.push(f.path)
      continue
    }
    await rm(f.path, { force: true }).catch(() => kept.push(f.path))
  }
  return kept
}

/** Install a hook or status line from a catalog id. */
export async function installSettingsItem(
  env: ExtEnv,
  id: CatalogId,
  target: Target,
  catalogId: string,
  meta?: CatalogItem
): Promise<OpResult> {
  const kind = id.kind as SettingsKind
  const what = label(kind)
  try {
    env.progress(`Downloading the ${what}…`, 10)
    const fragment = await downloadFragment(id, what)
    const settingsPath = settingsPathFor(target.scope, target.projectPath)
    const doc = await readSettings(settingsPath)
    const name = meta?.name ?? basename(id.path).replace(/\.json$/i, '')
    const description = meta?.description ?? (typeof fragment.description === 'string' ? clip(fragment.description, 400) : undefined)
    const notes: string[] = []

    let hooks: HooksMap = {}
    let statusLine: Record<string, unknown> | null = null
    if (kind === 'hook') {
      const v = validateHooks(fragment.hooks)
      hooks = v.hooks
      if (!Object.keys(hooks).length) throw new FriendlyError("This hook file doesn't contain any hooks Claude Code can use.", v.problems.join(' '))
      notes.push(...v.problems)
    } else {
      statusLine = validateStatusLine(fragment.statusLine)
      if (!statusLine) throw new FriendlyError("This status line file doesn't contain a command to run.")
    }
    const commands = kind === 'hook' ? hookCommands(hooks) : [String(statusLine?.command)]

    // Scripts the commands call.
    const plan = planScripts(fragment, commands, id.path, target)
    notes.push(...plan.warnings)
    if (plan.files.length > SCRIPT_MAX_FILES) throw new FriendlyError(`This ${what} needs too many extra files to install safely (${plan.files.length}).`)
    const scripts: Array<{ file: ScriptFile; data: Buffer }> = []
    const unresolved = [...plan.unresolved]
    let total = 0
    for (const file of plan.files) {
      env.progress(`Downloading ${basename(file.rel)}…`, 30)
      try {
        const data = await downloadRepoFile(id.owner, id.repo, file.repoPath, { maxBytes: 4 * 1024 * 1024 })
        total += data.length
        if (total > SCRIPT_MAX_BYTES) throw new FriendlyError(`The files this ${what} needs are too large to install safely.`)
        scripts.push({ file, data })
      } catch (err) {
        if (err instanceof FriendlyError) throw err
        if (err instanceof GitHubError && err.kind === 'not-found' && !file.required) {
          unresolved.push({ rel: file.rel, home: file.home })
          continue
        }
        throw new FriendlyError(friendlyGitHubError(err, `a script this ${what} needs`))
      }
    }
    const records = await env.registry.list()
    for (const { file, data } of scripts) {
      const existing = await readFile(file.dest).catch(() => null)
      if (existing && sha256(existing) !== sha256(data) && !records.some((r) => r.files.some((f) => samePath(f.path, file.dest)))) {
        throw new FriendlyError(
          `A different file already exists at ${file.dest}, so the ${what} wasn't installed.`,
          'Rename or remove that file first if you want to replace it.'
        )
      }
    }

    // Adapt commands: Windows python, and user-scope script locations.
    const rels = new Set(scripts.filter((s) => !s.file.home).map((s) => s.file.rel))
    const base = userScriptBase()
    const python = process.platform === 'win32' && usesPython(commands) ? ((await windowsPython()) ?? 'python') : 'python'
    const adapt = (cmd: string) => {
      let c = adaptForPlatform(cmd, process.platform, python)
      if (target.scope === 'user' && rels.size) c = rewriteForUserScope(c, base, rels)
      return c
    }
    for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) if (typeof h.command === 'string') h.command = adapt(h.command)
    if (statusLine) statusLine.command = adapt(String(statusLine.command))

    const scriptPaths = scripts.map((s) => s.file.dest)
    const recordBase = {
      id: catalogId,
      kind,
      name,
      source: id.source,
      scope: target.scope,
      projectPath: target.projectPath,
      path: settingsPath,
      files: scripts.map((s) => ({ path: s.file.dest, sha256: sha256(s.data) })),
      description,
      url: meta?.url ?? githubBlobUrl(id.owner, id.repo, id.path),
      repo: `${id.owner}/${id.repo}`,
      installedAt: new Date().toISOString()
    }
    const where = settingsWhere(target.scope)
    let message: string
    let replaced: RegistryRecord | undefined
    let recordExtra: Partial<RegistryRecord>

    if (kind === 'hook') {
      const previous = records.find((r) => r.kind === 'hook' && r.id === catalogId && samePath(r.path, settingsPath))
      if (previous && !previous.disabled) removeHooks(doc.data, previous.hooks ?? [])
      const added = mergeHooks(doc.data, hooks)
      if (!added.length && !previous) {
        return { ok: true, message: `The "${name}" hook is already set up ${where}.` }
      }
      replaced = previous
      recordExtra = { hooks: added, disabled: false }
      message = `${previous ? 'Updated' : 'Installed'} the "${name}" hook ${where}. It runs automatically in Claude Code from now on.`
    } else {
      const value = statusLine as Record<string, unknown>
      const active = records.find(
        (r) => r.kind === 'statusline' && samePath(r.path, settingsPath) && !r.disabled && !!r.statusLine && deepEqual(r.statusLine.value, doc.data.statusLine)
      )
      if (deepEqual(doc.data.statusLine, value)) {
        if (!active) await env.registry.add({ ...recordBase, statusLine: { value, hadPrevious: false } })
        return { ok: true, message: `The "${name}" status line is already set up ${where}.` }
      }
      let prev: { previous?: unknown; hadPrevious: boolean }
      if (active?.statusLine) {
        prev = { previous: cloneJson(active.statusLine.previous), hadPrevious: active.statusLine.hadPrevious }
        replaced = active
        setStatusLine(doc.data, value)
      } else prev = setStatusLine(doc.data, value)
      recordExtra = { statusLine: { value, previous: prev.previous, hadPrevious: prev.hadPrevious }, disabled: false }
      message = `Installed the "${name}" status line ${where}. It shows at the bottom of Claude Code from the next message on.`
      if (prev.hadPrevious) notes.push('Your previous status line is remembered and comes back if you remove this one.')
    }

    const replacedFiles = replaced && replaced.key ? replaced.files.map((f) => f.path).filter((p) => !scriptPaths.some((s) => samePath(s, p))) : []
    const backupId = await backupFiles(env, `Install ${what} ${name}`, [settingsPath, ...scriptPaths, ...replacedFiles])
    env.progress(`Saving the ${what}…`, 90)
    await writeSettings(settingsPath, doc.data)
    for (const { file, data } of scripts) await writeFileAtomic(file.dest, data, { executable: file.executable })
    if (replaced) {
      if (replacedFiles.length) await deleteOwnedFiles(env, { ...replaced, files: replaced.files.filter((f) => replacedFiles.includes(f.path)) })
      await env.registry.remove(replaced.key)
    }
    await env.registry.add({ ...recordBase, ...recordExtra })
    await rememberProject(env, target.projectPath)

    const warnings = [
      runsCommandsWarning(kind) as string,
      ...notes,
      ...(await unresolvedWarnings(unresolved, target)),
      ...(await missingToolWarnings(kind === 'hook' ? hookCommands(hooks) : [String(statusLine?.command)]))
    ]
    if (target.scope !== 'user') warnings.push('Claude Code runs project hooks and status lines only after you trust the project folder.')
    return { ok: true, message, details: warnings.join('\n'), backupId }
  } catch (err) {
    return failure(err, `The ${what} couldn't be installed.`)
  }
}

/** Remove a hook / status line (ours: exactly what we added, restoring the previous status line; otherwise the listed handler). */
export async function removeSettingsItem(env: ExtEnv, entry: InstalledEntry): Promise<OpResult> {
  const kind = entry.kind as SettingsKind
  const what = label(kind)
  try {
    const record = entry.record
    const doc = await readSettings(entry.path)
    let changed = false
    let message = `Removed the "${entry.item.name}" ${what}.`
    if (kind === 'hook') {
      const refs = record ? (record.disabled ? [] : (record.hooks ?? [])) : (entry.hooks ?? [])
      changed = removeHooks(doc.data, refs) > 0
    } else if (record?.statusLine && !record.disabled) {
      const outcome = restoreStatusLine(doc.data, record.statusLine.value, record.statusLine.previous, record.statusLine.hadPrevious)
      changed = outcome === 'restored' || outcome === 'removed'
      if (outcome === 'restored') message = `Removed the "${entry.item.name}" status line and put your previous one back.`
      if (outcome === 'changed') {
        message = `Your status line was changed after "${entry.item.name}" was installed, so the setting was left as it is. Its files were removed.`
      }
    } else if (!record && doc.data.statusLine !== undefined) {
      delete doc.data.statusLine
      changed = true
    }
    const files = record ? record.files.map((f) => f.path) : []
    const backupId = await backupFiles(env, `Remove ${what} ${entry.item.name}`, changed ? [entry.path, ...files] : files)
    if (changed) await writeSettings(entry.path, doc.data)
    const kept = record ? await deleteOwnedFiles(env, record) : []
    if (record) await env.registry.remove(record.key)
    return {
      ok: true,
      message,
      details: kept.length ? `Kept these files because they were changed or are used by something else:\n${kept.join('\n')}` : undefined,
      backupId
    }
  } catch (err) {
    return failure(err, `The ${what} couldn't be removed.`)
  }
}

/** Switch a hook / status line off (parked in the registry) or back on. */
export async function setSettingsItemEnabled(env: ExtEnv, entry: InstalledEntry, enabled: boolean): Promise<OpResult> {
  const kind = entry.kind as SettingsKind
  const what = label(kind)
  try {
    const doc = await readSettings(entry.path)
    const record = entry.record
    const already = { ok: true, message: `The "${entry.item.name}" ${what} is already ${enabled ? 'on' : 'off'}.` }
    if (kind === 'hook') {
      const refs: HookRef[] = record?.hooks ?? entry.hooks ?? []
      if (!enabled) {
        if (record?.disabled) return already
        const present = refs.filter((r) => hasHook(doc.data, r))
        if (!present.length) return already
        const backupId = await backupFiles(env, `Turn off ${what} ${entry.item.name}`, [entry.path])
        removeHooks(doc.data, present)
        await writeSettings(entry.path, doc.data)
        if (record) await env.registry.update(record.key, { disabled: true, hooks: present })
        else await env.registry.add(parkedRecord(entry, { hooks: present }))
        return { ok: true, message: `Turned off the "${entry.item.name}" hook. Turn it back on any time.`, backupId }
      }
      if (!record?.disabled) return already
      const backupId = await backupFiles(env, `Turn on ${what} ${entry.item.name}`, [entry.path])
      for (const ref of refs) addHook(doc.data, ref)
      await writeSettings(entry.path, doc.data)
      if (record.source === 'local') await env.registry.remove(record.key)
      else await env.registry.update(record.key, { disabled: false })
      return { ok: true, message: `Turned on the "${entry.item.name}" hook.`, backupId }
    }
    // Status line
    if (!enabled) {
      if (record?.disabled) return already
      const current = validateStatusLine(doc.data.statusLine)
      if (!current) return already
      const backupId = await backupFiles(env, `Turn off ${what} ${entry.item.name}`, [entry.path])
      delete doc.data.statusLine
      await writeSettings(entry.path, doc.data)
      if (record) await env.registry.update(record.key, { disabled: true })
      else await env.registry.add(parkedRecord(entry, { statusLine: { value: current, hadPrevious: false } }))
      return { ok: true, message: `Turned off the "${entry.item.name}" status line.`, backupId }
    }
    if (!record?.disabled || !record.statusLine) return already
    if (doc.data.statusLine !== undefined && !deepEqual(doc.data.statusLine, record.statusLine.value)) {
      return { ok: false, message: 'Another status line is active. Turn that one off first, then turn this one on.' }
    }
    const backupId = await backupFiles(env, `Turn on ${what} ${entry.item.name}`, [entry.path])
    doc.data.statusLine = cloneJson(record.statusLine.value)
    await writeSettings(entry.path, doc.data)
    if (record.source === 'local') await env.registry.remove(record.key)
    else await env.registry.update(record.key, { disabled: false })
    return { ok: true, message: `Turned on the "${entry.item.name}" status line.`, backupId }
  } catch (err) {
    return failure(err, `The ${what} couldn't be changed.`)
  }
}

/** Registry record that parks a hook / status line the user added themselves. */
function parkedRecord(entry: InstalledEntry, extra: Partial<RegistryRecord>): Omit<RegistryRecord, 'key'> {
  return {
    id: entry.item.id,
    kind: entry.kind,
    name: entry.item.name,
    source: 'local',
    scope: entry.scope,
    projectPath: entry.projectPath,
    path: entry.path,
    files: [],
    description: entry.item.description,
    disabled: true,
    installedAt: new Date().toISOString(),
    ...extra
  }
}
