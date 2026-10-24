/**
 * Backups of every config file before Claude Setup changes it. CONTRACT (owned by FOUNDATION).
 * Layout: <backupsDir>/<id>/manifest.json + files/<n>.bak
 *   id = YYYYMMDD-HHmmss-<4 hex>; manifest = BackupEntry & { files[i].stored: "files/<n>.bak" }
 * A snapshot of a non-existent file records existed=false so restore deletes it.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { BackupsApi } from '@shared/api'
import type { BackupEntry, OpResult } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, writeJsonAtomic } from './json'

interface StoredFile {
  path: string
  existed: boolean
  size: number
  /** Relative path of the copy inside the backup folder (only for files that existed). */
  stored?: string
}

interface Manifest {
  version: 1
  id: string
  createdAt: string
  reason: string
  files: StoredFile[]
}

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/
const DEFAULT_KEEP = 30
/** Folders without a valid manifest (interrupted snapshots) are cleaned up after this long. */
const ORPHAN_AGE_MS = 60 * 60 * 1000

function errorMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  switch (e?.code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EBUSY':
      return 'the file is in use by another program'
    case 'ENOSPC':
      return 'the disk is full'
    case 'EROFS':
      return 'the disk is read-only'
    default:
      return e instanceof Error ? e.message : String(err)
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Local-time folder name, e.g. 20261023-213005-a1f3. */
function makeId(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}-${randomBytes(2).toString('hex')}`
}

function toEntry(m: Manifest): BackupEntry {
  const files = m.files.map((f) => ({ path: f.path, existed: f.existed, size: f.size }))
  return { id: m.id, createdAt: m.createdAt, reason: m.reason, files }
}

function parseManifest(id: string, data: unknown): Manifest | null {
  if (!isPlainObject(data) || typeof data.createdAt !== 'string' || !Array.isArray(data.files)) return null
  if (Number.isNaN(Date.parse(data.createdAt))) return null
  const files: StoredFile[] = []
  for (const raw of data.files) {
    if (!isPlainObject(raw) || typeof raw.path !== 'string' || typeof raw.existed !== 'boolean') return null
    const file: StoredFile = { path: raw.path, existed: raw.existed, size: typeof raw.size === 'number' ? raw.size : 0 }
    if (typeof raw.stored === 'string') {
      // Only files/<n>.bak inside this backup are acceptable (no path tricks).
      if (!/^files\/\d+\.bak$/.test(raw.stored)) return null
      file.stored = raw.stored
    }
    files.push(file)
  }
  // The folder name is authoritative: it is what restore()/delete() receive.
  return { version: 1, id, createdAt: data.createdAt, reason: typeof data.reason === 'string' ? data.reason : '', files }
}

/** De-duplicated absolute paths (case-insensitive on Windows). */
function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const foldCase = process.platform === 'win32'
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue
    const abs = resolve(p)
    const key = foldCase ? abs.toLowerCase() : abs
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** Where to write `path`: the target of a symlink (keeps dotfile links intact), else the path itself. */
async function writeTarget(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await realpath(path)
  } catch {
    // Missing or unreadable: write the path itself.
  }
  return path
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Windows: antivirus/indexers briefly lock freshly written files.
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

/** Atomically put the backup copy `source` back at `path`. */
async function restoreFile(source: string, path: string): Promise<void> {
  const target = await writeTarget(path)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.restore-${randomBytes(4).toString('hex')}`
  await copyFile(source, tmp)
  try {
    await renameWithRetry(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    // Last resort (e.g. the target is held open): overwrite in place.
    try {
      await copyFile(source, target)
    } catch {
      throw err
    }
  }
}

export class BackupManager {
  private queue: Promise<unknown> = Promise.resolve()
  private lastCreatedMs = 0

  constructor(
    readonly dir: string,
    readonly keep: () => number
  ) {}

  /**
   * Copy the given files (if they exist) into a new backup and prune old ones.
   * Missing files are recorded with existed=false. Throws a friendly Error if a file can't be
   * copied — callers must not modify the file in that case.
   */
  snapshot(reason: string, paths: string[]): Promise<BackupEntry> {
    return this.exclusive(async () => toEntry(await this.createSnapshot(reason, paths, new Set())))
  }

  /** Newest first. Damaged backups are skipped. */
  list(): Promise<BackupEntry[]> {
    return this.readAll().then((all) => all.map(toEntry))
  }

  /** Restore all files of a backup (takes a safety snapshot of current files first). */
  restore(id: string): Promise<OpResult> {
    return this.exclusive(() => this.restoreBackup(id))
  }

  /** Delete one backup. */
  delete(id: string): Promise<OpResult> {
    return this.exclusive(async () => {
      if (!ID_PATTERN.test(id)) return { ok: false, message: 'That backup was not found.' }
      const folder = join(this.dir, id)
      if (!(await stat(folder).catch(() => null))?.isDirectory()) return { ok: false, message: 'That backup was not found.' }
      try {
        await rm(folder, { recursive: true, force: true })
        return { ok: true, message: 'Backup deleted.' }
      } catch (err) {
        return { ok: false, message: 'Could not delete the backup.', details: errorMessage(err) }
      }
    })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn, fn)
    this.queue = job.catch(() => undefined)
    return job
  }

  /** Strictly increasing timestamps, so backups made within the same millisecond still sort correctly. */
  private nextTimestamp(): Date {
    const ms = Math.max(Date.now(), this.lastCreatedMs + 1)
    this.lastCreatedMs = ms
    return new Date(ms)
  }

  /** Create a new, unique backup folder (retries on the rare id collision, also across processes). */
  private async allocate(date: Date): Promise<{ id: string; folder: string }> {
    await mkdir(this.dir, { recursive: true })
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = makeId(date)
      const folder = join(this.dir, id)
      try {
        await mkdir(folder)
        return { id, folder }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new Error('Could not create a unique backup folder')
  }

  private async createSnapshot(reason: string, paths: string[], protect: Set<string>): Promise<Manifest> {
    const date = this.nextTimestamp()
    let allocated: { id: string; folder: string }
    try {
      allocated = await this.allocate(date)
    } catch (err) {
      throw new Error(`Could not create a backup in ${this.dir}: ${errorMessage(err)}`)
    }
    const { id, folder } = allocated
    const files: StoredFile[] = []
    let current = ''
    try {
      await mkdir(join(folder, 'files'))
      let n = 0
      for (const path of uniquePaths(paths)) {
        current = path
        const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
          throw err
        })
        if (!info) {
          files.push({ path, existed: false, size: 0 })
        } else if (!info.isFile()) {
          // Folders are not backed up; restore leaves them alone.
          files.push({ path, existed: true, size: 0 })
        } else {
          const stored = `files/${n++}.bak`
          await copyFile(path, join(folder, stored))
          files.push({ path, existed: true, size: info.size, stored })
        }
      }
      current = join(folder, 'manifest.json')
      const manifest: Manifest = { version: 1, id, createdAt: date.toISOString(), reason: String(reason ?? ''), files }
      await writeJsonAtomic(join(folder, 'manifest.json'), manifest)
    } catch (err) {
      await rm(folder, { recursive: true, force: true }).catch(() => {})
      throw new Error(`Could not back up ${current ? basename(current) : 'the files'}: ${errorMessage(err)}`)
    }
    await this.prune(new Set([...protect, id])).catch(() => {})
    return { version: 1, id, createdAt: date.toISOString(), reason: String(reason ?? ''), files }
  }

  private async readManifest(id: string): Promise<Manifest | null> {
    try {
      return parseManifest(id, JSON.parse(await readFile(join(this.dir, id, 'manifest.json'), 'utf8')))
    } catch {
      return null
    }
  }

  /** Every readable backup, newest first. */
  private async readAll(): Promise<Manifest[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => [])
    const manifests = await Promise.all(
      entries.filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => this.readManifest(e.name))
    )
    return manifests
      .filter((m): m is Manifest => m !== null)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
  }

  private keepCount(): number {
    try {
      const k = Number(this.keep())
      return Number.isFinite(k) ? Math.max(1, Math.floor(k)) : DEFAULT_KEEP
    } catch {
      return DEFAULT_KEEP
    }
  }

  /** Keep the newest keep() backups (never the protected ones) and clear interrupted snapshots. */
  private async prune(protect: Set<string>): Promise<void> {
    const all = await this.readAll()
    const valid = new Set(all.map((m) => m.id))
    for (const old of all.slice(this.keepCount())) {
      if (!protect.has(old.id)) await rm(join(this.dir, old.id), { recursive: true, force: true }).catch(() => {})
    }
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || !ID_PATTERN.test(e.name) || valid.has(e.name) || protect.has(e.name)) continue
      const folder = join(this.dir, e.name)
      const info = await stat(folder).catch(() => null)
      if (info && Date.now() - info.mtimeMs > ORPHAN_AGE_MS) await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async restoreBackup(id: string): Promise<OpResult> {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, message: 'That backup was not found.' }
    const manifest = await this.readManifest(id)
    if (!manifest) return { ok: false, message: 'That backup no longer exists or is damaged.' }
    const folder = join(this.dir, id)
    for (const f of manifest.files) {
      if (f.existed && f.stored && !(await stat(join(folder, f.stored)).catch(() => null))?.isFile()) {
        return { ok: false, message: 'This backup is incomplete, so nothing was restored.', details: `Missing copy of ${f.path}` }
      }
    }

    let safety: Manifest
    try {
      safety = await this.createSnapshot(`before restore ${id}`, manifest.files.map((f) => f.path), new Set([id]))
    } catch (err) {
      return {
        ok: false,
        message: "Couldn't save a safety copy of your current files, so nothing was restored.",
        details: errorMessage(err)
      }
    }

    const failures: string[] = []
    const skipped: string[] = []
    let restored = 0
    let removed = 0
    for (const f of manifest.files) {
      try {
        if (f.existed && f.stored) {
          await restoreFile(join(folder, f.stored), f.path)
          restored++
        } else if (!f.existed) {
          const info = await lstat(f.path).catch(() => null)
          if (info?.isDirectory()) skipped.push(`${f.path} (now a folder; left unchanged)`)
          else if (info) {
            await rm(f.path, { force: true })
            removed++
          }
        } else {
          skipped.push(`${f.path} (folder; not part of backups)`)
        }
      } catch (err) {
        failures.push(`${f.path}: ${errorMessage(err)}`)
      }
    }

    const when = new Date(manifest.createdAt).toLocaleString()
    const needsRestart = manifest.files.some((f) => basename(f.path).toLowerCase() === 'claude_desktop_config.json')
    const counts = [`${restored} file${restored === 1 ? '' : 's'} restored`, ...(removed ? [`${removed} removed`] : [])].join(', ')
    const notes = [...skipped, ...(failures.length ? ['', 'Problems:', ...failures] : [])]
    const safetyNote = `Your previous files were saved as backup ${safety.id}.`
    if (failures.length) {
      return {
        ok: false,
        message: `Some files could not be restored from the backup of ${when} (${counts}).`,
        details: [...notes, '', safetyNote].join('\n').trim(),
        backupId: safety.id,
        needsRestart
      }
    }
    return {
      ok: true,
      message: `Restored the backup of ${when} (${counts}).${needsRestart ? ' Restart Claude Desktop to use it.' : ''}`,
      details: [...notes, ...(notes.length ? [''] : []), safetyNote].join('\n'),
      backupId: safety.id,
      needsRestart
    }
  }
}

