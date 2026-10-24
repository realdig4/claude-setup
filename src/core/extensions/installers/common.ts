/** Helpers shared by the installers: scope checks, backups, safe file writes, recent projects. */
import { randomBytes } from 'node:crypto'
import { chmod, cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { OpResult, Scope } from '@shared/types'
import { FriendlyError } from '../settingsFile'
import type { ExtEnv } from '../types'
import { delay, errorMessage } from '../util'

/** Resolved install target. */
export interface Target {
  scope: Scope
  projectPath?: string
}

/** Validate scope + project folder. Throws FriendlyError when a project scope has no usable folder. */
export async function resolveTarget(opts: { scope?: Scope; projectPath?: string } | undefined): Promise<Target> {
  const scope: Scope = opts?.scope === 'project' || opts?.scope === 'local' ? opts.scope : 'user'
  if (scope === 'user') return { scope }
  const p = typeof opts?.projectPath === 'string' ? opts.projectPath.trim() : ''
  if (!p) throw new FriendlyError('Choose a project folder first.', 'Project and local installs need the folder of the project they belong to.')
  if (!isAbsolute(p)) throw new FriendlyError('The project folder must be a full path.', `"${p}" is not an absolute path.`)
  const s = await stat(p).catch(() => null)
  if (!s?.isDirectory()) throw new FriendlyError("That project folder doesn't exist.", `${p} was not found or is not a folder.`)
  return { scope, projectPath: resolve(p) }
}

/** Snapshot files before changing them. Throws FriendlyError when the backup fails (nothing is changed then). */
export async function backupFiles(env: ExtEnv, reason: string, paths: string[]): Promise<string | undefined> {
  const unique = [...new Set(paths.filter(Boolean).map((p) => resolve(p)))]
  if (!unique.length) return undefined
  try {
    const entry = await env.ctx.backups.snapshot(reason, unique)
    return entry?.id
  } catch (err) {
    throw new FriendlyError("Couldn't make a backup first, so nothing was changed.", errorMessage(err))
  }
}

/** Remember a project folder in settings.recentProjects (most recent first, max 20). */
export async function rememberProject(env: ExtEnv, projectPath: string | undefined): Promise<void> {
  if (!projectPath) return
  const current = env.ctx.state.settings().recentProjects ?? []
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  if (key(current[0] ?? '') === key(projectPath)) return
  try {
    await env.ctx.state.update((draft) => {
      const rest = (draft.settings.recentProjects ?? []).filter((p) => key(p) !== key(projectPath))
      draft.settings.recentProjects = [projectPath, ...rest].slice(0, 20)
    })
    env.ctx.events.emitEvent('state', { key: 'settings' })
  } catch {
    // Remembering the folder is a convenience; never fail the install over it.
  }
}

/** Write bytes atomically (temp file + rename), creating folders. */
export async function writeFileAtomic(path: string, data: Buffer | string, opts: { executable?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, data)
    await renameWithRetry(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  if (opts.executable && process.platform !== 'win32') await chmod(path, 0o755).catch(() => {})
}

/** rename() with short retries for Windows (antivirus / indexers briefly lock new files). */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await delay(80 * (attempt + 1))
        continue
      }
      throw err
    }
  }
}

/** Move a folder into place (rename, or copy + delete across drives / when rename keeps failing). */
export async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await renameWithRetry(from, to)
  } catch {
    await cp(from, to, { recursive: true, errorOnExist: false, force: true })
    await rm(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** True when every segment of a relative path can be stored on this OS. */
export function storableOnThisOS(relPath: string): boolean {
  return relPath.split('/').every((seg) => {
    if (!seg || seg.includes('\0')) return false
    if (process.platform !== 'win32') return true
    return !/[<>:"|?*\x00-\x1f]/.test(seg) && !WIN_RESERVED.test(seg) && !/[ .]$/.test(seg)
  })
}

/** Turn any thrown error into an OpResult (FriendlyError messages are shown as-is). */
export function failure(err: unknown, fallback: string): OpResult {
  if (err instanceof FriendlyError) return { ok: false, message: err.message, details: err.details }
  return { ok: false, message: fallback, details: errorMessage(err) }
}

/** Human list: "a", "a and b", "a, b and c". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}
