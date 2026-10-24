/**
 * One-click fixes offered by Doctor checks. Every fix backs up the files it changes and returns a friendly
 * OpResult instead of throwing.
 */
import { join } from 'node:path'
import type { OpResult, RuntimeName } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, pathExists, readJson, writeJsonAtomic } from '../fs/json'
import { physicalPath } from '../models/claudeSettings'
import { resolveAuthConflict, syncVsCodeWithClaudeCode } from '../models/repair'
import { inspectModels } from '../models/status'
import { run, which } from '../platform/exec'
import { currentOS, homeDir } from '../platform/paths'
import { resolveDesktopConfig } from '../targets/desktopPaths'
import { invalidDesktopEntries } from '../targets/validate'
import { errorText, type DoctorDeps } from './context'
import { gitLongPaths } from './checks/system'

const RUNTIME_IDS: readonly RuntimeName[] = ['node', 'npx', 'uv', 'uvx', 'python', 'docker', 'git', 'claude', 'code', 'winget', 'brew']

/** Ids of every fix the Doctor can run (besides install-runtime:<id>). */
export const FIX_IDS = [
  'remove-invalid-desktop-entries',
  'restart-desktop',
  'apply-model-vscode',
  'fix-auth-conflict',
  'start-proxy',
  'git-longpaths'
] as const

const BRIDGE_NOTE =
  'They are kept in the backup. To use a remote server in Claude Desktop, reinstall it from Discover — ' +
  'Claude Setup connects it through a bridge Desktop understands.'

async function installRuntime(deps: DoctorDeps, id: string): Promise<OpResult> {
  if (!RUNTIME_IDS.includes(id as RuntimeName)) return { ok: false, message: `Claude Setup doesn't know how to install "${id}".` }
  return deps.runtimes.install(id as RuntimeName)
}

async function removeInvalidDesktopEntries(ctx: CoreContext, deps: DoctorDeps): Promise<OpResult> {
  const info = (await deps.targets.list().catch(() => [])).find((t) => t.id === 'claude-desktop')
  const path = info?.configPath ?? (await resolveDesktopConfig()).configPath
  const r = await readJson<unknown>(path)
  if (!r.exists) return { ok: true, message: "Claude Desktop has no settings file yet, so there's nothing to fix." }
  if (r.error || !isPlainObject(r.data)) {
    const why = r.error ?? 'not a JSON object'
    return { ok: false, message: `Claude Desktop's settings file can't be read (${why}). Fix it or restore a backup first.` }
  }
  const servers = isPlainObject(r.data.mcpServers) ? r.data.mcpServers : {}
  const bad = invalidDesktopEntries(servers)
  if (!bad.length) return { ok: true, message: 'No broken server entries were found.' }

  let backupId: string
  try {
    backupId = (await ctx.backups.snapshot('Remove broken Claude Desktop server entries', [path])).id
  } catch (err) {
    return { ok: false, message: `Couldn't back up Claude Desktop's settings, so nothing was changed: ${errorText(err)}` }
  }
  const kept = Object.fromEntries(Object.entries(servers).filter(([name]) => !bad.includes(name)))
  await writeJsonAtomic(await physicalPath(path), { ...r.data, mcpServers: kept })
  ctx.log.info('doctor', `Removed invalid Claude Desktop entries: ${bad.join(', ')}`)
  ctx.events.emitEvent('state', { key: 'servers' })
  const running = info?.running === true
  const what = bad.length === 1 ? 'the broken entry' : `${bad.length} broken entries`
  const restart = running ? ' Restart Claude Desktop so it reloads its settings.' : ''
  return { ok: true, message: `Removed ${what} (${bad.join(', ')}).${restart}`, details: BRIDGE_NOTE, backupId, needsRestart: running }
}

async function applyModelToVsCode(ctx: CoreContext, deps: DoctorDeps): Promise<OpResult> {
  const m = await inspectModels(ctx, deps.proxy)
  if (m.settingsError) return { ok: false, message: `Claude Code's settings file can't be read (${m.settingsError}). Fix it first.` }
  if (m.mode !== 'anthropic' && m.profile) {
    const res = await deps.models.apply({ profileId: m.profile.id, targets: ['vscode'] })
    const r = res.results.find((x) => x.target === 'vscode')
    const ok = r?.ok ?? false
    return {
      ok,
      message: r?.message ?? res.warnings[0] ?? "VS Code couldn't be updated.",
      ...(res.warnings.length ? { details: res.warnings.join('\n') } : {}),
      ...(r?.backupId ? { backupId: r.backupId } : {})
    }
  }
  return syncVsCodeWithClaudeCode(ctx)
}

async function startProxy(deps: DoctorDeps): Promise<OpResult> {
  const status = await deps.proxy.start()
  if (status.running) {
    const where = status.url ? ` at ${status.url}` : status.port ? ` on port ${status.port}` : ''
    return { ok: true, message: `The translation proxy is running${where}.` }
  }
  return { ok: false, message: status.lastError ?? "The translation proxy couldn't start. Open the Proxy page for details." }
}

async function enableGitLongPaths(ctx: CoreContext): Promise<OpResult> {
  if (currentOS() !== 'win32') return { ok: true, message: 'Long paths only need turning on for Git on Windows.' }
  const git = await which('git')
  if (!git) return { ok: false, message: "Git isn't installed, so there's nothing to change." }
  if ((await gitLongPaths(git)) === 'true') return { ok: true, message: 'Long file paths are already on for Git.' }
  const home = homeDir()
  const candidates = [join(home, '.gitconfig')]
  const xdg = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config')
  if (await pathExists(xdg)) candidates.push(xdg)
  let backupId: string
  try {
    backupId = (await ctx.backups.snapshot('Turn on Git long paths', candidates)).id
  } catch (err) {
    return { ok: false, message: `Couldn't back up your Git settings, so nothing was changed: ${errorText(err)}` }
  }
  const r = await run(git, ['config', '--global', 'core.longpaths', 'true'], { cwd: home, timeoutMs: 15_000 })
  if (!r.ok) return { ok: false, message: `Git couldn't change the setting: ${r.stderr.trim() || r.error || 'unknown error'}`, backupId }
  ctx.log.info('doctor', 'Enabled git core.longpaths (global)')
  return { ok: true, message: 'Turned on long file paths for Git (core.longpaths = true).', backupId }
}

/** Run a Doctor fix by id. Never throws. */
export async function runFix(ctx: CoreContext, deps: DoctorDeps, fixId: string): Promise<OpResult> {
  const id = typeof fixId === 'string' ? fixId.trim() : ''
  try {
    if (id.startsWith('install-runtime:')) return await installRuntime(deps, id.slice('install-runtime:'.length))
    switch (id) {
      case 'remove-invalid-desktop-entries':
        return await removeInvalidDesktopEntries(ctx, deps)
      case 'restart-desktop':
        return await deps.targets.restartDesktop()
      case 'apply-model-vscode':
        return await applyModelToVsCode(ctx, deps)
      case 'fix-auth-conflict':
        return await resolveAuthConflict(ctx)
      case 'start-proxy':
        return await startProxy(deps)
      case 'git-longpaths':
        return await enableGitLongPaths(ctx)
      default:
        return { ok: false, message: `Unknown fix "${id || fixId}". Run the Doctor again to get the current fixes.` }
    }
  } catch (err) {
    ctx.log.error('doctor', `Fix ${id} failed: ${errorText(err)}`)
    return { ok: false, message: `The fix couldn't be applied: ${errorText(err)}` }
  }
}