function apiError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** BackupsApi on top of ctx.backups (never throws; emits a 'state' event { key: 'backups' } on changes). */
export function createBackupsApi(ctx: CoreContext): BackupsApi {
  return {
    async list() {
      try {
        return await ctx.backups.list()
      } catch (err) {
        ctx.log.error('backups', `Listing backups failed: ${apiError(err)}`)
        return []
      }
    },
    async restore(id) {
      try {
        const result = await ctx.backups.restore(id)
        if (result.backupId) ctx.events.emitEvent('state', { key: 'backups' })
        if (result.ok) ctx.log.info('backups', `Restored backup ${id}`)
        else ctx.log.warn('backups', `Restore of backup ${id}: ${result.message}`)
        return result
      } catch (err) {
        ctx.log.error('backups', `Restore of backup ${id} failed: ${apiError(err)}`)
        return { ok: false, message: 'Could not restore the backup.', details: apiError(err) }
      }
    },
    async delete(id) {
      try {
        const result = await ctx.backups.delete(id)
        if (result.ok) {
          ctx.events.emitEvent('state', { key: 'backups' })
          ctx.log.info('backups', `Deleted backup ${id}`)
        }
        return result
      } catch (err) {
        ctx.log.error('backups', `Deleting backup ${id} failed: ${apiError(err)}`)
        return { ok: false, message: 'Could not delete the backup.', details: apiError(err) }
      }
    }
  }
}
